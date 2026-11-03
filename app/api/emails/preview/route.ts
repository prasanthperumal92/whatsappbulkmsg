import { parseJson } from '@/lib/api/errors';
import { withAudit } from '@/lib/api/route';
import { audienceRequest, prepareSend, toPreview } from '@/lib/email/preview';

export const POST = withAudit({ action: 'email.preview', entity: 'contact' }, async (req, { tx, audit }) => {
  const preview = toPreview(await prepareSend(tx, await parseJson(req, audienceRequest), req.url));
  audit({ channel: 'email', details: { selected: preview.selected, recipients: preview.recipients } });
  return Response.json(preview);
});
