import { ApiError } from '@/lib/api/errors';
import { withAudit } from '@/lib/api/route';
import { updateSettings } from '@/lib/settings/store';
import { getWhatsAppProvider, WhatsAppApiError } from '@/lib/whatsapp/provider';

/** §5.2 Test connection. Sends nothing. Also keeps the messaging limit current, which the send form checks against. */
export const POST = withAudit({ action: 'whatsapp.test_connection', entity: 'settings' }, async (_req, { tx, audit }) => {
  const provider = await getWhatsAppProvider(tx);
  if (!provider) throw new ApiError(409, 'not_connected', 'Add your access token, WhatsApp Business Account ID and phone number ID first.');
  try {
    const info = await provider.checkConnection();
    if (provider.kind === 'graph') await updateSettings(tx, { whatsappSending: { messagingLimitTier: info.messaging_limit } });
    audit({ channel: 'whatsapp', details: { provider: provider.kind, ok: true } });
    return Response.json({ ...info, provider: provider.kind });
  } catch (err) {
    if (err instanceof WhatsAppApiError) throw new ApiError(502, 'connection_failed', `Meta refused the connection: ${err.message}`);
    throw err;
  }
});
