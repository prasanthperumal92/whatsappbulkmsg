import { ApiError } from '@/lib/api/errors';
import { withAudit } from '@/lib/api/route';
import { getWhatsAppProvider, WhatsAppApiError } from '@/lib/whatsapp/provider';
import { syncTemplates } from '@/lib/whatsapp/templates';

/** §5.6 Sync from Meta. */
export const POST = withAudit({ action: 'whatsapp.sync_templates', entity: 'template' }, async (_req, { tx, audit }) => {
  const provider = await getWhatsAppProvider(tx);
  if (!provider) throw new ApiError(409, 'not_connected', 'WhatsApp isn’t connected. Add your credentials in Settings → WhatsApp.');
  try {
    const result = await syncTemplates(tx, provider);
    audit({ channel: 'whatsapp', details: { ...result, provider: provider.kind } });
    return Response.json(result);
  } catch (err) {
    if (err instanceof WhatsAppApiError) throw new ApiError(502, 'sync_failed', `Meta refused the request: ${err.message}`);
    throw err;
  }
});
