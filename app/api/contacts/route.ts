import { z } from 'zod';
import { withAudit } from '@/lib/api/route';
import { parseJson } from '@/lib/api/errors';
import { createContact } from '@/lib/contacts/create';

const text = z.string().trim().max(200).optional();
const body = z.object({
  phone: text,
  email: text,
  first_name: text,
  last_name: text,
  company: text,
  city: text,
  country: text,
  tags: z.string().trim().max(1000).optional(),
  consent_proof_ref: text,
  whatsapp_consent_confirmed: z.boolean().optional(),
  email_consent_confirmed: z.boolean().optional(),
});

export const POST = withAudit({ action: 'contact.create', entity: 'contact' }, async (req, { user, tx, audit }) => {
  const contact = await createContact(tx, await parseJson(req, body), user);
  // §12: the audit row is the record of who confirmed consent, and when.
  audit({
    entityId: contact.contact_id,
    details: {
      whatsapp_consent_confirmed: contact.opt_in_status === 'opted_in',
      email_consent_confirmed: contact.email_opt_in_status === 'opted_in',
    },
  });
  return Response.json(contact, { status: 201 });
});
