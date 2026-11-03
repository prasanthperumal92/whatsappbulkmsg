import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, parseJson } from '@/lib/api/errors';
import { withAudit } from '@/lib/api/route';
import { normalisePhone } from '@/lib/contacts/phone';
import { getSettingsSection } from '@/lib/settings/store';
import { buildSendPayload } from '@/lib/whatsapp/payload';
import { variableMapping } from '@/lib/whatsapp/preview';
import { getWhatsAppProvider, WhatsAppApiError } from '@/lib/whatsapp/provider';
import { loadSendableTemplate } from '@/lib/whatsapp/templates';

const SAMPLE = { first_name: 'Asha', last_name: 'Rao', display_name: 'Asha Rao', company: 'Example Exports', city: 'Kochi', email: 'asha@example.com' };
const body = z.object({ template_id: z.string().max(100), mapping: variableMapping.default({}), to: z.string().trim().min(1, 'Enter a test number').max(40) });

/** FR-CMP-03: one message to one number, with sample values. No campaign row, so no contact's history changes. */
export const POST = withAudit({ action: 'whatsapp.test', entity: 'campaign' }, async (req, { tx, audit }) => {
  const input = await parseJson(req, body);
  const provider = await getWhatsAppProvider(tx);
  if (!provider) throw new ApiError(409, 'not_connected', 'WhatsApp isn’t connected. Add your credentials in Settings → WhatsApp.');
  const { defaultCountry } = await getSettingsSection(tx, 'import');
  const phone = normalisePhone(input.to, { defaultCountry });
  if (!('wa_to' in phone)) throw new ApiError(400, 'invalid_phone', 'Enter the test number with its country code, such as +91 98765 43210.');

  const { shape } = await loadSendableTemplate(tx, input.template_id);
  const built = buildSendPayload(shape.payload, input.mapping, { ...SAMPLE, wa_to: phone.wa_to }, randomUUID());
  if (!('body' in built)) throw new ApiError(409, 'empty_variable', 'Fill in every variable before sending a test.');
  try {
    await provider.sendTemplate(built.body);
  } catch (err) {
    if (err instanceof WhatsAppApiError) throw new ApiError(502, 'send_failed', `Meta refused the test message: ${err.message}`);
    throw err;
  }
  audit({ channel: 'whatsapp', details: { template: shape.payload.name, provider: provider.kind } });
  return Response.json({ to: phone.phone_e164, provider: provider.kind });
});
