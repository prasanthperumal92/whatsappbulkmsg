import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as contactsRoute from '@/app/api/contacts/route';
import { ContactStore } from '@/lib/contacts/store';
import { getDb, schema } from '@/lib/db';
import { addSuppression } from '@/lib/suppression/service';
import { resetClerk, signInAs } from '../support/clerk-mock';
import { runImport, undo } from '../support/imports';
import { resetDb } from '../support/reset';
import { request, routeArgs } from '../support/routes';

const db = getDb();
const { auditLog, contactImportChanges, teamAllowlist } = schema;
const ME = 'asha.member@example.com';
const PHONE = '+919876543210';

const add = (body: unknown) => contactsRoute.POST(request('/api/contacts', 'POST', { body }), routeArgs('/api/contacts'));
const store = () => new ContactStore(db);
const auditRows = () => db.select().from(auditLog).where(eq(auditLog.action, 'contact.create'));

async function refused(body: unknown, status: number, code: string) {
  const before = await store().revision();
  const res = await add(body);
  expect(res.status).toBe(status);
  expect((await res.json()).error.code).toBe(code);
  expect(await store().revision()).toBe(before);
}

beforeEach(async () => {
  await resetDb();
  resetClerk();
  await db.insert(teamAllowlist).values({ email: ME });
  signInAs(ME, 'user_asha');
});

describe('POST /api/contacts', () => {
  it('creates a contact, normalising every field, with one audit row and one revision bump', async () => {
    const before = await store().revision();
    const res = await add({ phone: '098765 43210', email: 'Asha@Example.com', first_name: ' Asha ', last_name: 'Rao', company: 'Grace', city: 'Salem', tags: 'Steel, EXPO,, steel' });
    expect(res.status).toBe(201);
    const { contact_id } = await res.json();

    const [row] = await store().getMany([contact_id]);
    expect(row).toMatchObject({
      phone_e164: PHONE, wa_to: '919876543210', email: 'asha@example.com', first_name: 'Asha', last_name: 'Rao', company: 'Grace', city: 'Salem',
      country_iso: 'IN', time_zone: 'Asia/Kolkata', language: 'en', tags: ['steel', 'expo'], opt_in_status: 'unknown', email_opt_in_status: 'unknown',
      opt_in_source: null, import_batch_id: null, created_by: 'user_asha', updated_by: 'user_asha',
    });
    expect(await store().revision()).toBe(before + 1);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity: 'contact', entityId: contact_id, userEmail: ME });
    expect(JSON.stringify(audits[0]!.detailsJson)).not.toContain('9876543210');
  });

  it('allows an email-only contact and a phone-only contact', async () => {
    const emailOnly = await (await add({ email: 'only@example.com' })).json();
    expect(emailOnly).toMatchObject({ phone_e164: null, email: 'only@example.com', country_iso: null });
    const phoneOnly = await (await add({ phone: PHONE })).json();
    expect(phoneOnly).toMatchObject({ phone_e164: PHONE, email: null });
  });

  it('reads a number without a country code as the country entered', async () => {
    const res = await add({ phone: '07400 123456', country: 'United Kingdom' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ phone_e164: '+447400123456', country_iso: 'GB', time_zone: 'Europe/London' });
  });

  it('records consent only when confirmed, per channel, and audits it', async () => {
    const res = await add({ phone: PHONE, email: 'a@example.com', whatsapp_consent_confirmed: true, consent_proof_ref: 'form-12' });
    const row = await res.json();
    expect(row).toMatchObject({ opt_in_status: 'opted_in', opt_in_source: 'manual', email_opt_in_status: 'unknown', email_opt_in_source: null, consent_proof_ref: 'form-12' });
    expect(row.opt_in_at).toBeTruthy();
    expect((await auditRows())[0]!.detailsJson).toMatchObject({ whatsapp_consent_confirmed: true, email_consent_confirmed: false });
  });

  it('never opts in a channel the contact has no identifier for', async () => {
    const row = await (await add({ email: 'a@example.com', whatsapp_consent_confirmed: true })).json();
    expect(row.opt_in_status).toBe('unknown');
    expect((await auditRows())[0]!.detailsJson).toMatchObject({ whatsapp_consent_confirmed: false });
  });

  it('a suppressed identifier is opted out even when consent is confirmed', async () => {
    await db.transaction(async (tx) => {
      await addSuppression(tx, { channel: 'whatsapp', identifier: PHONE, reason: 'manual' });
      await addSuppression(tx, { channel: 'email', identifier: 'gone@example.com', reason: 'manual' });
    });
    const row = await (await add({ phone: PHONE, email: 'gone@example.com', whatsapp_consent_confirmed: true, email_consent_confirmed: true })).json();
    expect(row).toMatchObject({ opt_in_status: 'opted_out', email_opt_in_status: 'opted_out' });
  });

  it('refuses unusable input and leaves nothing behind', async () => {
    await refused({}, 400, 'identifier_required');
    await refused({ first_name: 'Asha', phone: '   ', email: '' }, 400, 'identifier_required');
    await refused({ phone: '12345' }, 400, 'invalid_phone');
    await refused({ phone: '12345', email: 'ok@example.com' }, 400, 'invalid_phone');
    await refused({ phone: PHONE, email: 'not-an-email' }, 400, 'invalid_email');
    await refused({ phone: PHONE, country: 'Narnia' }, 400, 'invalid_country');
    expect(await store().count()).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('§4.7 refuses an identifier another contact holds, and writes nothing', async () => {
    await add({ phone: PHONE, email: 'shared@example.com' });
    await add({ email: 'only@example.com' });
    await refused({ phone: '+91 98765 43210' }, 409, 'contact_exists');
    await refused({ phone: PHONE, email: 'new@example.com' }, 409, 'contact_exists');
    await refused({ email: 'shared@example.com' }, 409, 'contact_exists');
    await refused({ email: 'ONLY@example.com' }, 409, 'contact_exists');
    await refused({ phone: '+919876543211', email: 'only@example.com' }, 409, 'contact_exists');
    expect(await store().count()).toBe(2);
  });

  it('§4.1 lets contacts with different phones share an address', async () => {
    await add({ phone: PHONE, email: 'shared@example.com' });
    expect((await add({ phone: '+919876543211', email: 'shared@example.com' })).status).toBe(201);
  });

  it('§4.7 ignores soft-deleted contacts', async () => {
    const first = await (await add({ phone: PHONE })).json();
    await db.update(schema.contacts).set({ isDeleted: true, deletedAt: new Date() }).where(eq(schema.contacts.contactId, first.contact_id));
    expect((await add({ phone: PHONE })).status).toBe(201);
  });

  it('§4.3 ends the ability to undo an earlier import', async () => {
    const { import_id } = await runImport('Phone,Name\n+919876543212,Asha\n');
    expect((await add({ phone: PHONE })).status).toBe(201);
    expect((await db.select().from(contactImportChanges))).toHaveLength(0);
    expect((await undo(import_id)).status).toBe(409);
  });
});
