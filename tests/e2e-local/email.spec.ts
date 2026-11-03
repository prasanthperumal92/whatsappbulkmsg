import { expect, test, type BrowserContext } from '@playwright/test';
import { Webhook } from 'svix';

const signIn = (context: BrowserContext, baseURL: string) => context.addCookies([{ name: 'fake_clerk_email', value: 'member@example.com', url: baseURL }]);

test('settings, multi-select and sending an email through Mock', async ({ page, context, baseURL, request }) => {
  test.setTimeout(60_000);
  await signIn(context, baseURL!);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Settings: sender, then the signature and address.
  await page.goto('/settings');
  await page.getByLabel('From name').fill('Grace Ferro Exports');
  await page.getByLabel('From address').fill('offers@mail.example.com');
  await page.getByRole('heading', { name: 'Email', exact: true }).locator('xpath=ancestor::*[@data-slot="card"]').getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  await page.getByLabel('Signature').fill('Regards,\nAsha Rao');
  await page.getByLabel('Business address').fill('12 Harbour Road\nKochi 682001');
  const card = page.getByRole('heading', { name: 'Signature and address' }).locator('xpath=ancestor::*[@data-slot="card"]');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved');
  await page.screenshot({ path: 'test-results/email-settings.png', fullPage: true });
  await page.reload();
  await expect(page.getByLabel('Signature')).toHaveValue('Regards,\nAsha Rao');

  // Contacts: three people, two with consent.
  for (const [first_name, email, email_consent_confirmed] of [['Asha', 'asha@example.com', true], ['Ravi', 'ravi@example.com', true], ['Meena', 'meena@example.com', false]] as const) {
    expect((await context.request.post('/api/contacts', { data: { first_name, email, email_consent_confirmed } })).status()).toBe(201);
  }
  await page.goto('/contacts');
  await page.getByRole('checkbox', { name: 'Select Meena' }).click();
  await page.getByRole('checkbox', { name: 'Select Asha' }).click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 selected')).toBeVisible();

  // One has unknown consent, so it's left out.
  await page.getByRole('button', { name: 'Email selected' }).click();
  await expect(page.getByText('2 people will get this email')).toBeVisible();
  await expect(page.getByText('1 left out: consent unknown')).toBeVisible();
  await page.getByLabel('Subject').fill('Hello {{first_name}}');
  await page.getByLabel('Message').fill('Our festive offer is live.');

  await page.screenshot({ path: 'test-results/email-compose.png', fullPage: true });
  await page.getByRole('button', { name: 'Send test to me' }).click();
  await expect(page.getByText('Test simulated for member@example.com')).toBeVisible();

  await page.getByRole('button', { name: 'Send to 2 people' }).click();
  await expect(page.getByText('Sent to 2 contacts.')).toBeVisible();
  await expect(page.getByText('selected', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Asha/ }).getByText('Never')).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Meena/ }).getByText('Never')).toBeVisible();
  await page.screenshot({ path: 'test-results/email-sent.png', fullPage: true });

  // The campaign list and its monitor.
  await page.getByRole('link', { name: 'View campaign' }).click();
  await expect(page.getByRole('heading', { name: 'Hello {{first_name}}', level: 1 })).toBeVisible();
  await expect(page.getByText('Accepted by Resend')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'asha@example.com' })).toBeVisible();

  // Resend reports back: a signed event, with no session, reaches the campaign page.
  const secret = `whsec_${Buffer.from('e2e-signing-secret-of-enough-length').toString('base64')}`;
  expect((await context.request.put('/api/settings/credentials', { data: { RESEND_WEBHOOK_SECRET: secret } })).status()).toBe(200);
  const campaignId = page.url().split('/').pop()!;
  const { items } = await (await context.request.get(`/api/campaigns/${campaignId}/messages`)).json();
  const asha = items.find((m: { email_to: string }) => m.email_to === 'asha@example.com');
  const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 'e2e-email', tags: { message_id: asha.id } } });
  const now = new Date();
  const posted = await request.post('/api/webhooks/resend', {
    data: body,
    headers: { 'content-type': 'application/json', 'svix-id': 'msg_e2e', 'svix-timestamp': String(Math.floor(now.getTime() / 1000)), 'svix-signature': new Webhook(secret).sign('msg_e2e', now, body) },
  });
  expect(posted.status()).toBe(200);
  await expect(page.getByRole('row', { name: /asha@example.com/ }).getByRole('cell', { name: 'Delivered' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Delivered: 1')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: 'test-results/campaign-monitor.png', fullPage: true });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Campaigns' }).click();
  await expect(page.getByRole('link', { name: 'Hello {{first_name}}' })).toBeVisible();
  await page.screenshot({ path: 'test-results/campaign-list.png', fullPage: true });

  // The webhook link, ready to paste into Resend.
  await page.goto('/settings');
  await expect(page.getByRole('textbox', { name: 'Webhook link' })).toHaveValue(`${baseURL}/api/webhooks/resend`);
  await expect(page.getByText('Resend can’t reach this computer')).toBeVisible();
  await expect(page.getByText('Last event received')).toContainText('email.delivered');
  await page.screenshot({ path: 'test-results/webhook-card.png', fullPage: true });
  expect(errors).toEqual([]);
});
