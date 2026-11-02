import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// SPEC §4.1 and §4.3. Changes must be expand-then-contract: see docs/migrations.md.

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const newId = () => uuidv7();

export const CHANNELS = ['whatsapp', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

export const contacts = pgTable(
  'contacts',
  {
    contactId: uuid('contact_id').primaryKey().$defaultFn(newId),
    phoneE164: varchar('phone_e164'),
    waTo: varchar('wa_to'),
    countryIso: varchar('country_iso'),
    timeZone: varchar('time_zone'),
    firstName: varchar('first_name'),
    lastName: varchar('last_name'),
    displayName: varchar('display_name'),
    email: varchar('email'),
    company: varchar('company'),
    city: varchar('city'),
    language: varchar('language').default('en'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    attributes: jsonb('attributes').notNull().default({}),
    optInStatus: varchar('opt_in_status').notNull().default('unknown'),
    optInSource: varchar('opt_in_source'),
    optInAt: tstz('opt_in_at'),
    emailOptInStatus: varchar('email_opt_in_status').notNull().default('unknown'),
    emailOptInSource: varchar('email_opt_in_source'),
    emailOptInAt: tstz('email_opt_in_at'),
    consentProofRef: varchar('consent_proof_ref'),
    importBatchId: varchar('import_batch_id'),
    createdBy: varchar('created_by'),
    updatedBy: varchar('updated_by'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    check('contacts_has_identifier', sql`${t.phoneE164} IS NOT NULL OR ${t.email} IS NOT NULL`),
    check('contacts_opt_in_status', sql`${t.optInStatus} IN ('opted_in', 'unknown', 'opted_out')`),
    check('contacts_email_opt_in_status', sql`${t.emailOptInStatus} IN ('opted_in', 'unknown', 'opted_out')`),
    // §4.1: WhatsApp consent is always unknown or opted_out when there is no phone.
    check('contacts_no_phone_no_opt_in', sql`${t.phoneE164} IS NOT NULL OR ${t.optInStatus} <> 'opted_in'`),
    uniqueIndex('contacts_phone_unique').on(t.phoneE164).where(sql`${t.isDeleted} = false AND ${t.phoneE164} IS NOT NULL`),
    uniqueIndex('contacts_email_only_unique')
      .on(t.email)
      .where(sql`${t.isDeleted} = false AND ${t.phoneE164} IS NULL AND ${t.email} IS NOT NULL`),
    index('contacts_tags_gin').using('gin', t.tags),
    index('contacts_first_name_trgm').using('gin', sql`${t.firstName} gin_trgm_ops`),
    index('contacts_last_name_trgm').using('gin', sql`${t.lastName} gin_trgm_ops`),
    index('contacts_display_name_trgm').using('gin', sql`${t.displayName} gin_trgm_ops`),
    index('contacts_phone_trgm').using('gin', sql`${t.phoneE164} gin_trgm_ops`),
    index('contacts_email_trgm').using('gin', sql`${t.email} gin_trgm_ops`),
  ],
);

export const contactRevision = pgTable(
  'contact_revision',
  {
    id: integer('id').primaryKey().default(1),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('contact_revision_singleton', sql`${t.id} = 1`)],
);

export const contactSnapshots = pgTable('contact_snapshots', {
  version: integer('version').primaryKey(),
  blobPath: varchar('blob_path').notNull(),
  rowCount: integer('row_count').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  reason: varchar('reason'),
  createdBy: varchar('created_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  deletedAt: tstz('deleted_at'),
});

export const importBatches = pgTable(
  'import_batches',
  {
    id: varchar('id').primaryKey().$defaultFn(newId),
    fileName: varchar('file_name').notNull(),
    fileSha256: varchar('file_sha256').notNull(),
    sourceBlobPath: varchar('source_blob_path'),
    mappingJson: jsonb('mapping_json'),
    optionsJson: jsonb('options_json'),
    totalsJson: jsonb('totals_json'),
    consentJson: jsonb('consent_json'),
    status: varchar('status').notNull().default('uploaded'),
    preRevision: bigint('pre_revision', { mode: 'number' }),
    postRevision: bigint('post_revision', { mode: 'number' }),
    createdBy: varchar('created_by'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('import_batches_status', sql`${t.status} IN ('uploaded', 'validated', 'committed', 'undone', 'failed')`),
    index('import_batches_sha').on(t.fileSha256),
  ],
);

export const contactImportChanges = pgTable(
  'contact_import_changes',
  {
    importBatchId: varchar('import_batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    // No foreign key to contacts: an erased contact is hard-deleted (§12A.3) and undo must tolerate that.
    contactId: uuid('contact_id').notNull(),
    operation: varchar('operation').notNull(),
    previousJson: jsonb('previous_json'),
  },
  (t) => [
    primaryKey({ columns: [t.importBatchId, t.contactId] }),
    check('contact_import_changes_operation', sql`${t.operation} IN ('insert', 'update')`),
  ],
);

export const contactErasures = pgTable('contact_erasures', {
  contactId: uuid('contact_id').primaryKey(),
  erasedAt: tstz('erased_at').notNull().defaultNow(),
  erasedBy: varchar('erased_by'),
});

export const mappingPresets = pgTable('mapping_presets', {
  id: varchar('id').primaryKey().$defaultFn(newId),
  name: varchar('name').notNull(),
  headerSignature: varchar('header_signature').notNull(),
  mappingJson: jsonb('mapping_json').notNull(),
  createdBy: varchar('created_by'),
});

export const templates = pgTable(
  'templates',
  {
    id: varchar('id').primaryKey().$defaultFn(newId),
    channel: varchar('channel').notNull().default('whatsapp'),
    name: varchar('name').notNull(),
    language: varchar('language').notNull().default('en'),
    category: varchar('category'),
    status: varchar('status').notNull().default('DRAFT'),
    metaTemplateId: varchar('meta_template_id'),
    parameterFormat: varchar('parameter_format'),
    componentsJson: jsonb('components_json'),
    emailJson: jsonb('email_json'),
    draftJson: jsonb('draft_json'),
    rejectedReason: text('rejected_reason'),
    qualityScore: varchar('quality_score'),
    lastEditedAt: tstz('last_edited_at'),
    createdBy: varchar('created_by'),
    lastSyncedAt: tstz('last_synced_at'),
  },
  (t) => [check('templates_channel', sql`${t.channel} IN ('whatsapp', 'email')`), index('templates_channel_status').on(t.channel, t.status)],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: varchar('id').primaryKey().$defaultFn(newId),
    channel: varchar('channel').notNull(),
    name: varchar('name').notNull(),
    templateId: varchar('template_id').references(() => templates.id, { onDelete: 'set null' }),
    templateSnapshotJson: jsonb('template_snapshot_json'),
    variableMappingJson: jsonb('variable_mapping_json'),
    status: varchar('status').notNull().default('draft'),
    workflowRunId: varchar('workflow_run_id'),
    runToken: varchar('run_token'),
    heartbeatAt: tstz('heartbeat_at'),
    waitUntil: tstz('wait_until'),
    waitReason: varchar('wait_reason'),
    pauseReason: varchar('pause_reason'),
    sendMediaId: varchar('send_media_id'),
    sendMediaUploadedAt: tstz('send_media_uploaded_at'),
    stageIndex: integer('stage_index').notNull().default(0),
    stageSent: integer('stage_sent').notNull().default(0),
    includeUnknown: boolean('include_unknown').notNull().default(false),
    includeUnknownAckBy: varchar('include_unknown_ack_by'),
    includeUnknownAckAt: tstz('include_unknown_ack_at'),
    total: integer('total').notNull().default(0),
    createdBy: varchar('created_by'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    scheduledAt: tstz('scheduled_at'),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    check('campaigns_channel', sql`${t.channel} IN ('whatsapp', 'email')`),
    check(
      'campaigns_status',
      sql`${t.status} IN ('draft', 'scheduled', 'queued', 'running', 'paused', 'completed', 'cancelled', 'failed')`,
    ),
    // One running campaign per channel (§8.7).
    uniqueIndex('campaigns_one_running_per_channel').on(t.channel).where(sql`${t.status} = 'running'`),
    index('campaigns_status').on(t.status),
  ],
);

export const campaignMessages = pgTable(
  'campaign_messages',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    campaignId: varchar('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    // No foreign key to contacts: stats outlive a hard-deleted contact (§12A.2, §12A.3).
    contactId: uuid('contact_id').notNull(),
    phoneE164: varchar('phone_e164'),
    paramsJson: jsonb('params_json'),
    status: varchar('status').notNull().default('pending'),
    claimToken: varchar('claim_token'),
    claimedAt: tstz('claimed_at'),
    timeZone: varchar('time_zone'),
    countryIso: varchar('country_iso'),
    wamid: varchar('wamid'),
    errorCode: varchar('error_code'),
    errorSubcode: varchar('error_subcode'),
    errorTitle: text('error_title'),
    errorDetail: text('error_detail'),
    fbtraceId: varchar('fbtrace_id'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at'),
    acceptedAt: tstz('accepted_at'),
    sentAt: tstz('sent_at'),
    deliveredAt: tstz('delivered_at'),
    readAt: tstz('read_at'),
    failedAt: tstz('failed_at'),
    priceCategory: varchar('price_category'),
    channel: varchar('channel').notNull(),
    emailTo: varchar('email_to'),
    resendId: varchar('resend_id'),
    batchKey: varchar('batch_key'),
    bounceType: varchar('bounce_type'),
    bounceSubtype: varchar('bounce_subtype'),
    openedAt: tstz('opened_at'),
    clickedAt: tstz('clicked_at'),
    complainedAt: tstz('complained_at'),
    unsubscribedAt: tstz('unsubscribed_at'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('campaign_messages_channel', sql`${t.channel} IN ('whatsapp', 'email')`),
    uniqueIndex('campaign_messages_campaign_contact').on(t.campaignId, t.contactId),
    uniqueIndex('campaign_messages_campaign_email').on(t.campaignId, t.emailTo).where(sql`${t.emailTo} IS NOT NULL`),
    index('campaign_messages_wamid').on(t.wamid),
    index('campaign_messages_resend_id').on(t.resendId),
    index('campaign_messages_campaign_status').on(t.campaignId, t.status),
    index('campaign_messages_campaign_status_zone').on(t.campaignId, t.status, t.timeZone),
    index('campaign_messages_channel_accepted').on(t.channel, t.acceptedAt),
  ],
);

export const contactActivity = pgTable('contact_activity', {
  contactId: uuid('contact_id').primaryKey(),
  lastMarketingAt: tstz('last_marketing_at'),
  lastCampaignId: varchar('last_campaign_id'),
  totalSent: integer('total_sent').notNull().default(0),
  lastEmailAt: tstz('last_email_at'),
  lastEmailCampaignId: varchar('last_email_campaign_id'),
  totalEmails: integer('total_emails').notNull().default(0),
});

export const suppressionList = pgTable(
  'suppression_list',
  {
    phoneE164: varchar('phone_e164').primaryKey(),
    reason: varchar('reason').notNull(),
    source: varchar('source'),
    createdBy: varchar('created_by'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [check('suppression_list_reason', sql`${t.reason} IN ('stop_keyword', 'button', 'manual', 'error_131050')`)],
);

export const emailSuppressionList = pgTable(
  'email_suppression_list',
  {
    email: varchar('email').primaryKey(),
    reason: varchar('reason').notNull(),
    source: varchar('source'),
    createdBy: varchar('created_by'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'email_suppression_list_reason',
      sql`${t.reason} IN ('unsubscribe_link', 'one_click', 'hard_bounce', 'complaint', 'resend_suppressed', 'manual')`,
    ),
  ],
);

export const whatsappIdentities = pgTable('whatsapp_identities', {
  bsuid: varchar('bsuid').primaryKey(),
  phoneE164: varchar('phone_e164'),
  suppressedAt: tstz('suppressed_at'),
  suppressionSource: varchar('suppression_source'),
  firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
});

export const emailLinkClicks = pgTable(
  'email_link_clicks',
  {
    campaignId: varchar('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    clicks: integer('clicks').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.url] })],
);

export const rateLimits = pgTable('rate_limits', {
  channel: varchar('channel').primaryKey(),
  nextSlotAt: tstz('next_slot_at'),
  rateFactor: numeric('rate_factor').notNull().default('1'),
  factorUntil: tstz('factor_until'),
});

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    source: varchar('source').notNull(),
    externalId: varchar('external_id').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    signatureOk: boolean('signature_ok').notNull(),
    payloadJson: jsonb('payload_json'),
    processedAt: tstz('processed_at'),
    error: text('error'),
  },
  (t) => [
    check('webhook_events_source', sql`${t.source} IN ('meta', 'resend')`),
    uniqueIndex('webhook_events_dedupe').on(t.source, t.externalId),
    index('webhook_events_received').on(t.receivedAt),
  ],
);

export const settings = pgTable('settings', {
  key: varchar('key').primaryKey(),
  valueJson: jsonb('value_json').notNull(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    at: tstz('at').notNull().defaultNow(),
    userId: varchar('user_id').notNull(),
    userEmail: varchar('user_email'),
    action: varchar('action').notNull(),
    entity: varchar('entity').notNull(),
    entityId: varchar('entity_id'),
    detailsJson: jsonb('details_json').notNull().default({}),
  },
  (t) => [
    index('audit_log_at').on(t.at.desc()),
    index('audit_log_user').on(t.userEmail, t.at.desc()),
    index('audit_log_action').on(t.action, t.at.desc()),
  ],
);

export const teamAllowlist = pgTable('team_allowlist', {
  email: varchar('email').primaryKey(),
  addedBy: varchar('added_by'),
  addedAt: tstz('added_at').notNull().defaultNow(),
});
