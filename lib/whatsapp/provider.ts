import { randomUUID } from 'node:crypto';
import type { Tx } from '@/lib/db';
import { getEnvironment } from '@/lib/env';
import { credentialSources, getSecret } from '@/lib/settings/secrets';
import { getSettingsSection } from '@/lib/settings/store';
import { channelModes } from '@/lib/status';
import { classifyError, type ErrorRule, type GraphError } from './errors';
import type { SendPayload } from './payload';
import type { MetaTemplate } from './template-shape';

// §7.1.3 and §7.2: the Graph API, or Mock on local dev and previews (D16). The token only ever travels in the
// Authorization header, so it can't end up in a URL, a log line or an error message.

const GRAPH_HOST = 'graph.facebook.com';
const TIMEOUT_MS = 20_000;
const MAX_TEMPLATE_PAGES = 50;

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly graph: GraphError | null,
    /** Set when no response came back. It ends in `_BEFORE_REQUEST_SENT` only if the request can't have reached Meta. */
    readonly networkError: string | null = null,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }

  get rule(): ErrorRule {
    return classifyError({ code: this.graph?.code, http_status: this.status ?? undefined, network_error: this.networkError ?? undefined });
  }
}

export type ConnectionInfo = {
  display_phone_number: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  messaging_limit: string | null;
};

export type WhatsAppProvider = {
  kind: 'graph' | 'mock';
  checkConnection(): Promise<ConnectionInfo>;
  listTemplates(): Promise<MetaTemplate[]>;
  sendTemplate(body: SendPayload): Promise<{ wamid: string }>;
};

export type GraphConfig = { token: string; wabaId: string; phoneNumberId: string; version: string; sendEndpoint: '/messages' | '/marketing_messages' };

const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

function networkFailure(err: unknown): WhatsAppApiError {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code && NOT_SENT_CODES.has(code)) return new WhatsAppApiError('Meta couldn’t be reached.', null, null, `${code}_BEFORE_REQUEST_SENT`);
  const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
  return new WhatsAppApiError(timedOut ? 'Meta took too long to answer.' : 'The connection to Meta failed.', null, null, timedOut ? 'TIMEOUT' : (code ?? 'NETWORK_ERROR'));
}

async function graphFetch<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw networkFailure(err);
  }
  const body = (await res.json().catch(() => null)) as { error?: GraphError } | null;
  if (!res.ok || body?.error) {
    const graph = body?.error ?? null;
    throw new WhatsAppApiError(graph?.error_data?.details ?? graph?.message ?? `Meta answered with status ${res.status}.`, res.status, graph);
  }
  return body as T;
}

export function createGraphProvider({ token, wabaId, phoneNumberId, version, sendEndpoint }: GraphConfig): WhatsAppProvider {
  const base = `https://${GRAPH_HOST}/${version}`;
  return {
    kind: 'graph',
    async checkConnection() {
      const fields = 'display_phone_number,verified_name,quality_rating,whatsapp_business_manager_messaging_limit';
      const phone = await graphFetch<Record<string, unknown>>(`${base}/${encodeURIComponent(phoneNumberId)}?fields=${fields}`, token);
      // §5.2: the WABA ID is only used for templates, so a wrong one would otherwise stay hidden until the first sync.
      await graphFetch(`${base}/${encodeURIComponent(wabaId)}/message_templates?limit=1`, token);
      const text = (key: string) => (typeof phone[key] === 'string' ? (phone[key] as string) : null);
      return { display_phone_number: text('display_phone_number'), verified_name: text('verified_name'), quality_rating: text('quality_rating'), messaging_limit: text('whatsapp_business_manager_messaging_limit') };
    },
    async listTemplates() {
      const fields = 'id,name,status,category,language,parameter_format,components,quality_score,rejected_reason';
      const templates: MetaTemplate[] = [];
      let url: string | undefined = `${base}/${encodeURIComponent(wabaId)}/message_templates?fields=${fields}&limit=100`;
      for (let page = 0; url && page < MAX_TEMPLATE_PAGES; page++) {
        const result: { data?: MetaTemplate[]; paging?: { next?: string } } = await graphFetch(url, token);
        templates.push(...(result.data ?? []));
        const next: string | undefined = result.paging?.next;
        // The token goes wherever this URL points, so it has to stay on Meta's own host.
        url = next && new URL(next).hostname === GRAPH_HOST ? next : undefined;
      }
      return templates;
    },
    async sendTemplate(body) {
      const result = await graphFetch<{ messages?: { id?: string }[] }>(`${base}/${encodeURIComponent(phoneNumberId)}${sendEndpoint}`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const wamid = result.messages?.[0]?.id;
      // Meta took it but gave no id, so the only honest status is unknown (§8.3).
      if (!wamid) throw new WhatsAppApiError('Meta didn’t return a message id.', null, null, 'NO_MESSAGE_ID');
      return { wamid };
    },
  };
}

const latency = () => new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 250));

const MOCK_TEMPLATES: MetaTemplate[] = [
  { id: 'mock_hello_world', name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hello from Bulk Messenger. This is a test message.' }] },
  {
    id: 'mock_festive_offer',
    name: 'festive_offer',
    status: 'APPROVED',
    category: 'MARKETING',
    language: 'en',
    parameter_format: 'NAMED',
    components: [
      { type: 'BODY', text: 'Hi {{first_name}}, our festive offer is live! Get {{discount}} off all orders placed this week.' },
      { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }] },
    ],
  },
];

/** Sends nothing. */
export function createMockProvider(): WhatsAppProvider {
  return {
    kind: 'mock',
    async checkConnection() {
      await latency();
      return { display_phone_number: '+91 00000 00000', verified_name: 'Mock sender', quality_rating: 'GREEN', messaging_limit: 'TIER_250' };
    },
    async listTemplates() {
      await latency();
      return MOCK_TEMPLATES;
    },
    async sendTemplate() {
      await latency();
      return { wamid: `wamid.mock.${randomUUID()}` };
    },
  };
}

/** Null when WhatsApp isn't connected. Follows the same rules as the banners, so the two can't disagree (§3.5). */
export async function getWhatsAppProvider(db: Tx, env: Record<string, string | undefined> = process.env): Promise<WhatsAppProvider | null> {
  const sources = await credentialSources(db, env);
  const whatsapp = await getSettingsSection(db, 'whatsapp');
  const email = await getSettingsSection(db, 'email');
  const mode = channelModes({ environment: getEnvironment(env), sources, localProvider: { whatsapp: whatsapp.provider, email: email.provider } }).whatsapp;
  if (mode === 'not_connected') return null;
  if (mode === 'mock') return createMockProvider();
  const token = await getSecret(db, 'WHATSAPP_ACCESS_TOKEN', env);
  const wabaId = await getSecret(db, 'WHATSAPP_WABA_ID', env);
  const phoneNumberId = await getSecret(db, 'WHATSAPP_PHONE_NUMBER_ID', env);
  const sending = await getSettingsSection(db, 'whatsappSending');
  return createGraphProvider({ token: token!, wabaId: wabaId!, phoneNumberId: phoneNumberId!, version: whatsapp.graphApiVersion, sendEndpoint: sending.sendEndpoint });
}
