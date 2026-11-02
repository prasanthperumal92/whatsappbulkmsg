CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" varchar NOT NULL,
	"user_email" varchar,
	"action" varchar NOT NULL,
	"entity" varchar NOT NULL,
	"entity_id" varchar,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" varchar NOT NULL,
	"contact_id" uuid NOT NULL,
	"phone_e164" varchar,
	"params_json" jsonb,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"claim_token" varchar,
	"claimed_at" timestamp with time zone,
	"time_zone" varchar,
	"country_iso" varchar,
	"wamid" varchar,
	"error_code" varchar,
	"error_subcode" varchar,
	"error_title" text,
	"error_detail" text,
	"fbtrace_id" varchar,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"price_category" varchar,
	"channel" varchar NOT NULL,
	"email_to" varchar,
	"resend_id" varchar,
	"batch_key" varchar,
	"bounce_type" varchar,
	"bounce_subtype" varchar,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"complained_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_messages_channel" CHECK ("campaign_messages"."channel" IN ('whatsapp', 'email'))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" varchar PRIMARY KEY NOT NULL,
	"channel" varchar NOT NULL,
	"name" varchar NOT NULL,
	"template_id" varchar,
	"template_snapshot_json" jsonb,
	"variable_mapping_json" jsonb,
	"status" varchar DEFAULT 'draft' NOT NULL,
	"workflow_run_id" varchar,
	"run_token" varchar,
	"heartbeat_at" timestamp with time zone,
	"wait_until" timestamp with time zone,
	"wait_reason" varchar,
	"pause_reason" varchar,
	"send_media_id" varchar,
	"send_media_uploaded_at" timestamp with time zone,
	"stage_index" integer DEFAULT 0 NOT NULL,
	"stage_sent" integer DEFAULT 0 NOT NULL,
	"include_unknown" boolean DEFAULT false NOT NULL,
	"include_unknown_ack_by" varchar,
	"include_unknown_ack_at" timestamp with time zone,
	"total" integer DEFAULT 0 NOT NULL,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "campaigns_channel" CHECK ("campaigns"."channel" IN ('whatsapp', 'email')),
	CONSTRAINT "campaigns_status" CHECK ("campaigns"."status" IN ('draft', 'scheduled', 'queued', 'running', 'paused', 'completed', 'cancelled', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "contact_activity" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"last_marketing_at" timestamp with time zone,
	"last_campaign_id" varchar,
	"total_sent" integer DEFAULT 0 NOT NULL,
	"last_email_at" timestamp with time zone,
	"last_email_campaign_id" varchar,
	"total_emails" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_erasures" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"erased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"erased_by" varchar
);
--> statement-breakpoint
CREATE TABLE "contact_import_changes" (
	"import_batch_id" varchar NOT NULL,
	"contact_id" uuid NOT NULL,
	"operation" varchar NOT NULL,
	"previous_json" jsonb,
	CONSTRAINT "contact_import_changes_import_batch_id_contact_id_pk" PRIMARY KEY("import_batch_id","contact_id"),
	CONSTRAINT "contact_import_changes_operation" CHECK ("contact_import_changes"."operation" IN ('insert', 'update'))
);
--> statement-breakpoint
CREATE TABLE "contact_revision" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_revision_singleton" CHECK ("contact_revision"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "contact_snapshots" (
	"version" integer PRIMARY KEY NOT NULL,
	"blob_path" varchar NOT NULL,
	"row_count" integer NOT NULL,
	"revision" bigint NOT NULL,
	"reason" varchar,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"phone_e164" varchar,
	"wa_to" varchar,
	"country_iso" varchar,
	"time_zone" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"display_name" varchar,
	"email" varchar,
	"company" varchar,
	"city" varchar,
	"language" varchar DEFAULT 'en',
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opt_in_status" varchar DEFAULT 'unknown' NOT NULL,
	"opt_in_source" varchar,
	"opt_in_at" timestamp with time zone,
	"email_opt_in_status" varchar DEFAULT 'unknown' NOT NULL,
	"email_opt_in_source" varchar,
	"email_opt_in_at" timestamp with time zone,
	"consent_proof_ref" varchar,
	"import_batch_id" varchar,
	"created_by" varchar,
	"updated_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contacts_has_identifier" CHECK ("contacts"."phone_e164" IS NOT NULL OR "contacts"."email" IS NOT NULL),
	CONSTRAINT "contacts_opt_in_status" CHECK ("contacts"."opt_in_status" IN ('opted_in', 'unknown', 'opted_out')),
	CONSTRAINT "contacts_email_opt_in_status" CHECK ("contacts"."email_opt_in_status" IN ('opted_in', 'unknown', 'opted_out')),
	CONSTRAINT "contacts_no_phone_no_opt_in" CHECK ("contacts"."phone_e164" IS NOT NULL OR "contacts"."opt_in_status" <> 'opted_in')
);
--> statement-breakpoint
CREATE TABLE "email_link_clicks" (
	"campaign_id" varchar NOT NULL,
	"url" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "email_link_clicks_campaign_id_url_pk" PRIMARY KEY("campaign_id","url")
);
--> statement-breakpoint
CREATE TABLE "email_suppression_list" (
	"email" varchar PRIMARY KEY NOT NULL,
	"reason" varchar NOT NULL,
	"source" varchar,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppression_list_reason" CHECK ("email_suppression_list"."reason" IN ('unsubscribe_link', 'one_click', 'hard_bounce', 'complaint', 'resend_suppressed', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" varchar PRIMARY KEY NOT NULL,
	"file_name" varchar NOT NULL,
	"file_sha256" varchar NOT NULL,
	"source_blob_path" varchar,
	"mapping_json" jsonb,
	"options_json" jsonb,
	"totals_json" jsonb,
	"consent_json" jsonb,
	"status" varchar DEFAULT 'uploaded' NOT NULL,
	"pre_revision" bigint,
	"post_revision" bigint,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_status" CHECK ("import_batches"."status" IN ('uploaded', 'validated', 'committed', 'undone', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "mapping_presets" (
	"id" varchar PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"header_signature" varchar NOT NULL,
	"mapping_json" jsonb NOT NULL,
	"created_by" varchar
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"channel" varchar PRIMARY KEY NOT NULL,
	"next_slot_at" timestamp with time zone,
	"rate_factor" numeric DEFAULT '1' NOT NULL,
	"factor_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar PRIMARY KEY NOT NULL,
	"value_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"phone_e164" varchar PRIMARY KEY NOT NULL,
	"reason" varchar NOT NULL,
	"source" varchar,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_list_reason" CHECK ("suppression_list"."reason" IN ('stop_keyword', 'button', 'manual', 'error_131050'))
);
--> statement-breakpoint
CREATE TABLE "team_allowlist" (
	"email" varchar PRIMARY KEY NOT NULL,
	"added_by" varchar,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" varchar PRIMARY KEY NOT NULL,
	"channel" varchar DEFAULT 'whatsapp' NOT NULL,
	"name" varchar NOT NULL,
	"language" varchar DEFAULT 'en' NOT NULL,
	"category" varchar,
	"status" varchar DEFAULT 'DRAFT' NOT NULL,
	"meta_template_id" varchar,
	"parameter_format" varchar,
	"components_json" jsonb,
	"email_json" jsonb,
	"draft_json" jsonb,
	"rejected_reason" text,
	"quality_score" varchar,
	"last_edited_at" timestamp with time zone,
	"created_by" varchar,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "templates_channel" CHECK ("templates"."channel" IN ('whatsapp', 'email'))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" varchar NOT NULL,
	"external_id" varchar NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature_ok" boolean NOT NULL,
	"payload_json" jsonb,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "webhook_events_source" CHECK ("webhook_events"."source" IN ('meta', 'resend'))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_identities" (
	"bsuid" varchar PRIMARY KEY NOT NULL,
	"phone_e164" varchar,
	"suppressed_at" timestamp with time zone,
	"suppression_source" varchar,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_messages" ADD CONSTRAINT "campaign_messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_import_changes" ADD CONSTRAINT "contact_import_changes_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_link_clicks" ADD CONSTRAINT "email_link_clicks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_user" ON "audit_log" USING btree ("user_email","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_action" ON "audit_log" USING btree ("action","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_messages_campaign_contact" ON "campaign_messages" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_messages_campaign_email" ON "campaign_messages" USING btree ("campaign_id","email_to") WHERE "campaign_messages"."email_to" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_messages_wamid" ON "campaign_messages" USING btree ("wamid");--> statement-breakpoint
CREATE INDEX "campaign_messages_resend_id" ON "campaign_messages" USING btree ("resend_id");--> statement-breakpoint
CREATE INDEX "campaign_messages_campaign_status" ON "campaign_messages" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaign_messages_campaign_status_zone" ON "campaign_messages" USING btree ("campaign_id","status","time_zone");--> statement-breakpoint
CREATE INDEX "campaign_messages_channel_accepted" ON "campaign_messages" USING btree ("channel","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_one_running_per_channel" ON "campaigns" USING btree ("channel") WHERE "campaigns"."status" = 'running';--> statement-breakpoint
CREATE INDEX "campaigns_status" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_unique" ON "contacts" USING btree ("phone_e164") WHERE "contacts"."is_deleted" = false AND "contacts"."phone_e164" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_only_unique" ON "contacts" USING btree ("email") WHERE "contacts"."is_deleted" = false AND "contacts"."phone_e164" IS NULL AND "contacts"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contacts_tags_gin" ON "contacts" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "contacts_first_name_trgm" ON "contacts" USING gin ("first_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_last_name_trgm" ON "contacts" USING gin ("last_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_display_name_trgm" ON "contacts" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_phone_trgm" ON "contacts" USING gin ("phone_e164" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_email_trgm" ON "contacts" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "import_batches_sha" ON "import_batches" USING btree ("file_sha256");--> statement-breakpoint
CREATE INDEX "templates_channel_status" ON "templates" USING btree ("channel","status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedupe" ON "webhook_events" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "webhook_events_received" ON "webhook_events" USING btree ("received_at");--> statement-breakpoint
INSERT INTO "contact_revision" ("id", "revision") VALUES (1, 0) ON CONFLICT DO NOTHING;
