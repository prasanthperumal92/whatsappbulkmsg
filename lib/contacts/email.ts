// §4.6. One function shared by browser and server.

export type EmailResult = { email: string | null; valid: boolean; warning?: 'INVALID_EMAIL' | null; role?: boolean };

const ROLE_LOCAL_PARTS = new Set([
  'abuse', 'admin', 'administrator', 'all', 'billing', 'careers', 'compliance', 'contact', 'customercare', 'customerservice', 'enquiries',
  'enquiry', 'everyone', 'feedback', 'finance', 'help', 'helpdesk', 'hello', 'hostmaster', 'hr', 'info', 'inquiries', 'inquiry', 'jobs',
  'legal', 'mail', 'mailer-daemon', 'marketing', 'media', 'newsletter', 'no-reply', 'noreply', 'do-not-reply', 'donotreply', 'office',
  'orders', 'postmaster', 'press', 'privacy', 'root', 'sales', 'security', 'service', 'spam', 'support', 'team', 'webmaster',
]);

const EDGES = /^[\p{Zs}\p{Cf}\s]+|[\p{Zs}\p{Cf}\s]+$/gu;
const LOCAL = /^[^\s@<>()[\]\\,;:"]+$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const invalid = (): EmailResult => ({ email: null, valid: false, warning: 'INVALID_EMAIL' });

/** Punycode via the WHATWG URL parser, which browsers and Node both provide. */
function toAsciiDomain(domain: string): string | null {
  if (/^[\x00-\x7f]*$/.test(domain)) return domain;
  try {
    return new URL(`http://${domain}/`).hostname;
  } catch {
    return null;
  }
}

export function normaliseEmail(raw: string | null | undefined): EmailResult {
  let value = (raw ?? '').replace(EDGES, '');
  if (!value) return { email: null, valid: true, warning: null };

  value = value.replace(/^mailto:/i, '').replace(EDGES, '');
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).replace(EDGES, '');
  value = value.toLowerCase();

  const parts = value.split('@');
  if (parts.length !== 2) return invalid(); // Also catches several addresses in one cell (G-21).
  const [local, rawDomain] = parts as [string, string];
  if (!local || local.length > 64 || !LOCAL.test(local)) return invalid();

  const domain = toAsciiDomain(rawDomain);
  if (!domain) return invalid();
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1)!)) return invalid();

  const email = `${local}@${domain}`;
  if (email.length > 254) return invalid();
  return ROLE_LOCAL_PARTS.has(local) ? { email, valid: true, role: true } : { email, valid: true };
}
