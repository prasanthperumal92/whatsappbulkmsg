import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const signIn = (context: BrowserContext, baseURL: string) => context.addCookies([{ name: 'fake_clerk_email', value: 'member@example.com', url: baseURL }]);
const csvFile = (name: string, content: string | Buffer) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });
const fileInput = (page: Page) => page.getByLabel('CSV file');
const next = (page: Page) => page.getByRole('button', { name: 'Next: Map columns' });
const unique = () => Date.now().toString().slice(-8);

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('E2E-02 a 30 MB file: preview appears before the upload finishes, and the upload completes', async ({ page }) => {
  test.setTimeout(180_000);
  // Long rows, so 30 MB stays under the 200,000-row limit.
  const line = `9876543210,Asha,steel,${'x'.repeat(200)}\n`;
  const body = 'Mobile No,Name,Segment,Notes\n' + line.repeat(Math.ceil((30 * 1024 * 1024) / line.length));
  // Slow the upload down so the order is observable. A local upload has no 4.5 MB limit to hit: that part needs a deployment.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/imports/local-upload**', async (route) => {
    await held;
    await route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/import');
  await fileInput(page).setInputFiles(csvFile('big.csv', body));
  const preview = page.getByTestId('file-preview');
  await expect(preview).toContainText('Mobile No');
  await expect(preview).toContainText('Asha');
  await expect(next(page)).toBeDisabled();
  release();
  await expect(next(page)).toBeEnabled({ timeout: 150_000 });
  await expect(page.getByTestId('upload-status')).toContainText(/\d[\d,]+ rows/);
  expect(errors).toEqual([]);
});

test('E2E-03 Next is disabled until Phone or Email is mapped', async ({ page }) => {
  await page.goto('/import');
  await fileInput(page).setInputFiles(csvFile('mystery.csv', `Foo,Bar\n98${unique()},x\n`));
  await expect(next(page)).toBeEnabled({ timeout: 30_000 });
  await next(page).click();

  const validate = page.getByRole('button', { name: 'Next: Validate' });
  await expect(validate).toBeDisabled();
  await page.getByLabel('Map Foo to').selectOption('email');
  await expect(validate).toBeEnabled();
  await page.getByLabel('Map Foo to').selectOption('');
  await expect(validate).toBeDisabled();
  await page.getByLabel('Map Foo to').selectOption('phone');
  await expect(validate).toBeEnabled();
});

test('E2E-04 a saved preset is applied to a re-upload with the same headers', async ({ page }) => {
  const id = unique();
  const headers = `Zed${id},Yak${id}`;
  await page.goto('/import');
  await fileInput(page).setInputFiles(csvFile('first.csv', `${headers}\n9876543210,Asha\n`));
  await expect(next(page)).toBeEnabled({ timeout: 30_000 });
  await next(page).click();
  await page.getByLabel(`Map Zed${id} to`).selectOption('phone');
  await page.getByLabel(`Map Yak${id} to`).selectOption('city');
  await page.getByLabel('Preset name').fill(`Preset ${id}`);
  await page.getByRole('button', { name: 'Save preset' }).click();
  await expect(page.getByLabel('Preset', { exact: true })).toHaveValue(/.+/);

  await page.goto('/import');
  await fileInput(page).setInputFiles(csvFile('second.csv', `${headers}\n9812345678,Ravi\n`));
  await expect(next(page)).toBeEnabled({ timeout: 30_000 });
  await next(page).click();
  await expect(page.getByLabel(`Map Zed${id} to`)).toHaveValue('phone');
  await expect(page.getByLabel(`Map Yak${id} to`)).toHaveValue('city');
  await expect(page.getByLabel('Preset', { exact: true }).locator('option:checked')).toHaveText(`Preset ${id}`);
});

