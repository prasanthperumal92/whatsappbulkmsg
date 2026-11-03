import { parseJson } from '@/lib/api/errors';
import { withAudit } from '@/lib/api/route';
import { prepareWhatsAppSend, toWhatsAppPreview, whatsappRequest } from '@/lib/whatsapp/preview';

/** §5.8 step 1. Audited because it reports on the selected contacts. */
export const POST = withAudit({ action: 'whatsapp.preview', entity: 'campaign' }, async (req, { tx, audit }) => {
  const input = await parseJson(req, whatsappRequest);
  const prepared = await prepareWhatsAppSend(tx, input);
  audit({ channel: 'whatsapp', details: { selected: prepared.plan.selected, recipients: prepared.plan.recipients.length } });
  return Response.json(toWhatsAppPreview(prepared));
});
