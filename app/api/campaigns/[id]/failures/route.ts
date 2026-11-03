import { withAudit } from '@/lib/api/route';
import { getCampaign, listCampaignFailures } from '@/lib/campaigns/stats';
import { toCsv } from '@/lib/csv-export';

/** §5.9 S-08. Audited, because the file holds people's addresses. */
export const GET = withAudit({ action: 'campaign.export_failures', entity: 'campaign_export' }, async (_req, { tx, params, audit }) => {
  const id = params.id as string;
  await getCampaign(tx, id);
  const rows = await listCampaignFailures(tx, id);
  audit({ entityId: id, channel: 'email', details: { rows: rows.length } });
  const csv = toCsv(
    ['Address', 'Name', 'Status', 'Bounce type', 'Bounce sub-type', 'Error code', 'Error', 'Attempts'],
    rows.map((m) => [m.email_to, [m.first_name, m.last_name].filter(Boolean).join(' '), m.status, m.bounce_type, m.bounce_subtype, m.error_code, m.error_detail, m.attempts]),
  );
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="campaign-failures.csv"', 'cache-control': 'no-store' } });
});