test('a whole import: highlights, summary, consent, rejects, result, undo, and the activity log', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/import');
  await fileInput(page).setInputFiles({ name: 'email-only.csv', mimeType: 'text/csv', buffer: readFileSync('evals/fixtures/email-only.csv') });
  await expect(next(page)).toBeEnabled({ timeout: 30_000 });
  await page.screenshot({ path: 'test-results/import-step1.png', fullPage: true });
  await next(page).click();

  // Amber: a bad phone with a usable email. Red: nothing usable.
  const grid = page.getByRole('table', { name: 'Column mapping' });
  await expect(grid.locator('[data-cell-state="warn"]').filter({ hasText: '9.19876E+11' })).toBeVisible();
  await expect(grid.locator('[data-cell-state="warn"]').filter({ hasText: 'not-an-email' }).first()).toBeVisible();
  await expect(grid.locator('[data-cell-state="error"]').filter({ hasText: '12345' })).toBeVisible();
  await page.screenshot({ path: 'test-results/import-step2.png', fullPage: true });

  await page.getByLabel('WhatsApp opt-in').selectOption('opted_in');
  await page.getByRole('button', { name: 'Next: Validate' }).click();

  const table = page.getByRole('table', { name: 'Validation summary' });
  await expect(table.getByRole('row', { name: /Total rows/ })).toContainText('8');
  await expect(table.getByRole('row', { name: /Email-only/ })).toContainText('2 had an unusable phone');
  await page.screenshot({ path: 'test-results/import-step3.png', fullPage: true });

  const importButton = page.getByRole('button', { name: /^Import \d+ contacts$/ });
  await expect(importButton).toBeDisabled();
  await page.getByRole('checkbox', { name: /WhatsApp marketing messages/ }).check();
  await expect(importButton).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: /marketing emails/ })).toHaveCount(0);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download rejected rows' }).click();
  expect((await download).suggestedFilename()).toBe('rejects.csv');

  await importButton.click();
  await expect(page.getByTestId('import-result')).toContainText('added', { timeout: 30_000 });
  await page.screenshot({ path: 'test-results/import-step4.png', fullPage: true });

  await page.getByRole('button', { name: 'Undo this import' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByRole('heading', { name: 'Import undone' })).toBeVisible();

  await page.goto('/activity');
  await expect(page.getByRole('row').filter({ hasText: 'Contacts imported' }).first()).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Import undone' }).first()).toBeVisible();
  expect(errors.filter((e) => !/download|ERR_ABORTED/.test(e))).toEqual([]);
});

test('a file with too many columns gets the limit message', async ({ page }) => {
  await page.goto('/import');
  await fileInput(page).setInputFiles({ name: 'wide.csv', mimeType: 'text/csv', buffer: readFileSync('evals/fixtures/too-many-columns.csv') });
  await expect(page.getByRole('alert').filter({ hasText: '200 columns' })).toBeVisible({ timeout: 30_000 });
  await expect(next(page)).toBeDisabled();
});

test('a file imported twice warns about the duplicate', async ({ page }) => {
  const content = `phone,name\n${'98765' + unique().slice(-5)},Dup\n`;
  await page.goto('/import');
  await fileInput(page).setInputFiles(csvFile('dup.csv', content));
  await expect(next(page)).toBeEnabled({ timeout: 30_000 });
  await next(page).click();
  await page.getByRole('button', { name: 'Next: Validate' }).click();
  await page.getByRole('button', { name: /^Import \d+ contacts$/ }).click();
  await expect(page.getByTestId('import-result')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Import another file' }).click();
  await fileInput(page).setInputFiles(csvFile('dup.csv', content));
  await expect(page.getByText(/This file was already imported on .* by member@example.com/)).toBeVisible({ timeout: 30_000 });
});

test('S-01 Import settings save and reach the wizard', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('Default country (ISO code)').fill('GB');
  const card = page.getByRole('heading', { name: 'Import', exact: true }).locator('xpath=ancestor::*[@data-slot="card"]');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByText('Saved', { exact: true })).toBeVisible();

  await page.goto('/import');
  await fileInput(page).setInputFiles(csvFile('country.csv', `phone\n+447400${unique().slice(-6)}\n`));
  await expect(next(page)).toBeEnabled({ timeout: 30_000 });
  await next(page).click();
  await expect(page.getByLabel('Default country for this file')).toHaveValue('GB');

  await page.goto('/settings');
  await page.getByLabel('Default country (ISO code)').fill('IN');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByText('Saved', { exact: true })).toBeVisible();
});
