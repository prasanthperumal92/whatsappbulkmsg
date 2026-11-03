import { z } from 'zod';
import { withAudit, withSession } from '@/lib/api/route';
import { ApiError, parseJson } from '@/lib/api/errors';
import { createContact } from '@/lib/contacts/create';
import { ContactStore } from '@/lib/contacts/store';

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

const listQuery = z.object({
  q: z.string().max(200).default(''),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(100),
});

export const GET = withSession(async (req, { db }) => {
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Invalid search or page');
  const { q, page, page_size } = parsed.data;
  return Response.json(await new ContactStore(db).listPage({ q, page, pageSize: page_size }));
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
