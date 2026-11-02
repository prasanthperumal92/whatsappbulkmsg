import { expect, test, type BrowserContext } from '@playwright/test';

const SIDEBAR = ['Contacts', 'Import', 'Templates', 'Campaigns', 'Activity', 'Settings'];
const signIn = (context: BrowserContext, baseURL: string, email: string) =>
  context.addCookies([{ name: 'fake_clerk_email', value: email, url: baseURL }]);

test('signed out: pages go to sign-in, APIs return 401, and there is no sign-up page', async ({ page, request, baseURL }) => {
  await page.goto('/contacts');
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await request.get('/api/team')).status()).toBe(401);
  expect((await request.get(`${baseURL}/api/cron/ping`)).status()).toBe(401);
  await page.goto('/sign-up');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('signed in but not on the allowlist: refused', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, 'stranger@example.com');
  await page.goto('/contacts');
  await expect(page).toHaveURL(/\/not-allowed/);
  await expect(page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
  expect((await context.request.get('/api/team')).status()).toBe(403);
});

test('T1.6 every sidebar route renders, with the Mock banners', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, 'member@example.com');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/');
  await expect(page).toHaveURL(/\/contacts/);
  expect(await page.locator('body').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/geist/i);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link')).toHaveText(SIDEBAR);

  for (const name of SIDEBAR) {
    await nav.getByRole('link', { name }).click();
    await expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('[data-banner="whatsapp-mock"]')).toContainText('Mock mode');
    await expect(page.locator('[data-banner="email-mock"]')).toContainText('Email mock mode');
  }
  await nav.getByRole('link', { name: 'Contacts' }).click();
  await expect(page.getByText('No contacts yet')).toBeVisible();
  await nav.getByRole('link', { name: 'Templates' }).click();
  await page.getByRole('tab', { name: 'Email' }).click();
  await expect(page.getByText('No email templates yet')).toBeVisible();
  expect(errors).toEqual([]);
});

test('team changes appear in the activity log, and filters work', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!, 'member@example.com');
  await page.goto('/settings');
  await page.screenshot({ path: 'test-results/settings.png', fullPage: true });

  const members = page.getByRole('list', { name: 'Team members' });
  await page.getByLabel('Email to add').fill('Ravi@Example.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(members.getByText('ravi@example.com')).toBeVisible();

  await page.getByLabel('Email to add').fill('ravi@example.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('ravi@example.com is already on the team')).toBeVisible();

  await members.getByRole('listitem').filter({ hasText: 'ravi@example.com' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(members.getByText('ravi@example.com')).toHaveCount(0);

  await page.goto('/activity');
  const rows = page.getByRole('row');
  await expect(rows.filter({ hasText: 'Team member added' })).toContainText('ravi@example.com');
  await expect(rows.filter({ hasText: 'Team member removed' })).toContainText('member@example.com');
  await page.screenshot({ path: 'test-results/activity.png', fullPage: true });

  await page.getByLabel('Action').click();
  await page.getByRole('option', { name: 'Team member removed' }).click();
  await expect(rows.filter({ hasText: 'Team member added' })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Team member removed' })).toHaveCount(1);

  await page.getByLabel('Action').click();
  await page.getByRole('option', { name: 'All actions' }).click();
  await page.getByLabel('Channel').click();
  await page.getByRole('option', { name: 'Email' }).click();
  await expect(page.getByText('No activity matches these filters.')).toBeVisible();
});
