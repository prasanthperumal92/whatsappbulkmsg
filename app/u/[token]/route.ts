import { eq, sql } from 'drizzle-orm';
import { writeAudit } from '@/lib/api/route';
import { getDb, schema } from '@/lib/db';
import { unsubscribeSecrets, verifyToken } from '@/lib/email/unsubscribe';
import { getSettingsSection } from '@/lib/settings/store';
import { addSuppression } from '@/lib/suppression/service';

// §5.13: public, and identified by a signed token. It's a route rather than a page because a mail client's RFC 8058
// one-click POST arrives at this same URL. GET never unsubscribes, because link scanners open links.

const { campaignMessages, campaigns } = schema;
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;color:#1f2937;background:#fff;margin:0;padding:48px 16px}main{max-width:32rem;margin:0 auto}h1{font-size:22px;margin:0 0 12px}button{font:inherit;color:#fff;background:#111827;border:0;border-radius:6px;padding:10px 18px;cursor:pointer}button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}</style>
</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

const maskAddress = (address: string) => {
  const [local, domain] = address.split('@');
  return `${local!.slice(0, 1)}••••@${domain}`;
};

type Snapshot = { settings?: { from?: string; reply_to?: string | null } };
const businessOf = (from?: string) => from?.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? 'us';

const invalidPage = async () => {
  const { replyTo } = await getSettingsSection(getDb(), 'email');
  const contact = replyTo ? `email <a href="mailto:${escapeHtml(replyTo)}">${escapeHtml(replyTo)}</a>` : 'reply to the email you received';
  return page('This link isn’t valid', `<p>We couldn’t read this unsubscribe link. To stop receiving our emails, ${contact} and we’ll take you off the list.</p>`, 400);
};

const done = () => page('You’re unsubscribed', '<p>You’re unsubscribed. You won’t receive marketing emails from us any more.</p>');

async function resolve(token: string) {
  const { secret, previous } = unsubscribeSecrets();
  const result = secret ? verifyToken(token, secret, previous) : ({ valid: false } as const);
  if (!result.valid) return null;
  if (result.is_test) return { test: true as const };
  const [row] = await getDb()
    .select({ id: campaignMessages.id, email: campaignMessages.emailTo, campaignId: campaignMessages.campaignId, snapshot: campaigns.templateSnapshotJson })
    .from(campaignMessages)
    .innerJoin(campaigns, eq(campaignMessages.campaignId, campaigns.id))
    .where(sql`${campaignMessages.id}::text = ${result.message_id}`);
  return row?.email ? { test: false as const, ...row, email: row.email } : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const message = await resolve((await params).token);
  if (!message) return invalidPage();
  const who = message.test ? 'this test address' : escapeHtml(maskAddress(message.email));
  const from = message.test ? 'us' : escapeHtml(businessOf((message.snapshot as Snapshot | null)?.settings?.from));
  return page('Unsubscribe', `<p>Unsubscribe ${who} from marketing emails from ${from}?</p><form method="post"><button type="submit">Unsubscribe</button></form>`);
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const message = await resolve((await params).token);
  if (!message) return invalidPage();
  if (message.test) return done();

  const form = await req.text();
  const reason = form.includes('List-Unsubscribe=One-Click') ? 'one_click' : 'unsubscribe_link';
  await getDb().transaction(async (tx) => {
    // Only the first request changes anything, so repeating it writes no second audit row.
    const first = await tx
      .update(campaignMessages)
      .set({ unsubscribedAt: new Date(), updatedAt: new Date() })
      .where(sql`${campaignMessages.id} = ${message.id} AND ${campaignMessages.unsubscribedAt} IS NULL`)
      .returning({ id: campaignMessages.id });
    await addSuppression(tx, { channel: 'email', identifier: message.email, reason, source: message.campaignId, createdBy: 'system:unsubscribe' });
    if (first.length) await writeAudit(tx, { id: 'system:unsubscribe' }, 'email.unsubscribe', 'campaign_message', { entityId: message.id, channel: 'email', details: { reason } });
  });
  return done();
}
