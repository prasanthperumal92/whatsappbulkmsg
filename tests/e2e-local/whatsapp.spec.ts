import { createHmac } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';

const signIn = (context: BrowserContext, baseURL: string) => context.addCookies([{ name: 'fake_clerk_email', value: 'member@example.com', url: baseURL }]);
const APP_SECRET = 'e2e-meta-app-secret-1234567890';

test('credentials in Settings, syncing templates, and sending a WhatsApp message through Mock', async ({ page, context, baseURL, request }) => {
  test.setTimeout(90_000);
  await signIn(context, baseURL!);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Settings: the key goes in, and never comes back out.
  await page.goto('/settings');
  const card = page.getByRole('heading', { name: 'WhatsApp', exact: true }).locator('xpath=ancestor::*[@data-slot="card"]');
  await page.getByLabel('Access token').fill('EAAG-e2e-token-that-must-not-come-back');
  await page.getByLabel('Access token').locator('xpath=ancestor::form').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('Access token')).toHaveValue('');
  await expect(card.getByText('Saved in Settings').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('EAAG-e2e-token');
  await card.getByRole('button', { name: 'Test connection' }).click();
  await expect(card.getByText('Connected to Mock')).toBeVisible();
  await page.screenshot({ path: 'test-results/whatsapp-settings.png', fullPage: true });

  const hook = page.getByRole('heading', { name: 'WhatsApp webhook' }).locator('xpath=ancestor::*[@data-slot="card"]');
  await expect(hook.getByRole('textbox', { name: 'Callback URL' })).toHaveValue(`${baseURL}/api/webhooks/whatsapp`);
  await page.getByLabel('App Secret').fill(APP_SECRET);
  await page.getByLabel('App Secret').locator('xpath=ancestor::form').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('App Secret')).toHaveValue('');
  const token = await hook.getByRole('textbox', { name: 'Verify token' }).inputValue();
  const handshake = await request.get(`/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=e2e-challenge`);
  expect(await handshake.text()).toBe('e2e-challenge');

  // Templates.
  await page.goto('/templates');
  await page.getByRole('button', { name: 'Sync from Meta' }).click();
  await expect(page.getByRole('cell', { name: 'festive_offer' })).toBeVisible();
  await page.screenshot({ path: 'test-results/whatsapp-templates.png', fullPage: true });

  // Contacts: three people, one with unknown consent.
  for (const [first_name, phone, whatsapp_consent_confirmed] of [['Anjali', '+919876500010', true], ['Rohan', '+919876500011', true], ['Divya', '+919876500012', false]] as const) {
    expect((await context.request.post('/api/contacts', { data: { first_name, phone, whatsapp_consent_confirmed } })).status()).toBe(201);
  }
  await page.goto('/contacts');
  for (const name of ['Anjali', 'Rohan', 'Divya']) await page.getByRole('checkbox', { name: `Select ${name}` }).click();
  await page.getByRole('button', { name: 'WhatsApp selected' }).click();
  await expect(page.getByRole('button', { name: /^Send to/ })).toBeDisabled();
  await page.getByLabel('Template', { exact: true }).selectOption({ label: 'festive_offer (en, marketing)' });

  // A variable with nothing in it leaves everyone out, until it has a value.
  await expect(page.getByText('2 left out: a variable has no value for them')).toBeVisible();
  await page.getByLabel('Text for {{discount}}').fill('15%');
  await expect(page.getByText('2 people will get this message')).toBeVisible();
  await expect(page.getByText('1 left out: consent unknown')).toBeVisible();
  await expect(page.getByText(/Hi (Anjali|Rohan), our festive offer is live! Get 15% off/)).toBeVisible();
  await page.screenshot({ path: 'test-results/whatsapp-compose.png', fullPage: true });

  await page.getByLabel('Test number').fill('+91 98765 43210');
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText('Test simulated for +919876543210')).toBeVisible();

  await page.getByRole('button', { name: 'Send to 2 people' }).click();
  await expect(page.getByText('Sent to 2 contacts.')).toBeVisible({ timeout: 15_000 });

  // The monitor, updated by a signed event from Meta.
  await page.getByRole('link', { name: 'View campaign' }).click();
  await expect(page.getByRole('heading', { name: 'festive_offer', level: 1 })).toBeVisible();
  await expect(page.getByText('Accepted by Meta')).toBeVisible();
  await expect(page.getByRole('cell', { name: '+919876500010' })).toBeVisible();
  const campaignId = page.url().split('/').pop()!;
  const { items } = await (await context.request.get(`/api/campaigns/${campaignId}/messages`)).json();
  const anjali = items.find((m: { phone_e164: string }) => m.phone_e164 === '+919876500010');
  const payload = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.e2e', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: anjali.id }] } }] }] });
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`;
  expect((await request.post('/api/webhooks/whatsapp', { data: payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } })).status()).toBe(200);
  await expect(page.getByRole('row', { name: /\+919876500010/ }).getByRole('cell', { name: 'Read' })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: 'test-results/whatsapp-monitor.png', fullPage: true });

  // A STOP reply takes them out of the next send.
  const stop = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ type: 'text', from: '919876500011', text: { body: 'STOP' } }] } }] }] });
  await request.post('/api/webhooks/whatsapp', { data: stop, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(stop).digest('hex')}` } });
  await page.goto('/contacts');
  await expect(page.getByRole('row', { name: /Rohan/ }).getByText('Opted out').first()).toBeVisible();
  expect(errors).toEqual([]);
});
