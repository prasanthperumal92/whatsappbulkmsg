import { sql } from 'drizzle-orm';
import { ApiError } from '@/lib/api/errors';
import type { Tx } from '@/lib/db';
import { STALE_SEND_MS } from '@/lib/email/send';
import { credentialSources } from '@/lib/settings/secrets';
import { getSettingsSection } from '@/lib/settings/store';

// §5.9 and §5.10. A row's status only records the furthest it has reached, so "delivered" also counts rows since opened
// or clicked. Timestamps cover rows whose status can't show it, such as a hard bounce after an open (ES-12).

export type CampaignCounts = {
  total: number;
  pending: number;
  unknown: number;
  skipped: number;
  failed: number;
  accepted: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  /** One part of a whole each, for the progress bar: these four always add up to `total`. */
  seg_delivered: number;
  seg_waiting: number;
  seg_problem: number;
  seg_skipped: number;
};

const COUNT_COLUMNS = sql`
  count(*)::int AS total,
  count(*) FILTER (WHERE status IN ('pending', 'claimed', 'retry_wait', 'sending'))::int AS pending,
  count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
  count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
  count(*) FILTER (WHERE status = 'failed')::int AS failed,
  count(*) FILTER (WHERE resend_id IS NOT NULL)::int AS accepted,
  count(*) FILTER (WHERE delivered_at IS NOT NULL OR status IN ('delivered', 'opened', 'clicked'))::int AS delivered,
  count(*) FILTER (WHERE opened_at IS NOT NULL OR status IN ('opened', 'clicked'))::int AS opened,
  count(*) FILTER (WHERE clicked_at IS NOT NULL OR status = 'clicked')::int AS clicked,
  count(*) FILTER (WHERE status = 'bounced' OR bounce_type = 'Permanent')::int AS bounced,
  count(*) FILTER (WHERE complained_at IS NOT NULL OR status = 'complained')::int AS complained,
  count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed,
  count(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked'))::int AS seg_delivered,
  count(*) FILTER (WHERE status NOT IN ('delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed', 'skipped'))::int AS seg_waiting,
  count(*) FILTER (WHERE status IN ('bounced', 'complained', 'failed'))::int AS seg_problem,
  count(*) FILTER (WHERE status = 'skipped')::int AS seg_skipped`;

const EMPTY_COUNTS = { total: 0, pending: 0, unknown: 0, skipped: 0, failed: 0, accepted: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, seg_delivered: 0, seg_waiting: 0, seg_problem: 0, seg_skipped: 0 } satisfies CampaignCounts;

/** A percentage, or null when there's nothing to divide by, so the page shows a dash and not a misleading 0%. */
export const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export type CampaignStatus = 'draft' | 'scheduled' | 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed' | 'interrupted';

type CampaignRow = { id: string; channel: string; name: string; status: string; heartbeat_at: Date | string | null; workflow_run_id: string | null; created_at: Date | string; finished_at: Date | string | null; pause_reason: string | null; created_by_email: string | null } & Partial<CampaignCounts>;

/** A direct send that stopped reporting has died with its function, even though its row still says `running`. */
export function displayStatus({ status, heartbeat_at, workflow_run_id }: Pick<CampaignRow, 'status' | 'heartbeat_at' | 'workflow_run_id'>, now = new Date()): CampaignStatus {
  if (status === 'running' && !workflow_run_id && heartbeat_at && now.getTime() - new Date(heartbeat_at).getTime() > STALE_SEND_MS) return 'interrupted';
  return status as CampaignStatus;
}

function toSummary(row: CampaignRow) {
  const counts = Object.fromEntries(Object.keys(EMPTY_COUNTS).map((k) => [k, row[k as keyof CampaignCounts] ?? 0])) as CampaignCounts;
  return {
    id: row.id,
    channel: row.channel,
    name: row.name,
    status: displayStatus(row),
    created_by_email: row.created_by_email,
    created_at: new Date(row.created_at).toISOString(),
    finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    stopped_reason: row.pause_reason,
    counts,
  };
}
export type CampaignSummary = ReturnType<typeof toSummary>;

const SELECT_CAMPAIGN = sql`
  SELECT c.id, c.channel, c.name, c.status, c.heartbeat_at, c.workflow_run_id, c.created_at, c.finished_at, c.pause_reason, c.template_snapshot_json, a.user_email AS created_by_email, s.*
  FROM campaigns c
  LEFT JOIN LATERAL (SELECT ${COUNT_COLUMNS} FROM campaign_messages m WHERE m.campaign_id = c.id) s ON true
  LEFT JOIN LATERAL (SELECT user_email FROM audit_log WHERE entity_id = c.id AND action = 'email.send' ORDER BY at LIMIT 1) a ON true`;

export async function listCampaigns(db: Tx, { channel, page, pageSize }: { channel?: string; page: number; pageSize: number }) {
  const { rows: counted } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM campaigns ${channel ? sql`WHERE channel = ${channel}` : sql``}`);
  const { rows } = await db.execute<CampaignRow>(sql`${SELECT_CAMPAIGN} ${channel ? sql`WHERE c.channel = ${channel}` : sql``} ORDER BY c.created_at DESC, c.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  return { items: rows.map(toSummary), total: counted[0]!.n };
}

type Snapshot = { template?: { blocks?: { type: string; text?: string }[] }; settings?: { from?: string; reply_to?: string | null } };

export async function getCampaign(db: Tx, id: string) {
  const { rows } = await db.execute<CampaignRow & { template_snapshot_json: Snapshot | null }>(sql`${SELECT_CAMPAIGN} WHERE c.id = ${id}`);
  const row = rows[0];
  if (!row) throw new ApiError(404, 'not_found', 'This campaign no longer exists.');
  const { rows: links } = await db.execute<{ url: string; clicks: number }>(sql`SELECT url, clicks FROM email_link_clicks WHERE campaign_id = ${id} ORDER BY clicks DESC, url LIMIT 20`);
  const [sources, sending] = [await credentialSources(db), await getSettingsSection(db, 'emailSending')];
  const snapshot = row.template_snapshot_json;
  return {
    ...toSummary(row),
    from: snapshot?.settings?.from ?? null,
    reply_to: snapshot?.settings?.reply_to ?? null,
    message: (snapshot?.template?.blocks ?? []).flatMap((b) => (b.text ? [b.text] : [])).join('\n\n'),
    top_links: links,
    thresholds: { bounce: sending.bounceRatePercent, complaint: sending.complaintRatePercent },
    webhook_connected: sources.RESEND_WEBHOOK_SECRET !== 'none',
  };
}
export type CampaignDetail = Awaited<ReturnType<typeof getCampaign>>;

export const MESSAGE_FILTERS = ['all', 'problems', 'delivered', 'waiting', 'skipped', 'unknown'] as const;
export type MessageFilter = (typeof MESSAGE_FILTERS)[number];

const FILTER_SQL: Record<MessageFilter, ReturnType<typeof sql>> = {
  all: sql`true`,
  problems: sql`m.status IN ('failed', 'bounced', 'complained')`,
  delivered: sql`m.status IN ('delivered', 'opened', 'clicked')`,
  waiting: sql`m.status IN ('pending', 'claimed', 'retry_wait', 'sending', 'accepted', 'sent', 'delayed')`,
  skipped: sql`m.status = 'skipped'`,
  unknown: sql`m.status = 'unknown'`,
};

export type CampaignMessage = {
  id: string;
  email_to: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string;
  error_code: string | null;
  error_detail: string | null;
  bounce_type: string | null;
  bounce_subtype: string | null;
  attempts: number;
  unsubscribed: boolean;
  updated_at: string;
};

const SELECT_MESSAGE = sql`
  SELECT m.id, m.email_to, c.first_name, c.last_name, m.status, m.error_code, m.error_detail, m.bounce_type, m.bounce_subtype, m.attempts,
         m.unsubscribed_at IS NOT NULL AS unsubscribed, m.updated_at
  FROM campaign_messages m LEFT JOIN contacts c ON c.contact_id = m.contact_id`;

const toMessage = (row: Record<string, unknown>) => ({ ...row, updated_at: new Date(row.updated_at as string).toISOString() }) as CampaignMessage;

export async function listCampaignMessages(db: Tx, id: string, { filter, page, pageSize }: { filter: MessageFilter; page: number; pageSize: number }) {
  const where = sql`m.campaign_id = ${id} AND ${FILTER_SQL[filter]}`;
  const { rows: counted } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM campaign_messages m WHERE ${where}`);
  const { rows } = await db.execute(sql`${SELECT_MESSAGE} WHERE ${where} ORDER BY m.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  return { items: rows.map(toMessage), total: counted[0]!.n };
}

export async function listCampaignFailures(db: Tx, id: string) {
  const { rows } = await db.execute(sql`${SELECT_MESSAGE} WHERE m.campaign_id = ${id} AND ${FILTER_SQL.problems} ORDER BY m.id`);
  return rows.map(toMessage);
}
