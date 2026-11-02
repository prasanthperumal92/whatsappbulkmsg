# WhatsApp Bulk Messenger — Product & Technical Specification

| Field | Value |
|---|---|
| Document | SPEC.md |
| Version | 2.3 (contacts move to Postgres, email-only contacts, overseas recipients, sending-engine fixes — see §17 Revision log) |
| Date | 2026-11-02 |
| Status | Ready for build. All §15 questions are answered; the people's actions in `TASKS.md` remain |
| Scope | Shared team web app on Vercel: import contacts from CSV → store in Postgres with Parquet snapshots → design marketing templates → send WhatsApp marketing messages via the Meta Graph API (WhatsApp Cloud API) **and bulk marketing emails via the Resend API** → track delivery |

---

## Index

1. [Overview](#1-overview)
   1.1 Purpose · 1.2 Goals · 1.3 Non-goals · 1.4 Users · 1.5 Glossary
2. [Decisions & Constraints](#2-decisions--constraints)
   2.1 Confirmed decisions · 2.2 Constraints & consequences · 2.3 Resolved spec gaps
3. [System Architecture](#3-system-architecture)
   3.1 Deployment model · 3.2 Tech stack · 3.3 Component diagram · 3.4 Storage layout · 3.5 Environments
4. [Data Model](#4-data-model)
   4.1 Contacts table · 4.2 Contact writes & Parquet snapshots · 4.3 Postgres schema · 4.4 Suppression lists · 4.5 Phone normalisation · 4.6 Email normalisation · 4.7 Contact identity & matching · 4.8 Country & time zone
5. [Screens & UX](#5-screens--ux)
   5.1 Navigation & sign-in · 5.2 S-01 Settings · 5.3 S-02 Import wizard · 5.4 S-03 Contacts list · 5.5 S-04 Contact drawer · 5.6 S-05 Template library · 5.7 S-06 Template designer · 5.8 S-07 Campaign wizard · 5.9 S-08 Campaign monitor · 5.10 S-09 Campaign list · 5.11 S-10 Activity log · 5.12 S-11 Email template designer · 5.13 S-12 Unsubscribe page
6. [Functional Requirements](#6-functional-requirements)
   6.1 Import · 6.2 Contacts · 6.3 Templates · 6.4 Campaigns & sending · 6.5 Settings & access · 6.6 Email
7. [Meta Graph API Integration](#7-meta-graph-api-integration)
   7.1 Credentials · 7.2 Endpoints · 7.3 Template creation payload · 7.4 Send payload · 7.5 Media · 7.6 Limits & pricing · 7.7 Error handling · 7.8 Webhooks
7A. [Resend Email Integration](#7a-resend-email-integration)
   7A.1 Credentials & the `.local.bin` file · 7A.2 Provider interface · 7A.3 Endpoints · 7A.4 Send payload · 7A.5 Deliverability & compliance · 7A.6 Limits & pricing · 7A.7 Error handling · 7A.8 Webhooks
7B. [Meta Graph API Setup Guide](#7b-meta-graph-api-setup-guide)
   7B.1 Before you start · 7B.2 Part A: on Meta's side · 7B.3 Part B: in the app · 7B.4 Part C: confirm it works · 7B.5 Test number to real number · 7B.6 Troubleshooting · 7B.7 After go-live · 7B.8 Meta documentation
8. [Sending Engine](#8-sending-engine)
   8.1 Message state machine · 8.2 Campaign workflow · 8.3 Crash & retry safety · 8.4 Idempotency · 8.5 Circuit breaker · 8.6 Progress reporting · 8.7 Campaign states
9. [Backend API](#9-backend-api)
10. [Scheduled Jobs](#10-scheduled-jobs)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Security, Privacy & Compliance](#12-security-privacy--compliance)
12A. [International Privacy & Marketing Rules](#12a-international-privacy--marketing-rules)
13. [Testing Strategy](#13-testing-strategy)
14. [Delivery Plan](#14-delivery-plan)
15. [Open Questions](#15-open-questions)
16. [Risks & Mitigations](#16-risks--mitigations)
17. [Revision Log](#17-revision-log)

---

## 1. Overview

### 1.1 Purpose
A web app, hosted on Vercel and shared by a small team, that lets any team member:
1. Upload a contact CSV from their computer.
2. Map CSV columns to contact fields in a table view.
3. Store the contacts in Postgres, with versioned Parquet snapshots.
4. Browse, filter and multi-select contacts.
5. Design WhatsApp **marketing** message templates and submit them to Meta for approval.
6. Send an approved template to the selected contacts through the Meta Graph API, then track delivery, reads and opt-outs.
7. Design marketing **email** templates and send them to the selected contacts through the **Resend API**, then track delivery, opens, clicks, bounces, complaints and unsubscribes.

### 1.2 Goals
- G1: Import a 50,000-row CSV, with column mapping, in under 60 seconds.
- G2: Sending is safe and resumable: no duplicate sends after a failure, and the app respects Meta rate and messaging limits.
- G3: The app is fully usable on local dev and previews **before** the Meta credentials exist (they arrive in a later stage), using a Mock provider. Production never uses Mock (D16).
- G4: Every important action (import, send, opt-out change, template submission) can be traced to the team member who did it.
- G5: Bulk email works end to end with a Mock email provider **before** the Resend API key is added, and with Resend as soon as the key is in `.local.bin` (local) or the production env vars (§7A.1).

### 1.3 Non-goals (v1)
- Roles and permissions (all team members have equal access).
- Two-way chat inbox (inbound messages are only read for opt-out handling).
- Free-form (non-template) messages, carousel and catalog templates, WhatsApp Flows.
- Several sending phone numbers.
- Template languages other than English.
- Storing opt-in proof documents (proof is kept outside the app).
- Checking in advance whether a number is on WhatsApp (the Cloud API has no such endpoint).
- Contacts with neither a usable phone nor a usable email (§4.7).
- Email attachments, inbound email / a reply inbox, A/B subject tests, transactional email.

### 1.4 Users
| Persona | Needs |
|---|---|
| Team member (marketing / sales) | Upload lists, pick an audience, send a campaign, see results. |
| Admin (any team member, in practice) | Enter Meta credentials, manage templates, manage the team allowlist. |

### 1.5 Glossary
| Term | Meaning |
|---|---|
| WABA | WhatsApp Business Account ID |
| Phone Number ID | Graph API ID of the sending business phone number |
| Template | A Meta-approved message format; required for business-initiated messages |
| MARKETING category | Template category for promotions; charged per delivered message; subject to per-user caps |
| wamid | WhatsApp message ID returned by the API |
| E.164 | International phone format, e.g. `+919876543210` |
| Campaign | One send of one template to a frozen list of recipients |
| Snapshot | One immutable Parquet file of all contacts in Blob, for backup, restore and analysis. Live contacts are in Postgres |
| Channel | `whatsapp` or `email`; every template and campaign has exactly one |
| Resend | Email-sending API (`api.resend.com`) used for the email channel |
| Hard bounce | Permanent delivery failure (`bounce.type = Permanent`); the address is suppressed |
| Complaint | The recipient marked the email as spam; the address is suppressed |
| One-click unsubscribe | `List-Unsubscribe` + `List-Unsubscribe-Post` headers (RFC 8058), required by Gmail and Yahoo for bulk senders |
| BSUID | Business-scoped user ID: the identifier WhatsApp sends for a user, which can arrive without a phone number when the user has a username (§7.8) |

---

## 2. Decisions & Constraints

### 2.1 Confirmed decisions
| # | Decision |
|---|---|
| D1 | Deployed on **Vercel** and shared by a small team with **equal access** and individual sign-in. |
| D2 | Live contacts are stored in **Postgres**. Versioned **Parquet snapshots** are written to Blob. Changed in v2.3; Parquet was previously the live store. |
| D3 | Default country for numbers without a country code: **India (+91)**, changeable in Settings and for each import. |
| D4 | **One** WhatsApp business sending number. |
| D5 | Template language at launch: **English** (`en`). |
| D6 | Opt-in proof is kept **outside** the app. The app records status, source, date and the importer's consent confirmation. |
| D7 | Send path: standard **`/messages`** endpoint with MARKETING templates. The Marketing Messages API stays a switchable option (§7.2.1). |
| D8 | Expected scale: **under 50k contacts**; typical CSV is a few thousand rows. |
| D9 | Webhooks are received directly at the production deployment URL. No tunnel needed. |
| D10 | Bulk email is sent through **Resend** (`POST /emails/batch`). Email is a second channel next to WhatsApp, sharing contacts, audiences, the campaign engine and the audit log. |
| D11 | The Resend API key is supplied **later**. Locally it goes in **`.local.bin`** (git-ignored, dotenv format); in production it is a Vercel env var or the encrypted Settings row (§7A.1). |
| D12 | Consent is tracked **per channel**: WhatsApp opt-in and email opt-in are separate fields and separate suppression lists. |
| D13 | A contact needs a valid **phone or email**. Email-only and phone-only contacts are both allowed (§4.7). |
| D14 | Recipients are **mostly overseas**: per-country price estimates, a send window in each recipient's local time, a restricted-country list and international privacy rules (§4.8, §12A). Main regions: India, Sri Lanka, Indonesia and other Southeast Asia, the Middle East and Gulf, Africa, Europe and the UK, and North America. |
| D15 | Contacts with `unknown` consent can be included only with a toggle, an acknowledgement, an audit entry and a per-campaign limit (default 500). They stay excluded in strict-consent countries (§5.8, §12A). |
| D16 | The Mock providers run only on local dev and previews. Production shows "not connected" until real credentials exist. |

### 2.2 Constraints & consequences
| # | Constraint | Consequence |
|---|---|---|
| C1 | Vercel functions have no persistent disk (only temporary `/tmp`). | Live data is in Postgres. Uploaded CSVs, Parquet snapshots, exports and media are in **private Vercel Blob** (§3.4). |
| C2 | Parquet files are immutable. | Every snapshot is a new file. Parquet is never used for row-level reads or writes. |
| C3 | Request bodies are limited to 4.5 MB. | CSVs are uploaded **straight from the browser to Blob** (client upload); functions read them from Blob. |
| C4 | Functions are request-scoped (300 s default timeout); there is no always-on worker. | Campaign sending runs as a durable **Vercel Workflow** (§8.2); periodic tasks run as **Vercel Cron** (§10). |
| C5 | Several team members can act at the same time. | Contact changes are ordinary Postgres transactions. Imports and restores also take an advisory lock, so only one runs at a time. Only one campaign per channel sends at a time. |
| C6 | Business-initiated messages outside the 24-hour window need an **approved template**. | Only `APPROVED` templates can be sent. |
| C7 | WhatsApp Business policy requires recipient opt-in for marketing. | Opt-in status is a first-class field; the suppression list is the authority (§4.4). |
| C8 | Meta credentials arrive later. | Credentials can be set in the UI or as env vars at any time. A **Mock provider** covers local dev and previews (§7.1.3). |
| C9 | The app is on the public internet. | Sign-in is required for everything except the webhook and cron endpoints, which have their own verification (§12). |
| C10 | Resend allows 100 emails per batch call and, by default, 10 API requests/s per team. | Email sends in batches of 100 at a configured request rate (default 2/s = 200 emails/s), leaving headroom for test sends (§7A.6). |
| C11 | Gmail/Yahoo bulk-sender rules: SPF + DKIM + DMARC, one-click unsubscribe, spam-complaint rate under 0.3%. | Email cannot be sent until the domain is verified; every marketing email carries one-click unsubscribe headers and a footer link; complaints and hard bounces auto-suppress; a circuit breaker pauses on high bounce/complaint rates (§7A.5, §8.5). |
| C12 | `.local.bin` is never deployed (git-ignored). | Production needs the key as a Vercel env var or entered on S-01. |
| C13 | Vercel Workflow pins each run to the deployment that started it. The default runtime allows 25,000 events and 10,000 steps per run. | Long waits end the run and a cron starts a new one when due. Runs hand off after 1,000 batches (§8.2). Check the current limits in the P1 spike. |
| C14 | WhatsApp does not currently deliver marketing templates to US phone numbers. | US numbers are on the default restricted-country list and excluded in S-07 (§5.8). |
| C15 | Inbound and status webhooks can omit the phone number for users with a WhatsApp username, sending a BSUID instead. | The app stores BSUID-to-phone mappings and honours opt-outs that have no phone (§7.8). |

### 2.3 Resolved spec gaps
These answer the gaps listed in `evals/README.md`. They are now requirements.

| Gap | Answer |
|---|---|
| G-01 | A number with the country code but no `+` is accepted |
| G-02 | Unicode spaces are stripped |
| G-03 | Fixed-line numbers are accepted |
| G-04 | A phone extension is accepted and dropped |
| G-05 | `delivered` and `read` cannot override `failed` |
| G-06 | Before the request is sent, a network error is retried. Once it may have reached Meta, §8.3 wins and the row becomes `unknown` |
| G-07 | An error code not in the table means `failed`, not retried |
| G-08 | STOP with trailing punctuation suppresses |
| G-09 | An opt-out keyword in a media caption is ignored |
| G-10 | The CSV injection prefix applies to phones with a leading `+` |
| G-11 | The send-window end is exclusive |
| G-12 | "Too many variables" is implementation-defined; pick one ratio and keep it in the validator |
| G-13 | An invalid webhook signature returns **401** and is not processed |
| G-14 | Newlines, tabs and runs of spaces in parameters become one space |
| G-15 | The opt-in column is case-insensitive; `no` means `unknown` |
| G-16 | Tags are unioned under the Skip policy too |
| G-17 | Overwrite with an empty cell keeps the existing value |
| G-18 | A `Name` header maps to `first_name` |
| G-19 | An invalid email is dropped with a warning; the row is kept if it has a valid phone |
| G-20 | A template Meta re-categorises away from MARKETING is not offered in the wizard |
| G-21 | Several addresses in one cell are invalid and the value is dropped |
| G-22 | A hard bounce after `opened` keeps the status `opened` and still suppresses the address |

---

## 3. System Architecture

### 3.1 Deployment model
- A single **Next.js** project on Vercel, Node.js runtime on Fluid Compute. The app detects its own production URL: the custom domain once one is attached, otherwise `VERCEL_PROJECT_PRODUCTION_URL`. S-01 shows it, with every URL to configure elsewhere (FR-SET-08). Clerk production sign-in needs a custom domain (§15 Q1).
- Region: `sin1` (Singapore) for functions, the database (Neon `aws-ap-southeast-1`) and Blob, so they sit together. Neon has no region in India, and Singapore is its closest. The team is in India; recipients are mostly overseas (D14), and data transfers are covered in §12A.
- Git-connected: changes reach `master` only through pull requests that pass CI (type check, unit and integration tests, `evals:check`). Merging deploys to production; pull requests get preview deployments (§3.5).
- Migrations run as a deploy step and must be backward compatible (expand, then contract), because pinned Workflow runs on an older deployment keep using the same database.

### 3.2 Tech stack
| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js (App Router, TypeScript) | UI and API in one project; native on Vercel |
| Auth | **Clerk** (Vercel Marketplace) | Email/Google sign-in, allowlist, no public sign-up |
| Contacts storage | **Neon Postgres** | Row-level updates, transactions, indexes and joins with campaign data |
| Parquet snapshots | DuckDB (`@duckdb/node-api`), used only by the snapshot job | Writes ZSTD Parquet. Fallback: `hyparquet-writer` (pure JS) if the native binary causes trouble; the P1 spike picks one. A failure never affects live contacts |
| Operational DB | **Neon Postgres** (Vercel Marketplace) + Drizzle ORM | Campaign and message state. Use a pooled or WebSocket driver, because imports need interactive transactions |
| Background sending | **Vercel Workflow** | Durable, step-based, survives restarts; sleep for pacing and send windows |
| Periodic jobs | Vercel Cron | Template sync, clean-up, reconciliation |
| Phone parsing | `libphonenumber-js` (max metadata) | E.164 validation |
| Email sending | **Resend** (`resend` Node SDK) | Batch API, idempotency keys, Svix-signed webhooks, domain verification |
| Email rendering | React Email (`@react-email/components` + `render`) | Templates built from blocks render to tested, client-safe HTML and a plain-text part |
| Email webhook verification | `svix` (or `resend.webhooks.verify`) | Signature check for `/api/webhooks/resend` |
| UI | Tailwind + shadcn/ui | |
| Tables | TanStack Table + TanStack Virtual | Mapping grid and contacts grid |
| Data fetching | TanStack Query | Polling for campaign progress |
| CSV preview | PapaParse (Web Worker) | Instant in-browser preview |
| Secrets | Vercel env vars (sensitive) and/or an AES-256-GCM encrypted row in Postgres; `.local.bin` for the Resend key in local dev | §7.1.2, §7A.1 |

### 3.3 Component diagram
```
 Team member's browser (Next.js UI, signed in with Clerk)
   │  ① CSV ─────────────── client upload ───────────────┐
   │  ② REST /api/*                                      ▼
┌──▼──────────────── Vercel (Next.js, Fluid Compute) ────────────────┐
│ Route handlers: imports · contacts · templates · campaigns ·       │
│                 settings · webhooks/whatsapp · webhooks/resend ·   │
│                 u/{token} (public unsubscribe) · cron/*            │
│ Services: ImportService · ContactStore · SnapshotService           │
│           TemplateService · EmailRenderer · CampaignService ·      │
│           WebhookProcessor                                         │
│ Workflow: runCampaign(campaignId)  (durable steps, sleeps)         │
│ WhatsAppProvider ── GraphApiProvider │ MockProvider                │
│ EmailProvider    ── ResendProvider   │ MockEmailProvider           │
└───┬──────────────────────┬──────────────┬─────────────┬────────────┘
    │                      │              │ HTTPS       │ HTTPS
 Vercel Blob (private)   Neon Postgres  graph.facebook.com   api.resend.com
 snapshots/*.parquet     contacts,         ▲                    ▲
 imports/*.csv           campaigns,        │ statuses, STOP,    │ sent, delivered, opened,
 media/*                 messages,         │ template status    │ clicked, bounced, complained
 email-assets/*          templates,        │                    │ (Svix-signed)
                         suppression,      └ POST /api/webhooks/whatsapp
                         audit                                  └ POST /api/webhooks/resend
```

### 3.4 Storage layout
**Vercel Blob (private)**, with the prefix taken from the environment (`prod/`, `preview/<branch>/`):
```
{env}/snapshots/s000123.parquet       # immutable contact snapshots (deleted after 30 days)
{env}/imports/{import_id}/source.csv  # uploaded CSV (deleted after 7 days)
{env}/imports/{import_id}/rejects.csv # rejected rows with reasons (deleted after 7 days)
{env}/media/{sha256}.{ext}            # template header media
{env}/email-assets/{sha256}.{ext}     # email template images, in a separate public store (email clients cannot send a session)
{env}/exports/{export_id}.csv         # contact exports (deleted after 24 h)
```
**Stores:** a Blob store's access mode is fixed when it is created, so there are two: a private store for everything above, and a public store holding only `email-assets/`.

**Neon Postgres:** contacts and everything else (§4.3).

### 3.5 Environments
| Env | WhatsApp provider | Email provider | Data | Notes |
|---|---|---|---|---|
| Local dev (`vercel dev` / `next dev`) | Mock | Mock, or **Resend once `RESEND_API_KEY` is in `.local.bin`** | Neon dev branch, Blob `dev/` prefix | Env vars from `vercel env pull`, then `.local.bin` (§7A.1). Without a public URL Resend webhooks don't reach localhost; use `vercel dev` + a tunnel, or rely on the `reconcile-emails` cron (§10) |
| Preview (per PR) | **Mock, forced** | **Mock, forced** | Neon branch per preview, Blob `preview/<branch>/` | Preview deployments can never send real messages or emails, or touch production contacts. Uses a Clerk development instance, because Clerk production keys do not work on `*.vercel.app`. Mock webhooks use a Deployment Protection bypass secret. Vercel Cron runs only on Production, so tests call cron routes directly |
| Production | Graph API once credentials are set; otherwise not connected (no Mock) | Resend once the key is set and the domain is verified; otherwise not connected (no Mock) | Neon main, Blob `prod/` | Webhook URLs registered with Meta and Resend. Clerk production needs a domain you own, so `wa.graceferroexports.com` must be attached before production sign-in works |

---

## 4. Data Model

### 4.1 Contacts table (`schema_version = 3`)
| Column | Type | Null | Notes |
|---|---|---|---|
| contact_id | UUID | no | Primary key, UUIDv7, stable |
| phone_e164 | VARCHAR | yes | e.g. `+919876543210`. Unique among non-deleted contacts |
| wa_to | VARCHAR | yes | Digits only, used in the API `to` field. Null when there is no phone |
| country_iso | VARCHAR | yes | e.g. `IN`; from the phone, or a mapped country column (§4.8) |
| time_zone | VARCHAR | yes | IANA name, e.g. `Europe/London` (§4.8) |
| first_name | VARCHAR | yes | |
| last_name | VARCHAR | yes | |
| display_name | VARCHAR | yes | Falls back to first + last |
| email | VARCHAR | yes | Normalised and validated per §4.6. Contacts with a phone may share an address (a campaign still sends it once, §5.8). Unique among non-deleted contacts that have no phone |
| company | VARCHAR | yes | |
| city | VARCHAR | yes | |
| language | VARCHAR | yes | Reserved for later multi-language templates; default `en` |
| tags | TEXT[] | no (empty list) | Lowercase, trimmed. GIN index |
| attributes | JSONB | no (`{}`) | Custom fields from mapping |
| opt_in_status | VARCHAR enum | no | **WhatsApp** consent: `opted_in` \| `unknown` \| `opted_out`; see §4.4. Always `unknown` or `opted_out` when there is no phone |
| opt_in_source | VARCHAR | yes | e.g. `csv:expo_leads.csv` |
| opt_in_at | TIMESTAMPTZ | yes | |
| email_opt_in_status | VARCHAR enum | no | **Email** consent, same values; default `unknown` |
| email_opt_in_source | VARCHAR | yes | |
| email_opt_in_at | TIMESTAMPTZ | yes | |
| consent_proof_ref | VARCHAR | yes | Where the proof kept outside the app can be found (D6, §12A), e.g. a form ID or file name |
| import_batch_id | VARCHAR | yes | Last import that touched the row |
| created_by / updated_by | VARCHAR | yes | Clerk user ID |
| created_at / updated_at | TIMESTAMPTZ | no | UTC |
| is_deleted | BOOLEAN | no | Soft delete |
| deleted_at | TIMESTAMPTZ | yes | Set on soft delete; starts the purge period (§12A) |

Constraints: `CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)`; partial unique indexes on `phone_e164` where not deleted, and on `email` where not deleted and `phone_e164` is null. Name, phone and email search uses `pg_trgm` indexes.

### 4.2 Contact writes & Parquet snapshots
**Writes.** Every edit and bulk action is one Postgres transaction, which also writes the audit row. Each user-initiated data change (import, edit, bulk action, restore) increments a singleton `contact_revision`. Suppression and other system writes do not.

**Import commit:**
1. Open a transaction and take `pg_advisory_xact_lock(<contact_import>)`, so only one import or restore runs at a time.
2. Load the validated rows into a temporary table, and re-run matching (§4.7) against current data, because contacts may have changed since Step 3.
3. Merge into `contacts`, recording each row's previous values in `contact_import_changes`.
4. Set `import_batches.post_revision`, then commit.

**Undo import** is allowed only while `contact_revision` still equals the import's `post_revision`. It reverts the rows from `contact_import_changes` in one transaction. New suppressions do not block undo, and undo never changes an opted-out status back (§4.4).

**Snapshots.** `SnapshotService` streams non-deleted contacts to a ZSTD Parquet file in `/tmp`, checks the row count and that `phone_e164` is unique, uploads it to `{env}/snapshots/` and inserts a `contact_snapshots` row. It runs on the §10 schedule when `contact_revision` has changed, before every restore, and on demand from S-01. Parquet key/value metadata: `app.schema_version`, `app.version` (snapshot number), `app.row_count`, `app.written_by`. A failed snapshot raises a banner and never affects live contacts.

**Restore** (S-01): take a snapshot, take the advisory lock, then replace `contacts` from the chosen snapshot in one transaction. It skips IDs in `contact_erasures` (§12A) and re-applies both suppression lists. Older snapshots are read with defaults for missing columns.

**Retention:** snapshots are deleted after 30 days, so an erased contact leaves all of them within 30 days.

### 4.3 Postgres schema (Drizzle)
| Table | Key columns |
|---|---|
| `contacts` | §4.1 |
| `contact_revision` | id (singleton), revision, updated_at |
| `contact_snapshots` | version (PK), blob_path, row_count, revision, reason, created_by, created_at, deleted_at |
| `contact_import_changes` | import_batch_id, contact_id, operation (`insert`/`update`), previous_json — deleted when the import can no longer be undone |
| `contact_erasures` | contact_id (PK), erased_at, erased_by — holds no personal data; restores skip these IDs |
| `import_batches` | id, file_name, file_sha256, source_blob_path, mapping_json, options_json, totals_json, consent_json (which confirmations were ticked, by whom and when), status (`uploaded`/`validated`/`committed`/`undone`/`failed`), pre_revision, post_revision, created_by, created_at |
| `mapping_presets` | id, name, header_signature, mapping_json, created_by |
| `templates` | id, **channel** (`whatsapp`/`email`), name, language, category, status, meta_template_id, parameter_format, components_json, email_json, draft_json, rejected_reason, quality_score, last_edited_at, created_by, last_synced_at. Email templates use status `DRAFT`/`READY` and store subject, preheader, blocks, variables and samples in `email_json`; the Meta columns stay null |
| `campaigns` | id, **channel**, name, template_id, template_snapshot_json, variable_mapping_json, status (§8.7), workflow_run_id, run_token, heartbeat_at, wait_until, wait_reason, pause_reason, send_media_id, send_media_uploaded_at, stage_index, stage_sent, include_unknown (with acknowledgement user and time), total, created_by, created_at, scheduled_at, started_at, finished_at |
| `campaign_messages` | id, campaign_id, contact_id, phone_e164 (null when there is no phone), params_json, status, claim_token, claimed_at, time_zone, country_iso, wamid, error_code (also holds skip reasons such as `EMPTY_VARIABLE`), error_subcode, error_title, error_detail, fbtrace_id, attempts, next_attempt_at, accepted_at, sent_at, delivered_at, read_at, failed_at, price_category, **channel**, email_to (lower-cased, email campaigns only), resend_id, batch_key (email: idempotency key of the batch that carried the row), bounce_type, bounce_subtype, opened_at, clicked_at, complained_at, unsubscribed_at, updated_at — **UNIQUE(campaign_id, contact_id)**, **UNIQUE(campaign_id, email_to)** where `email_to` is not null, INDEX(wamid), INDEX(resend_id), INDEX(campaign_id, status), INDEX(campaign_id, status, time_zone), INDEX(channel, accepted_at) |
| `contact_activity` | contact_id (PK), last_marketing_at, last_campaign_id, total_sent, last_email_at, last_email_campaign_id, total_emails — maintained by the sender; joined into the contacts list. Frequency caps are per channel |
| `suppression_list` | phone_e164 (PK), reason (`stop_keyword`, `button`, `manual`, `error_131050`), source, created_by, created_at — WhatsApp only |
| `email_suppression_list` | email (PK, normalised), reason (`unsubscribe_link`, `one_click`, `hard_bounce`, `complaint`, `resend_suppressed`, `manual`), source (e.g. campaign id), created_by, created_at |
| `whatsapp_identities` | bsuid (PK), phone_e164 (nullable), suppressed_at, suppression_source, first_seen_at, last_seen_at (§7.8) |
| `email_link_clicks` | campaign_id, url, clicks — PK(campaign_id, url) |
| `rate_limits` | channel (PK), next_slot_at, rate_factor, factor_until — shared by campaign and test sends (§8.2) |
| `webhook_events` | id, **source** (`meta`/`resend`), external_id (dedup key: Resend `svix-id`; Meta SHA-256 of the raw body), received_at, signature_ok, payload_json, processed_at, error |
| `settings` | key, value_json (non-secret); `secrets` row holds the encrypted Meta credentials and, if entered on S-01, the Resend API key and webhook signing secret |
| `audit_log` | id, at, user_id, user_email, action, entity, entity_id, details_json |
| `team_allowlist` | email (PK), added_by, added_at |

**Joins:** contact lists and filters on Postgres data ("last messaged > 30 days", "suppressed") are ordinary SQL joins with `contact_activity` and the suppression lists.

### 4.4 Suppression lists (authority on opt-out)
The rules below apply to each channel's list: `suppression_list` (phone, WhatsApp) and `email_suppression_list` (address, email). A WhatsApp STOP does **not** unsubscribe the contact from email, and an email unsubscribe does not stop WhatsApp; S-04 shows both and offers "Opt out of all channels".
- `opt_in_status` and `email_opt_in_status` on `contacts` are kept in step with the lists, in the same transaction, wherever a contact matches. The **suppression lists** remain the authority: the sender checks them at campaign creation **and** just before each send.
- Opt-outs from webhooks and from the unsubscribe page (S-12) are written immediately. An opt-out for an identifier with no contact yet is still stored and applied if that contact is imported later.
- Snapshot restores, import undos and re-imports can never re-enable a suppressed number or address. Removing an entry requires a manual action with a reason, which is audit-logged. The contact's status then becomes `unknown`, never `opted_in`; moving it back to `opted_in` needs a separate consent confirmation.
- A WhatsApp opt-out that arrives with only a BSUID is stored in `whatsapp_identities` and applied to the phone as soon as the mapping is known (§7.8).

### 4.5 Phone normalisation
1. Read every CSV column as **text**, with no type inference, so leading zeros and `+` signs are kept.
2. Strip spaces, `-`, `.`, `(`, `)`. Convert a leading `00` to `+`.
3. If a country-code column is mapped, prefix it.
4. Otherwise, if there is no `+`, parse with the default country (IN, changeable in Settings and for each import). A leading trunk `0` is handled (`098765 43210` → `+919876543210`).
5. Validate with `isValidPhoneNumber`. If invalid, the phone is unusable with reason `INVALID_PHONE`.
6. Detect Excel damage: values like `9.19876E+11` are unusable with reason `SCIENTIFIC_NOTATION` and a hint to re-export the column as text. An unusable or empty phone rejects the row only when there is no usable email (§4.7).
7. Output `phone_e164` and `wa_to` (E.164 without the `+`).

### 4.6 Email normalisation
Used by import, contact edits and the send path (one function, `normaliseEmail`, shared by browser and server).
1. Trim, including Unicode spaces; strip a leading `mailto:` and surrounding `<…>`.
2. Lower-case the whole address (local parts are case-insensitive at every mailbox provider we send to). Gmail dots and `+tags` are **kept**: they are different addresses as far as consent is concerned.
3. Validate: one `@`, a non-empty local part ≤ 64 chars, a domain with a dot and a valid TLD, total ≤ 254 chars, no spaces. IDN domains are converted to punycode.
4. A cell holding several addresses (`a@x.com; b@y.com`) is invalid as a whole (see G-21).
5. An invalid email **does not reject a row that has a usable phone**: the value is dropped and the row gets warning `INVALID_EMAIL`, counted on Step 3. A row with neither is rejected (§4.7).
6. Role addresses (`info@`, `sales@`, `noreply@`…) are kept but flagged; the campaign wizard shows the count (they bounce and complain more).

### 4.7 Contact identity & matching
A row or edit must leave a contact with a usable phone or a usable email. The same rules apply to import, single edits and restore.

**Importing a row:**
| Row has | Result |
|---|---|
| Usable phone and email | Match on phone. If no match, and exactly one email-only contact has that address, add the phone to that contact. Otherwise create a contact |
| Usable phone only | Match on phone, otherwise create a contact |
| Usable email only | Match the email-only contact with that address. Otherwise, if exactly one contact with a phone has that address, match it. If several do, match the earliest by `contact_id` and add warning `AMBIGUOUS_EMAIL`. Otherwise create an email-only contact |
| Neither | Reject with the phone's reason (`INVALID_PHONE`, `SCIENTIFIC_NOTATION`, `EMPTY_PHONE`) |

- An unusable phone alongside a usable email keeps the row as an email-only contact, with the phone's reason as a warning.
- Duplicates within a file use the same rules; the first occurrence is kept.
- Soft-deleted contacts are ignored when matching, so re-importing one creates a new contact. Suppression still applies, because it follows the phone or address.

**Editing a contact:** a phone or email already held by another contact under the rules above is rejected, and so is removing the last usable identifier.

**Consent follows the identifier.** When a contact's phone or email changes through an edit or an Overwrite import, that channel's consent resets to `unknown`, unless the change comes with the matching consent confirmation. A new identifier on the suppression list is `opted_out`.

### 4.8 Country & time zone
- `country_iso` comes from a mapped country column, otherwise from the phone number. Email-only contacts with no mapped country have none; the address's domain is not used to guess.
- `time_zone` comes from a mapped time-zone column, otherwise from a table in `lib/geo` of each country's representative zone (for example `US` → `America/Chicago`). Countries spanning several zones are approximate, so the mapping option exists.
- With no country, the recipient uses the **fallback time zone** in Settings (default `Asia/Kolkata`). S-07 shows how many recipients use it.
- An invalid mapped time zone is ignored, with warning `INVALID_TIME_ZONE`.
- `campaign_messages.time_zone` and `country_iso` are frozen with the recipient.

---

## 5. Screens & UX

### 5.1 Navigation & sign-in
- Visiting any page while signed out shows the Clerk sign-in (email code or Google). Only emails on the **team allowlist** can sign in; public sign-up is disabled.
- Left sidebar: **Contacts**, **Import**, **Templates** (tabs: *WhatsApp* · *Email*), **Campaigns**, **Activity**, **Settings**. The user menu sits top right.
- Banners: *"WhatsApp not connected — sending and template submission are disabled. [Open Settings]"* · *"Email not connected — add `RESEND_API_KEY` to `.local.bin` (local) or Settings → Email. [Open Settings]"* · *"Email domain `mail.example.com` is not verified — email sending is disabled"* · *"Mock mode — messages are simulated"* / *"Email mock mode — emails are simulated"* (always shown when Mock is active; local dev and previews only) · *"Contact snapshot failed"* · *"Campaign 'Festive offer' is sending — 4,210 / 9,800"* with a channel icon (shown on all screens while a campaign runs; one line per running channel).

### 5.2 S-01 Settings
1. **WhatsApp connection:** Access token (write-only, masked; shows "set by env var" when an env var supplies it), WABA ID, Phone Number ID, App ID, App Secret, Graph API version (default: latest stable at build time, e.g. `v26.0`). Provider `Graph API | Mock` appears on local dev only; previews are forced to Mock and production always uses the Graph API.
   - **Test connection:** `GET /{phone-number-id}?fields=display_phone_number,verified_name,quality_rating,throughput,whatsapp_business_manager_messaging_limit` plus `GET /{waba-id}/message_templates?limit=1`. Shows the display name, number, quality rating, messaging limit and any error.
   - **App URLs card (FR-SET-08):** the detected app URL and webhook URLs, each with a copy button, so nothing is typed by hand when configuring Clerk, Meta or Resend.
   - **Webhook setup card:** callback URL (`https://<prod-domain>/api/webhooks/whatsapp`, with a copy button), verify token (generated, with a copy button), fields to subscribe, and the time of the last received event.
2. **Email (Resend):** provider `Resend | Mock` appears on local dev only (Mock until a key exists). Previews are forced to Mock. Production always uses Resend and stays not connected until a key exists.
   - **API key:** write-only, masked. The status line says where the key comes from: *"Loaded from `.local.bin`"* (local dev only), *"Set by env var"*, *"Saved in Settings"* or *"Not set — add `RESEND_API_KEY=re_…` to `.local.bin`"*. Precedence in §7A.1.
   - **Sending domain:** domain name (e.g. `mail.example.com`, a subdomain keeps marketing reputation away from the main domain), status from `GET /domains` (`verified` / `pending` / `failed`), the SPF and DKIM records to add with copy buttons, and a DMARC check (warns if no `_dmarc` record). **Re-check** button.
   - **Sender:** from name, from address (must be on the verified domain), reply-to address.
   - **Footer:** business postal address (**required** before the first email send), unsubscribe-page wording.
   - **Webhook setup card:** callback URL (`https://<prod-domain>/api/webhooks/resend`, copy button), events to subscribe (`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`), signing secret (write-only; or `RESEND_WEBHOOK_SECRET` env var), time of the last received event.
   - **Email sending:** batch requests per second (default 2, max 10 or the account's limit; each request carries up to 100 emails), daily send cap (the plan's quota, default 100 for Resend Free; the wizard and engine respect it), monthly send cap (default 3,000 for Resend Free), **hourly send cap** (default 5,000), **staged sending** (default on, §7A.5), **new-domain ramp** (default on, §7A.5), frequency cap (default: skip contacts emailed in the last 7 days), send window (default 09:00–20:00 in each recipient's local time, separate from WhatsApp), test email address(es), circuit-breaker thresholds (bounce rate 5%, complaint rate 0.3%), price per 1,000 emails (cost estimate), open and click tracking (informational: configured on the Resend domain; Apple Mail Privacy Protection inflates opens).
   - **Test connection:** `GET /domains`; shows the domain status, and sends nothing. **Send test email** sends a sample to the test address(es).
3. **WhatsApp sending:** messages per second (default 20, max 80), frequency cap (default: skip contacts who received a marketing message in the last 7 days), send window (default 09:00–20:00 in each recipient's local time), test phone number(s), messaging limit tier (read from the `whatsapp_business_manager_messaging_limit` phone number field, e.g. `TIER_250`, otherwise entered manually; the older `messaging_limit_tier` field is deprecated), send endpoint (`/messages` default | `/marketing_messages`), circuit-breaker threshold, **price table** per marketing message by country, with a default for unlisted countries (used for cost estimates; values come from Meta's rate card), **restricted countries** (default `US`).
4. **Import:** default country (IN), fallback time zone (`Asia/Kolkata`), default WhatsApp and email opt-in status, existing-contact policy, max file size (default 50 MB).
5. **Team:** allowlist of emails (add / remove). Changes are audit-logged.
6. **Data:** live contact count, snapshot history (create now, restore with confirmation), export all contacts to CSV, opt-out keywords (default `STOP`, `UNSUBSCRIBE`, `STOP PROMOTIONS`), email suppression list (view, export, add, remove with reason), opt-outs with no matched contact.
7. **Audience rules:** limit on `unknown`-consent recipients per campaign (default 500), strict-consent countries (default: EU/EEA, UK, GG, JE, IM, Canada; §12A), privacy notice URL for the email footer.

### 5.3 S-02 Import wizard (4 steps)
Only one import can be committed at a time; a second user sees *"An import by Ravi is in progress"*.

**Step 1 — Choose file**
- Drag-and-drop or file picker; `.csv` / `.txt`; max 50 MB / 200k rows (configurable).
- The browser parses the first 200 rows with PapaParse in a Web Worker for an instant preview.
- **At the same time**, the file is uploaded straight from the browser to private Blob (`@vercel/blob/client` `upload()`, authorised by `/api/imports/upload-token`, which checks the session, size and content type). The upload has a progress bar.
- The server records an `import_batches` row with the file's SHA-256. If the hash matches a committed import: *"This file was already imported on 12 Oct by Asha."*
- Detection, each with a manual override: encoding (strict UTF-8 decode first, then Windows-1252 / UTF-16 fallback; BOM stripped), delimiter (`,` `;` `\t` `|`), quote character, header-row toggle, rows to skip.

**Step 2 — Map columns (tabular UI)**
```
┌ Map columns ───────────────────────────────── Preset: [Expo leads ▾] [Save preset] ┐
│            │ Col A          │ Col B          │ Col C           │ Col D            │
│ Map to →   │ [Phone ▾] *    │ [First name ▾] │ [Tags ▾]        │ [Ignore ▾]       │
│ Header     │ Mobile No      │ Name           │ Segment         │ Notes            │
│ Fill / uniq│ 99% / 98%      │ 97% / 61%      │ 100% / 4        │ 12% / 11%        │
│ Row 1      │ 98765 43210    │ Asha           │ steel;export    │ called twice     │
│ Row 2      │ +91 98450 1... │ Ravi           │ steel           │                  │
│ ...        │ (virtualised, first 200 rows)                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```
- A dropdown in each column header offers: every standard field (including Country and Time zone), *Custom field…* (stored in `attributes`), *Ignore*.
- **Auto-suggest** from header synonyms, e.g. Phone ← `phone, mobile, mobile no, whatsapp, contact, cell, number`.
- A target field can be used by only one column (Tags can merge several). Phone or Email must be mapped: *Next* stays disabled until at least one is.
- Options: **default country for this file** (from Settings; numbers without a `+` use it, so check it for overseas lists); country-code column; tag separator (default `;`); "apply these tags to every row"; **WhatsApp** opt-in column mapping (`yes/true/1/y` → opted_in) or one value for the whole file; **email** opt-in column mapping or one value for the whole file (separately; default `unknown`); consent proof reference column or value.
- Email cells that fail §4.6 are highlighted amber. Phone cells that fail validation are amber too when the row has a usable email, because the row is still imported, and red otherwise.
- Mapping presets are shared by the team and matched automatically by header signature.

**Step 3 — Validate & resolve**
`POST /api/imports/{id}/validate` reads the whole CSV from Blob, applies the mapping and normalisation, and compares with the current store. It returns:
| Metric | Example |
|---|---|
| Total rows | 12,480 |
| Valid new | 10,902 |
| Valid, already in store | 1,201 |
| Email-only (no usable phone) | 310 — of which 40 had an unusable phone |
| Duplicates within file | 212 (first occurrence kept) |
| Suppressed numbers | 34 (imported but kept opted-out) |
| Invalid (no usable phone or email) | 165 — INVALID_PHONE 140, SCIENTIFIC_NOTATION 20, EMPTY_PHONE 5 |
| Email warnings | 96 — INVALID_EMAIL 90 (value dropped), role address 6 |
| Suppressed emails | 12 (imported but kept email-opted-out) |
| No country known | 28 (these use the fallback time zone) |
| Restricted country | 57 (imported; excluded from WhatsApp marketing) |

- Existing-contact policy: **Skip** · **Fill empty fields only** (default) · **Overwrite mapped fields**. Tags are always unioned.
- An opted-out or suppressed contact is **never** switched back to opted-in by an import, on either channel.
- Download rejected rows (`rejects.csv`, with a `reject_reason` column).
- Required checkbox when importing as `opted_in`: *"I confirm these contacts agreed to receive WhatsApp marketing messages from us, and the proof is kept on file."* The confirming user and the time are stored.
- A second, separate checkbox when importing with email opt-in `opted_in`: *"I confirm these contacts agreed to receive marketing emails from us, and the proof is kept on file."*

**Step 4 — Import**
- Commit runs the import transaction (§4.2). The UI polls the status.
- The result card shows counts, **View imported contacts** (S-03 filtered by batch), **Start campaign for these** (WhatsApp or email), and **Undo this import** (only while no later user change has been made to contacts; otherwise the button explains why it is disabled).

### 5.4 S-03 Contacts list
- Server-paged grid (100 rows per page, virtualised) with sticky selection and phone columns.
- Columns: selection, name, phone, **email**, **country**, tags (chips), WhatsApp opt-in badge and **email opt-in badge** (each with its suppression list overlaid), company, city, last messaged, **last emailed**, created, created by. A column chooser adds custom attributes.
- **Search:** name, phone or email (contains).
- **Filters:** tags (any/all), WhatsApp opt-in status, **has phone (yes/no), country, email opt-in status, has email (yes/no), email suppressed**, import batch, created date range, last messaged and **last emailed** (never / older than N days / within N days), attribute equals.
- **Sort:** any column.
- **Selection model:**
  - Row checkbox; shift-click selects a range; the header checkbox selects the page.
  - Banner: *"100 selected on this page. Select all 8,412 matching contacts?"*. This switches to filter-based selection (filter + excluded IDs), so selection does not depend on paging.
  - The selection count is always shown in the action bar. Selection persists across pages and in the URL (so it can be shared with a teammate).
- **Bulk action bar:** **Send campaign ▾** (primary split button: *WhatsApp* · *Email*; opens S-07 with the channel preset), Add tags, Remove tags, Mark opted-out ▾ (*WhatsApp* · *Email* · *All channels*), Set email opt-in, Delete, Export CSV.
- **Add contact** opens a form: phone or email (one is required), name, company, city, country, tags, consent proof reference and one consent confirmation per channel. It uses the import's normalisation and consent rules. An invalid identifier, or one another contact holds under §4.7, is refused rather than merged.
- Empty state: "No contacts yet. [Import CSV]".

### 5.5 S-04 Contact drawer
Opens from a row click: editable fields with validation, a **Consent** panel with one row per channel (WhatsApp: opt-in status, source, suppression entry; Email: email opt-in status, source, suppression entry with reason such as *hard bounce* or *unsubscribed via link*; plus the consent proof reference), tags, attributes, and message history for both channels (channel icon, campaign, status, timestamps, error or bounce reason). Actions: Mark opted-out (per channel or all channels); Remove from suppression (per channel, asks for a reason; a `complaint` entry needs an extra confirmation); Delete; **Erase now** (§12A); Export this contact's data. Edits save in one transaction. If the contact changed since the drawer opened, the save is refused and the drawer refreshes.

### 5.6 S-05 Template library
Two tabs: **WhatsApp** (below) and **Email** (email templates: name, subject, status `DRAFT`/`READY`, created by, last updated, last used; actions **New email template** → S-11, Duplicate, Edit, Delete, Send test). Email templates need no external approval; `READY` means the S-11 validation passed with no errors.

**WhatsApp tab**
- Table of synced Meta templates and local drafts: name, language, status badge (`DRAFT`, `PENDING`, `APPROVED`, `REJECTED`, `PAUSED`, `DISABLED`), quality score, created by, last updated.
- Actions: **New template**, **Sync from Meta**, Duplicate, Edit, Delete (from Meta and locally), View rejection reason.
- Status updates arrive via the `message_template_status_update` webhook; a 15-minute cron sync is the fallback.

### 5.7 S-06 Template designer (WhatsApp)
```
┌ New template ───────────────────────────────────────┬──────── Preview ─────────┐
│ Name [festive_offer_nov26 ]  Lang [en]   MARKETING  │  ┌────────────────────┐  │
│ Variables (•) Named  ( ) Positional                 │  │ [  header image  ] │  │
│─ Header ─ [Image ▾]  [Choose file…] banner.jpg      │  │ Hi Asha, our       │  │
│─ Body ─  B I S </> 😀  [+ Variable ▾]     212/1024  │  │ festive offer is   │  │
│ ┌─────────────────────────────────────────────────┐ │  │ live! Get 15% off  │  │
│ │Hi {{first_name}}, our festive offer is live!    │ │  │ ...                │  │
│ │Get {{discount}} off all orders placed this week.│ │  │ Reply STOP to unsub│  │
│ └─────────────────────────────────────────────────┘ │  │────────────────────│  │
│ Samples: first_name [Asha]  discount [15%]          │  │ ↗ View offer       │  │
│─ Footer ─ [Reply STOP to unsubscribe]       25/60   │  │ ↩ Stop promotions  │  │
│─ Buttons ─ [+ Add ▾]  ↗ View offer  ↩ Stop promos   │  └────────────────────┘  │
│ ⚠ 0 errors · 1 warning                              │  ( ) Light (•) Dark      │
│                    [Save draft]  [Submit to Meta]   │                          │
└─────────────────────────────────────────────────────┴──────────────────────────┘
```

**Editor fields**
| Field | Rules |
|---|---|
| Name | Lowercase letters, digits and `_`; ≤ 512 chars; unique; auto-slugified |
| Category | `MARKETING` (fixed) |
| Language | `en` (fixed at launch; the field exists for later) |
| Variable style | Named (`{{first_name}}`, default) or positional (`{{1}}`) |
| Header (optional) | None / Text (≤ 60 chars, max 1 variable) / Image (JPG/PNG ≤ 5 MB) / Video (MP4 ≤ 16 MB) / Document (PDF ≤ 100 MB). Media uploads go to Blob by client upload |
| Body (required) | ≤ 1024 chars; toolbar for `*bold*`, `_italic_`, `~strike~`, ` ```mono``` `; emoji picker; **Insert variable** menu (lists contact fields as suggestions) |
| Footer (optional) | ≤ 60 chars, no variables; suggested text *"Reply STOP to unsubscribe"* |
| Buttons (optional) | Up to 10 in total: Quick reply (≤ 25 chars), Visit website (static URL, or a URL with one `{{1}}` suffix), Call phone number (max 1), Copy offer code (max 1). Quick replies are grouped together, as Meta requires |
| Sample values | Required for every variable (Meta needs examples to review the template) |

**Live validation** (blocking errors in red, warnings in amber):
- E: body empty; a length limit exceeded; an invalid name; a variable without a sample; positional variables not sequential from `{{1}}`; a named variable not matching `^[a-z][a-z0-9_]*$`.
- E: the body starts or ends with a variable (Meta rejects this).
- W: too many variables for the amount of text; two variables next to each other.
- W: no opt-out wording and no "Stop promotions" quick reply (strongly recommended for marketing).
- W: a URL shortener in a button (often rejected).

**Actions:** Save draft · **Submit to Meta** (disabled without credentials or in Mock mode, where the template is approved instantly for testing) · Discard. Editing an approved template is subject to Meta's edit limits (at the time of writing, about 1 edit per 24 h and 10 per 30 days; check the current docs). An edited template goes back into review; the designer shows the last edit date.

### 5.8 S-07 Campaign wizard
Opened from the Contacts bulk action or Campaigns → New.
0. **Channel:** WhatsApp or Email (preset when opened from the split button). The channel is fixed once the campaign is created; the steps below adapt to it.
1. **Audience:** selection count, then exclusions with counts: no phone, suppressed / opted-out, **restricted country**, unknown opt-in, within the frequency cap, deleted. The final recipient count is shown in bold. For **email** the exclusions are: no email address, email suppressed (with a breakdown: unsubscribed / hard bounce / complaint / manual), email opt-in `opted_out`, email opt-in `unknown`, within the email frequency cap, deleted, and **duplicate address** (several contacts share an email: the first by `contact_id` is kept). Role addresses are shown as a warning count, not excluded.
   **Unknown consent (D15):** excluded by default on both channels. A toggle plus a typed acknowledgement can include them, up to the per-campaign limit from Settings (default 500); the rest stay excluded, earliest `contact_id` first. Contacts in a strict-consent country, or with no known country, always stay excluded. The toggle, acknowledgement, user and count are audit-logged.
2. **Template:** WhatsApp: only `APPROVED` MARKETING templates, with a preview. Email: only `READY` email templates, with a desktop/mobile preview.
3. **Variables:** each variable (header, body, URL suffix; for email also the **subject**, preheader and button URLs) maps to a contact field, an attribute, or a static value, with a **fallback** for empty values (e.g. `first_name` → "there"). Header media comes from the template's media or a new upload. Recipients where a variable stays empty with no fallback are listed and will be skipped.
4. **Preview:** step through the real rendered message for sample recipients (◀ ▶), or search for a specific contact. Email shows the inbox line (from name, subject, preheader), the rendered HTML (desktop / mobile width) and the plain-text part.
5. **Review & send:** recipients; estimated cost by country (recipients × each country's price from Settings, labelled *estimate*, with a warning for countries using the default price); estimated duration at the configured rate, including time spent waiting for each time zone's send window, with recipients per time zone and the count using the fallback zone; messaging-limit check (recipients + unique users messaged in the last 24 h compared with the tier; if over, warn and offer to split the campaign across days); **Send test** to the test number(s); timing (now / scheduled / within send window); campaign name. Confirming requires typing the recipient count.
   For **email**: estimated cost uses the price per 1,000 emails; the messaging-limit check becomes a **daily cap check** (recipients + emails already sent today compared with the daily send cap and the new-domain ramp, and emails sent this month compared with the monthly send cap; if over, warn and offer to split across days); estimated duration includes stage waits and the hourly cap; blocking checks before *Send* is enabled: API key set, domain verified, postal address set, from address on the verified domain. **Send test email** goes to the test address(es) with the subject prefixed `[TEST]`.

When the campaign is created, its recipients are **frozen** into `campaign_messages` with rendered parameters, country and time zone. Suppression, restricted countries and the frequency cap are **checked again just before each send**; recipients who fail the check become `skipped`. If another campaign **on the same channel** is already sending, the new one is `queued` and starts automatically afterwards (one sending number / one Resend rate limit per channel). A WhatsApp campaign and an email campaign can run at the same time. A campaign waiting for a time zone's window still holds its channel, so S-09 shows the expected start of queued campaigns.

### 5.9 S-08 Campaign monitor
- Header: name, template, status, started by, start time, ETA.
- Live counters (polled every 2 s while running): Pending · Accepted · Sent · Delivered · Read · Failed · Skipped · Unknown, plus a stacked progress bar. The delivered/read rate is shown as a percentage of accepted.
- **Email campaigns** show: Pending · Accepted · Sent · Delayed · Delivered · Opened · Clicked · Bounced · Complained · Failed · Skipped · Unknown, plus **Unsubscribed** (rows with `unsubscribed_at`). Rates: delivered % of accepted; opened and clicked % of delivered (opens labelled *approximate*); bounce % and complaint % of accepted, turning amber/red as they approach the circuit-breaker thresholds. A top-links table lists clicks per URL.
- Controls (any team member, audit-logged): **Pause**, **Resume**, **Cancel** (pending → skipped), **Retry failed** (retryable error codes only), **Resend unknown** (with an explanation, §8.3).
- Failures table: phone, name, error code, title, a friendly explanation, attempts. Export as CSV. For email: address, name, status (failed / bounced / complained), bounce type and sub-type, Resend error, attempts.
- An auto-pause banner shows the circuit-breaker reason (§8.5).
- A hold line explains any wait: recipients waiting by time zone and the next window, the messaging limit, the daily or hourly cap, or the email stage and its next release time.

### 5.10 S-09 Campaign list
Table with **channel** (icon + filter), name, template, status, created by, created, recipients, sent %, delivered %, read % (email: opened %, clicked %), failed % (email: bounced %), opt-outs caused (email: unsubscribes + complaints). Actions: open, duplicate (same channel, template and mapping, new audience), delete draft. The send queue is shown at the top, one queue per channel.

### 5.11 S-10 Activity log
A filterable view of `audit_log`: who did what and when (imports, undos, sends, pauses, opt-out changes on either channel, template submissions, email template changes, settings, Resend key/secret changes (never the value) and allowlist changes). Filter by channel.

### 5.12 S-11 Email template designer
```
┌ New email template ─────────────────────────────────┬──────── Preview ─────────┐
│ Name [festive_offer_nov26_email ]                   │ (•) Desktop ( ) Mobile   │
│ Subject [{{first_name}}, our festive offer is live] │ ( ) Plain text           │
│                                          38/150     │ ┌──────────────────────┐ │
│ Preheader [15% off all orders this week]   29/150   │ │ Example Exports      │ │
│─ Blocks ─ [+ Add ▾]                                 │ │ Asha, our festive... │ │
│ ⋮⋮ Image   banner.jpg  alt [Festive sale]  [link]   │ │ ──────────────────── │ │
│ ⋮⋮ Heading [Festive offer]                          │ │ [    banner image   ]│ │
│ ⋮⋮ Text    B I 🔗 [+ Variable ▾]                     │ │ Hi Asha, get 15% off │ │
│   Hi {{first_name}}, get {{discount}} off all ...   │ │ all orders ...       │ │
│ ⋮⋮ Button  [View offer] → https://example.com/o/... │ │   [ View offer ]     │ │
│ ⋮⋮ Divider                                          │ │ ──────────────────── │ │
│ Samples: first_name [Asha]  discount [15%]          │ │ Example Exports, addr│ │
│─ Footer (fixed) ─ postal address · Unsubscribe link │ │ Unsubscribe          │ │
│ ⚠ 0 errors · 1 warning                              │ └──────────────────────┘ │
│        [Save draft]  [Mark ready]  [Send test]      │                          │
└─────────────────────────────────────────────────────┴──────────────────────────┘
```
**Editor fields**
| Field | Rules |
|---|---|
| Name | Same rules as WhatsApp templates; unique among email templates |
| Subject (required) | ≤ 150 chars; variables allowed; no HTML. Shown with a 60-char "visible in most inboxes" marker |
| Preheader (optional) | ≤ 150 chars; variables allowed; rendered as hidden preview text |
| Blocks | Heading, Text (bold, italic, link, variables), Image (from Blob `email-assets/`, ≤ 1 MB, alt text required, optional link), Button (label ≤ 40, `https://` URL, variables allowed in the URL), Divider, Spacer. Drag to reorder. Max 30 blocks |
| Footer | **Fixed, cannot be removed**: business name, postal address from Settings, an *Unsubscribe* link (`{{unsubscribe_url}}`, filled per recipient, §7A.5) and a privacy notice link when one is set |
| Variables | Same named-variable syntax as WhatsApp (`{{first_name}}`), suggested from contact fields; a sample value is required for each. `unsubscribe_url` is reserved |

Rendering: blocks → React Email components → HTML (inlined CSS, max width 600 px, dark-mode safe colours) plus an auto-generated plain-text part. Variable values are **HTML-escaped** in the HTML part, inserted raw in the text part and subject; URL variables are URL-encoded.

**Live validation:**
- E: subject empty or too long; no blocks; image without alt text; button URL not `https://`; a variable without a sample; an unknown variable syntax; total HTML > 100 KB (Gmail clips above ~102 KB); `{{unsubscribe_url}}` used outside the footer.
- W: subject in ALL CAPS or with more than 2 `!`; more than 3 images or an image-only email (spam filters); a URL shortener; no preheader; a link whose text is a different URL than its target.

**Actions:** Save draft · **Mark ready** (only with 0 errors; status `READY`) · **Send test** (to the test address(es) from Settings, using the samples) · Duplicate · Discard. Editing a `READY` template keeps it `READY` if it still validates; running campaigns use their `template_snapshot_json`, so edits never change an email mid-send.

### 5.13 S-12 Unsubscribe page (public)
- Route `/u/{token}`: no sign-in (outside Clerk middleware). The token identifies the campaign message (§7A.5). A test-send token shows the same page and writes nothing.
- **GET** shows *"Unsubscribe a••••@example.com from marketing emails from Example Exports?"* with an **Unsubscribe** button. It does **not** unsubscribe on GET, because link scanners and prefetchers open links.
- **POST** (the button, or a mail client's RFC 8058 one-click `List-Unsubscribe=One-Click` POST) adds the address to `email_suppression_list` (`unsubscribe_link` or `one_click`), sets `unsubscribed_at` on the message row, writes an audit entry (`user_id = system:unsubscribe`) and shows *"You're unsubscribed. You won't receive marketing emails from us any more."* Repeating it is a no-op with the same message.
- An invalid or tampered token shows a generic page with the reply-to address to contact; nothing is written.
- Minimal, accessible page with the company name; no tracking scripts.

---

## 6. Functional Requirements

### 6.1 Import
| ID | Requirement | Acceptance |
|---|---|---|
| FR-IMP-01 | Instant browser preview; client upload to Blob for files of any size up to the limit | A 30 MB CSV uploads and previews; no 4.5 MB error |
| FR-IMP-02 | Delimiter/encoding detection with manual override | A semicolon-delimited Windows-1252 file previews correctly |
| FR-IMP-03 | Mapping grid with dropdowns, auto-suggestions and fill/unique stats | "Mobile No" is auto-mapped to Phone |
| FR-IMP-04 | Phone or email required; optional country-code column | Next is disabled until Phone or Email is mapped; a row with only a valid email imports as an email-only contact |
| FR-IMP-05 | Normalise and validate phones (§4.5) | `098765 43210` → `+919876543210` |
| FR-IMP-06 | Dedupe within the file and against the store, by policy | Re-importing the same file creates 0 new rows |
| FR-IMP-07 | Downloadable rejected rows | `reject_reason` column present |
| FR-IMP-08 | Atomic import; undo the latest import | After undo, the row count equals the count before the import |
| FR-IMP-09 | Shared mapping presets, auto-applied | Same headers → preset applied |
| FR-IMP-10 | Never re-enable opted-out or suppressed numbers | Contact stays opted-out after an import |
| FR-IMP-11 | Only one commit at a time across users | A second commit waits or shows a "busy" message |

### 6.2 Contacts
| ID | Requirement | Acceptance |
|---|---|---|
| FR-CON-01 | Paged, sortable, filterable list | 50k rows: warm page < 300 ms, cold < 1.5 s |
| FR-CON-02 | Multi-select: rows, range, page, all matching | The wizard count matches the list count |
| FR-CON-03 | Bulk tag add/remove, opt-out, delete, export | One transaction per bulk action |
| FR-CON-04 | Edit a single contact with validation | Duplicate phone is rejected |
| FR-CON-05 | Message history per contact | |

### 6.3 Templates
| ID | Requirement | Acceptance |
|---|---|---|
| FR-TPL-01 | Header/body/footer/buttons designer with a live preview | Preview updates as you type |
| FR-TPL-02 | Validation against Meta rules | An invalid name is blocked |
| FR-TPL-03 | Drafts work without credentials | |
| FR-TPL-04 | Submit to Meta; status via webhook plus cron sync | PENDING → APPROVED is shown without a manual refresh |
| FR-TPL-05 | Header media sample via the Resumable Upload API | |
| FR-TPL-06 | Sync, duplicate and delete | |

### 6.4 Campaigns & sending
| ID | Requirement | Acceptance |
|---|---|---|
| FR-CMP-01 | Wizard per §5.8, with a frozen recipient list | |
| FR-CMP-02 | Variable mapping with fallbacks and per-recipient preview | |
| FR-CMP-03 | Test send | Test message arrives on the test number |
| FR-CMP-04 | Durable, rate-limited sending (§8) | A forced step failure mid-campaign leaves no duplicates and the campaign completes |
| FR-CMP-05 | Pause / resume / cancel / retry failed / resend unknown | |
| FR-CMP-06 | Delivered/read tracking via webhook | Counters update within 10 s of the webhook |
| FR-CMP-07 | Opt-out via STOP keywords, the "Stop promotions" button, or error 131050 | Number suppressed within 5 s of the webhook |
| FR-CMP-08 | Scheduling, per-recipient send window, campaign queue | A campaign scheduled at 21:00 IST holds Indian recipients until 09:00 IST, and sends to a London recipient when it is inside 09:00–20:00 London time |
| FR-CMP-09 | Messaging-tier guard with optional split over several days | |

### 6.5 Settings & access
| ID | Requirement | Acceptance |
|---|---|---|
| FR-SET-01 | Sign-in required; allowlist only | A non-allowlisted email cannot sign in |
| FR-SET-02 | Credentials write-only and encrypted; env vars take precedence | The token never appears in API responses or logs |
| FR-SET-03 | Test connection | Shows the display number and quality rating |
| FR-SET-04 | Mock provider on local dev and previews only; forced on previews | A preview deployment never calls graph.facebook.com; production cannot select Mock or accept mock-signed webhooks |
| FR-SET-05 | Audit log of every state-changing action | |
| FR-SET-06 | Resend key read from `RESEND_API_KEY` in the environment (`.local.bin` in local dev, Vercel env vars when deployed) > encrypted Settings row > none; write-only | Adding `RESEND_API_KEY` to `.local.bin` and restarting `next dev` switches the email provider from "Not set" to "Loaded from `.local.bin`" with no other change |
| FR-SET-07 | Email Mock provider on local dev and previews only; forced on previews | A preview deployment never calls api.resend.com; production cannot select Mock or accept mock-signed webhooks |
| FR-SET-08 | S-01 shows the production app URL and both webhook URLs, read from the running deployment, each with a copy button. On a `*.vercel.app` URL it warns that production sign-in needs a custom domain. |

### 6.6 Email
| ID | Requirement | Acceptance |
|---|---|---|
| FR-EML-01 | Separate email consent (status, source, date) imported, edited and shown per contact | A WhatsApp STOP leaves email opt-in unchanged, and vice versa |
| FR-EML-02 | Email normalisation and validation (§4.6); invalid email drops the value, not the row | `" Asha@Example.COM "` → `asha@example.com` |
| FR-EML-03 | Email template designer with blocks, variables, live preview, plain-text part and validation (S-11) | Preview updates as you type; an image without alt text blocks *Mark ready* |
| FR-EML-04 | Fixed footer with postal address and unsubscribe link; one-click unsubscribe headers on every campaign email | Every sent payload has `List-Unsubscribe` and `List-Unsubscribe-Post`; the footer cannot be deleted |
| FR-EML-05 | Email campaign wizard: channel step, email exclusions, duplicate-address dedupe, daily cap check, readiness checks | Two contacts sharing an address receive one email |
| FR-EML-06 | Batch sending through Resend (`/emails/batch`, ≤ 100 per call) at the configured request rate, durable and resumable | A forced step failure mid-campaign leaves no duplicate emails and the campaign completes |
| FR-EML-07 | Idempotent retries: same batch → same `Idempotency-Key` within 24 h | A retried batch after a timeout produces no second email (Resend returns the original ids) |
| FR-EML-08 | Webhook tracking (sent, delivered, delayed, opened, clicked, bounced, complained, failed, suppressed), Svix-verified | Counters update within 10 s of the webhook; an unsigned event is not processed |
| FR-EML-09 | Hard bounces, complaints, Resend suppressions and unsubscribes suppress the address immediately | Address suppressed within 5 s; never emailed again by any campaign |
| FR-EML-10 | Public unsubscribe page; GET confirms, POST unsubscribes; signed tokens | A tampered token writes nothing; GET alone writes nothing |
| FR-EML-11 | Staged sending and email circuit breaker: bounce rate, complaint rate, auth errors | 6% bounces over 500 attempts pauses the campaign before the next stage is released |
| FR-EML-12 | Test email to configured addresses, not recorded as campaign messages | `[TEST]` email arrives at the test address |

---

## 7. Meta Graph API Integration

### 7.1 Credentials

#### 7.1.1 Required values (to be supplied later)
| Setting | Where to get it | Used for |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta Business Manager → System User → token with `business_management`, `whatsapp_business_messaging` and `whatsapp_business_management` | All calls |
| `WHATSAPP_WABA_ID` | WhatsApp Manager | Templates |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Manager → API setup | Sending, media |
| `META_APP_ID` | developers.facebook.com | Resumable upload (template samples) |
| `META_APP_SECRET` | App settings | Webhook signature check |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Generated by the app | Webhook handshake |
| `GRAPH_API_VERSION` | — | URL prefix; one place to bump it |

Use a **System User (permanent) token**; temporary tokens expire in about 24 h.
**Test-number caveat:** Meta's free test number can send to at most 5 pre-registered recipient numbers. Production sending needs an approved display name; business verification raises the messaging tiers.

#### 7.1.2 Where credentials live
Precedence: **Vercel env vars** (`vercel env add … production`, marked sensitive) > the encrypted `secrets` row in Postgres (entered on S-01; AES-256-GCM with `APP_ENCRYPTION_KEY` from env) > none (provider shows "Disconnected"). This lets a non-developer paste the token in Settings when it arrives, without a redeploy. Previews never receive production credentials.

#### 7.1.3 Provider interface
```ts
interface WhatsAppProvider {
  checkConnection(): Promise<ConnectionInfo>;
  listTemplates(): Promise<TemplateInfo[]>;
  createTemplate(t: TemplateDraft): Promise<TemplateCreateResult>;
  editTemplate(id: string, t: TemplateDraft): Promise<void>;
  deleteTemplate(name: string, hsmId?: string): Promise<void>;
  uploadSampleMedia(blobUrl: string, mime: string): Promise<string>; // header_handle
  uploadSendMedia(blobUrl: string, mime: string): Promise<string>;   // media id
  sendTemplate(to: string, payload: TemplateSend): Promise<SendResult>;
}
```
`MockProvider` simulates 50–300 ms latency, returns fake `wamid`s, fails a configurable percentage with real error codes (131026, 130429, 131049, 131050), both as immediate API errors and as later `failed` status webhooks, approves templates after 10 s, and posts **signed fake status webhooks** to its own endpoint. This tests the full pipeline, monitor included, with no credentials. Mock webhooks are signed with `MOCK_WEBHOOK_SECRET`, which exists only on local dev and previews, and production rejects them (D16). Previews post them through a Deployment Protection bypass secret.

### 7.2 Endpoints
Base: `https://graph.facebook.com/{GRAPH_API_VERSION}`. Header: `Authorization: Bearer {token}`.

| Purpose | Method & path |
|---|---|
| Phone info | `GET /{PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,throughput,whatsapp_business_manager_messaging_limit` |
| List templates | `GET /{WABA_ID}/message_templates?fields=id,name,status,category,language,components,quality_score,rejected_reason&limit=100` (follow `paging.next`) |
| Create template | `POST /{WABA_ID}/message_templates` |
| Edit template | `POST /{TEMPLATE_ID}` |
| Delete template | `DELETE /{WABA_ID}/message_templates?name={name}[&hsm_id={id}]` |
| Upload sample (session) | `POST /{APP_ID}/uploads?file_name=&file_length=&file_type=` → `upload:…` |
| Upload sample (bytes) | `POST /{upload_session_id}` with header `Authorization: OAuth {token}`, `file_offset: 0` → `{ "h": "<header_handle>" }` |
| Upload send media | `POST /{PHONE_NUMBER_ID}/media` (multipart, `messaging_product=whatsapp`) → `{id}` |
| Send message | `POST /{PHONE_NUMBER_ID}/messages` |
| Send marketing message (optional) | `POST /{PHONE_NUMBER_ID}/marketing_messages` (§7.2.1) |

#### 7.2.1 Marketing Messages API (optional)
Meta's **Marketing Messages API for WhatsApp** (formerly "MM Lite") uses the same template payload, adds delivery optimisation, and needs the WABA to be onboarded separately. You don't yet know whether yours is, so the default is `/messages`, and `send_endpoint` in Settings switches paths. Before P6, check the current docs for eligibility, the exact path and any extra statuses; map unknown statuses to `accepted`.

### 7.3 Template creation payload (named parameters)
```json
{
  "name": "festive_offer_nov26",
  "language": "en",
  "category": "MARKETING",
  "parameter_format": "NAMED",
  "components": [
    { "type": "HEADER", "format": "IMAGE",
      "example": { "header_handle": ["4::aW1hZ2UvanBlZw==:ARb..."] } },
    { "type": "BODY",
      "text": "Hi {{first_name}}, our festive offer is live! Get {{discount}} off all orders placed this week.",
      "example": { "body_text_named_params": [
        { "param_name": "first_name", "example": "Asha" },
        { "param_name": "discount", "example": "15%" } ] } },
    { "type": "FOOTER", "text": "Reply STOP to unsubscribe" },
    { "type": "BUTTONS", "buttons": [
      { "type": "URL", "text": "View offer",
        "url": "https://example.com/offer/{{1}}", "example": ["https://example.com/offer/FEST15"] },
      { "type": "QUICK_REPLY", "text": "Stop promotions" } ] }
  ]
}
```
Response: `{ "id": "<template_id>", "status": "PENDING", "category": "MARKETING" }`. Meta may re-categorise a template; store the category returned.

### 7.4 Send payload
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "template",
  "biz_opaque_callback_data": "0192f4e0-…",
  "template": {
    "name": "festive_offer_nov26",
    "language": { "code": "en" },
    "components": [
      { "type": "header", "parameters": [ { "type": "image", "image": { "id": "<media_id>" } } ] },
      { "type": "body", "parameters": [
        { "type": "text", "parameter_name": "first_name", "text": "Asha" },
        { "type": "text", "parameter_name": "discount", "text": "15%" } ] },
      { "type": "button", "sub_type": "url", "index": "0",
        "parameters": [ { "type": "text", "text": "FEST15" } ] }
    ]
  }
}
```
Success: `{ "contacts": [{ "input": "919876543210", "wa_id": "919876543210" }], "messages": [{ "id": "wamid.HBg…", "message_status": "accepted" }] }`. `accepted` only means Meta queued the message; webhooks confirm delivery. Positional templates omit `parameter_name` and follow the `{{1}}…{{n}}` order. `biz_opaque_callback_data` holds our `campaign_messages.id`; Meta returns it in status webhooks, so a status can be matched even when the `wamid` was never saved (§7.8, §8.3).

### 7.5 Media
- **Template sample** (needed at creation): the file is read from Blob and sent to the Resumable Upload API → `header_handle`.
- **Send-time media:** uploaded once per campaign to `/{PHONE_NUMBER_ID}/media` and the `id` is reused for every recipient (stored in `campaigns.send_media_id` and `send_media_uploaded_at`). Media IDs expire (about 30 days); re-upload if a campaign resumes after that. Fallback: a short-lived signed Blob URL as `link`.

### 7.6 Limits & pricing
| Limit | Behaviour |
|---|---|
| Throughput (~80 msg/s per number by default) | Token bucket at the configured rate (default 20/s) inside the send step |
| Messaging limit tier (unique users per rolling 24 h: 250 / 2k / 10k / 100k / unlimited; applied per business portfolio) | Wizard guard (§5.8); the engine holds the campaign when the 24 h unique count reaches the tier and continues when the window rolls |
| Per-user marketing cap | Error 131049 → failed; manual retry allowed only after 24 h |
| Pair rate limit | Error 131056 → retry that recipient after 60 s |
| Restricted countries | WhatsApp does not currently deliver marketing templates to US numbers. Excluded in S-07 and re-checked before each send (`skipped`, `RESTRICTED_COUNTRY`). The list is in Settings, so it can follow Meta's rules |
| Pricing | Marketing templates are charged per delivered message at a rate set by the recipient's country calling code. The estimate uses the price table in Settings, filled from Meta's rate card; actual categories come from the webhook `pricing` object |

### 7.7 Error handling
| Code | Meaning | Action |
|---|---|---|
| 0, 190 | Auth error / token expired or invalid | **Pause** campaign; banner: update the token |
| 10, 200 | Permission | Pause; show the missing permission |
| 4, 80007, 130429 | App / WABA / throughput rate limit | Retry with exponential backoff + jitter; halve the rate for 5 min |
| 131056 | Pair rate limit | Retry that recipient after 60 s |
| 131026 | Undeliverable (not on WhatsApp, old app, etc.) | Failed, not retryable |
| 131049 | Not delivered to keep the ecosystem healthy | Failed; manual retry after 24 h |
| 131050 | User stopped marketing messages | Failed; **add to suppression list** |
| 131047 | Re-engagement required | Failed (should not happen with templates) |
| 132000 | Parameter count mismatch | **Pause**: mapping bug that affects everyone |
| 132001 | Template missing / wrong language | Pause |
| 132015 / 132016 | Template paused / disabled | Pause; quality alert |
| 131031 | Account locked | Stop all campaigns |
| 368 | Temporarily blocked for policy violations | Stop all campaigns |
| 5xx / network timeout | Transient | Before the request is sent: retry up to 3 times. If it may have reached Meta: `unknown` (§8.3) |

Every failure stores `code`, `error_subcode`, `message`, `error_data.details` and `fbtrace_id`. The error table is kept as data (`lib/whatsapp/errors.ts`) so it can be updated easily. **The table applies equally to immediate API errors and to `errors[]` in a `failed` status webhook.** Codes such as 131049 arrive by webhook, so both paths use one classifier and trigger the same suppression, pause and circuit-breaker actions.

### 7.8 Webhooks
- Route: `/api/webhooks/whatsapp` on the **production domain**, excluded from Clerk middleware. Vercel Deployment Protection must not cover the production domain for this path.
- `GET`: verification handshake (`hub.mode=subscribe`, `hub.verify_token` must match, echo `hub.challenge`).
- `POST`: verify `X-Hub-Signature-256` (HMAC-SHA256 of the **raw** body with the App Secret, constant-time compare). An invalid signature returns 401 and is not processed. Insert into `webhook_events`, with the SHA-256 of the raw body as `external_id` for deduplication, process within the request (fast Postgres updates), return 200. On a processing error, still return 200 and mark the event for the reconciliation cron, so Meta does not retry endlessly.
- Subscribed fields: `messages`, `message_template_status_update`, `phone_number_quality_update`.
- Status handling: match on `biz_opaque_callback_data`, then on `wamid`, and save the `wamid` if the row lacks it. Only move status **forward** (accepted → sent → delivered → read); `failed` can override accepted/sent; `unknown` and `sending` rows are resolved by any status. When the send step later saves `accepted`, it must not lower a status a webhook already set. A `failed` status also stores its error fields and runs the §7.7 action. Update `contact_activity`.
- Inbound messages: text matching an opt-out keyword (case-insensitive, trimmed), or the quick-reply payload/text "Stop promotions", adds the number to the suppression list and writes an audit entry (`user_id = system:webhook`). No confirmation reply is sent in v1.
- **Users with no phone in the webhook:** Meta omits the phone for a user with a username unless the business number and user have messaged or called within 30 days, or the user is in the business's contact book. `from` can then be missing, while `from_user_id` holds the BSUID. Every webhook that has both a BSUID and a phone updates `whatsapp_identities`. A STOP with only a BSUID looks up the phone there. If there is none, it marks the BSUID suppressed and shows it on S-01; the phone is suppressed once a later webhook maps it. Field names follow Meta's BSUID guide; confirm them against recorded payloads in the live smoke test, because the status reference page did not list them. Sending by BSUID is out of scope for v1.
- Quality webhook dropping to **RED** pauses all campaigns and shows a banner.

---

## 7A. Resend Email Integration

### 7A.1 Credentials & the `.local.bin` file
| Setting | Where to get it | Used for |
|---|---|---|
| `RESEND_API_KEY` | resend.com → API Keys → *Create* with **Sending access**, restricted to the sending domain (`re_…`) | All Resend calls |
| `RESEND_WEBHOOK_SECRET` | resend.com → Webhooks → the endpoint's signing secret (`whsec_…`) | Webhook signature check |
| `EMAIL_UNSUBSCRIBE_SECRET` | Generated (`openssl rand -base64 32`) | Signing unsubscribe tokens (§7A.5) |
| `EMAIL_UNSUBSCRIBE_SECRETS_PREVIOUS` | Comma-separated old secrets, after a rotation | Verifying older unsubscribe links |
| `RESEND_DOMAIN_ID` | Optional; otherwise found by name from `GET /domains` | Domain status on S-01 |

**`.local.bin` (local development).** The key will be added later to a file named `.local.bin` at the project root. It is a plain dotenv-format text file, despite the extension:
```
# .local.bin — never commit (listed in .gitignore)
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
# optional, once the webhook exists
RESEND_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxx
EMAIL_UNSUBSCRIBE_SECRET=change-me
```
- Loaded once at start-up in `next.config.ts` when `NODE_ENV !== 'production'` and the file exists: parse it with `util.parseEnv` and assign each value to `process.env`, so values in `.local.bin` win over `.env*` files from `vercel env pull`. (`process.loadEnvFile` does not overwrite variables that are already set.) A missing file is not an error: the local email provider stays Mock and S-01 shows *"Not set"*.
- `.local.bin` is listed in `.gitignore`; `.local.bin.example` (committed) shows the keys with placeholder values. Because Vercel builds from Git, the file **never reaches a deployment**.
- The app remembers which variables came from `.local.bin` only to show *"Loaded from `.local.bin`"* on S-01; values are never logged.

**Precedence:** `RESEND_API_KEY` in the environment (from `.local.bin` locally, or `vercel env add RESEND_API_KEY production`, marked sensitive) > the encrypted `secrets` row entered on S-01 (AES-256-GCM with `APP_ENCRYPTION_KEY`, same as §7.1.2) > none (S-01 shows "Not set": Mock on local dev, not connected in production). Previews never receive the key and are forced to Mock.

**Domain:** sending requires a domain verified in Resend (SPF and DKIM records). Use a dedicated subdomain such as `mail.<company-domain>` and add a DMARC record (`p=none` at first). Until the domain is verified, Resend can only send from `onboarding@resend.dev` to the account owner's own address, which is enough for a first live smoke test but not for campaigns.

### 7A.2 Provider interface
```ts
interface EmailProvider {
  checkConnection(): Promise<EmailConnectionInfo>;              // domain name + status + records
  sendBatch(emails: EmailSend[], idempotencyKey: string): Promise<EmailBatchResult>; // ≤ 100
  sendOne(email: EmailSend, idempotencyKey?: string): Promise<EmailSendResult>;      // tests, split retries
  getEmail(resendId: string): Promise<EmailStatusInfo>;         // reconciliation of stuck rows
}
```
`MockEmailProvider` runs only on local dev and previews (D16). It simulates 100–400 ms latency per batch, returns fake ids (UUIDs), honours idempotency keys (same key → same ids, no new "send"), fails a configurable percentage with real error shapes (422, 429, 5xx), and posts **Svix-signed fake webhooks** to `/api/webhooks/resend`, signed with a mock-only secret that production rejects: `email.sent` → `email.delivered` for most, and configurable shares of `email.bounced` (Permanent), `email.complained`, `email.opened`, `email.clicked`. Addresses ending in `@bounce.test` always bounce and `@complain.test` always complain, so E2E tests are deterministic. Live smoke tests use Resend's own test addresses `delivered@resend.dev`, `bounced@resend.dev` and `complained@resend.dev`.

### 7A.3 Endpoints
Base: `https://api.resend.com`. Header: `Authorization: Bearer {RESEND_API_KEY}`. Use the `resend` SDK; the table is what it calls.

| Purpose | Method & path |
|---|---|
| Domain status (test connection) | `GET /domains` (then `GET /domains/{id}` for records) |
| Send batch (campaigns) | `POST /emails/batch` — array of ≤ 100 email objects; header `Idempotency-Key` |
| Send one (tests, split retries) | `POST /emails` — header `Idempotency-Key` |
| Retrieve an email (reconcile) | `GET /emails/{id}` → `last_event` |

The batch endpoint does not support attachments (not needed). Response: `{ "data": [ { "id": "…" }, … ] }`, ids in **request order**; the engine maps them back by index.

### 7A.4 Send payload
One element of the `/emails/batch` array (variables already rendered from the frozen `params_json`):
```json
{
  "from": "Example Exports <offers@mail.example.com>",
  "to": ["asha@example.com"],
  "reply_to": "sales@example.com",
  "subject": "Asha, our festive offer is live",
  "html": "<!DOCTYPE html>…Hi Asha, get 15% off…<a href=\"https://wa.example.com/u/0192f4e0…\">Unsubscribe</a>…",
  "text": "Hi Asha, get 15% off all orders placed this week.\n\nView offer: https://example.com/offer/FEST15\n\n—\nExample Exports, <postal address>\nUnsubscribe: https://wa.example.com/u/0192f4e0…",
  "headers": {
    "List-Unsubscribe": "<https://wa.example.com/u/0192f4e0…>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
  },
  "tags": [
    { "name": "campaign_id", "value": "0192f4d1-…" },
    { "name": "message_id",  "value": "0192f4e0-…" }
  ]
}
```
- Exactly **one** recipient in `to` per element (never several addresses in one email, never `cc`/`bcc`), so each person gets their own unsubscribe link and status.
- `tags` carry our ids so a webhook can be matched even when the Resend id was never stored (a step that died mid-request, §8.3). Tag names and values may contain only ASCII letters, digits, `_` and `-` (UUIDs qualify).
- `from` and `reply_to` come from Settings at campaign creation and are frozen into `template_snapshot_json`.
- Rendering is **deterministic** (same snapshot + params → byte-identical payload) so a retried batch matches its idempotency key.

### 7A.5 Deliverability & compliance
- **Unsubscribe token:** `/u/{token}` where `token = base64url(message_id) + "." + base64url(HMAC-SHA256(EMAIL_UNSUBSCRIBE_SECRET, message_id))`. Constant-time compare. Tokens do not expire, because unsubscribe links must keep working long after the send. After a rotation, old secrets stay valid for verification **indefinitely** (`EMAIL_UNSUBSCRIBE_SECRETS_PREVIOUS`).
- **Headers:** every campaign email has `List-Unsubscribe` (https URL) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). Test emails have them too, with a token signed over `test:{random}`: it verifies, shows the page and writes nothing.
- **Footer:** business name, postal address, unsubscribe link: fixed in S-11, cannot be removed.
- **Suppression:** checked at campaign creation **and** just before each batch is sent (rows → `skipped`). Hard bounce (`bounce.type = Permanent`), complaint, `email.suppressed` and unsubscribe all add to `email_suppression_list`. Transient bounces do not suppress.
- **Consent:** only `email_opt_in_status = opted_in` contacts by default; including `unknown` follows D15 (§5.8).
- **Reputation guards:** frequency cap, send window, hourly and daily caps, staged sending, the new-domain ramp and the email circuit breaker (§8.5).
- **Staged sending:** bounces and complaints come back after sending, so a fast send can finish before the breaker sees them. Each campaign releases stages of 500, 1,000, 2,000 and so on, doubling up to the hourly cap. After each stage it waits 15 minutes and evaluates the breaker before releasing the next. A campaign of 500 or fewer is one stage.
- **New-domain ramp (enforced):** the daily limit is 500 in the domain's first week of sending, 2,000 in week 2, 5,000 in week 3, 10,000 in week 4, then the daily send cap. A user can override it with an acknowledgement, which is audit-logged.

### 7A.6 Limits & pricing
| Limit | Behaviour |
|---|---|
| API rate limit (default 10 requests/s per team, all keys) | Token bucket on **requests** at the configured rate (default 2/s); 429 → exponential backoff + jitter and halve the rate for 5 min |
| Batch size (100 emails per request) | `claimBatch` takes up to 100 rows for email campaigns |
| Hourly cap and stages (§7A.5) | The engine holds the campaign until the next hour or stage. Pacing inside a stage still follows the request rate |
| Daily / monthly plan quota | Daily and monthly send caps in Settings; the wizard checks both. The engine holds the campaign at the daily cap and continues the next day (IST), and pauses it at the monthly cap with an explanation. The lowest of the daily, hourly, stage and ramp limits applies, and a held campaign keeps its email queue slot |
| Recipients per email (50) | Not used: one recipient per email |
| Idempotency key (unique per request, ≤ 256 chars, kept for 24 h) | Key = `cmp_{campaign_id}_b_{claim_token}`; see §8.3 |
| Pricing | Plan-based, per email. The estimate uses the price per 1,000 from Settings |

Check the current Resend docs for rate limits and quotas before P8; S-01 lets you change the configured rate without a redeploy.

### 7A.7 Error handling
| Response | Meaning | Action |
|---|---|---|
| 401, 403 | Key missing / invalid / restricted to another domain | **Pause** campaign; banner: update the key in `.local.bin` / env var / Settings |
| 422 / 400 for the batch | Validation error (strict batch validation rejects the whole batch) | Nothing was sent. Split the batch and send each row with `POST /emails` (key `msg_{message_id}`); rows that fail again → `failed` with the error message, not retried |
| 422 `invalid_from_address` / domain not verified | Configuration | **Pause**; banner links to S-01 domain card |
| 429 | Rate limit / quota exceeded | Rate limit: retry with backoff. Daily quota (`daily_quota_exceeded`): hold until the next day. Monthly quota: **Pause** with an explanation |
| 5xx / network timeout | Transient | Retry the **same batch with the same idempotency key** up to 3 times |
| 409 `concurrent_idempotent_requests` (the same key is still running) | Safe to retry | Wait, then retry the same batch with the same key |
| 409 `invalid_idempotent_request` (same key, different payload) | Rendering is not deterministic — a bug | **Pause**; never send under a new key automatically |

Every failure stores the HTTP status, Resend error `name` and `message` in `error_code` / `error_title` / `error_detail`. The table lives in `lib/email/errors.ts`, as data, like §7.7.

### 7A.8 Webhooks
- Route: `/api/webhooks/resend` on the **production domain**, excluded from Clerk middleware and Deployment Protection, like §7.8.
- **Verify** the Svix signature on the raw body: headers `svix-id`, `svix-timestamp`, `svix-signature`; signed content `{svix-id}.{svix-timestamp}.{raw body}`; HMAC-SHA256 with the base64-decoded part of `RESEND_WEBHOOK_SECRET` after `whsec_`; the header holds one or more space-separated `v1,<base64>` signatures and any one may match; reject timestamps more than 5 minutes from now (replay). Use the `svix` library; the goldens (RS-*) pin the behaviour.
- Insert into `webhook_events` (`source = resend`, `external_id = svix-id`; a repeated `svix-id` is a no-op), process within the request, return 200. Processing errors → still 200, retried by `reconcile-campaigns`. Invalid signature → stored with `signature_ok = false`, not processed, **401** (Svix retries; that is fine for a misconfigured secret).
- **Matching:** `data.email_id` = `resend_id`; if not found, the `message_id` tag. `unknown` and `sending` rows are resolved by any status, and saving `accepted` later must not lower a status a webhook already set. Unmatched events (e.g. test emails) are stored and ignored. Clicks also update `email_link_clicks`.
- **Status handling** (forward only, §8.1): `email.sent` → sent · `email.delivery_delayed` → delayed · `email.delivered` → delivered · `email.opened` → opened (sets `opened_at`) · `email.clicked` → clicked (sets `clicked_at`, counts the link) · `email.bounced` → bounced (`Permanent` → suppress, `Transient` → failed, not suppressed) · `email.complained` → complained + suppress · `email.failed` → failed · `email.suppressed` → failed (`resend_suppressed`) + suppress · `email.scheduled`, `email.received` and unknown types → stored, ignored. Update `contact_activity` (`last_email_at`).

---

## 7B. Meta Graph API Setup Guide

A step-by-step runbook for connecting the app to the WhatsApp Cloud API, written for the person holding admin access to the Meta business portfolio. §7 is the technical reference; this page is the order to do things in. Allow an hour for the setup itself. Display name approval and template review happen on Meta's side and can take longer.

**The live connection only works on Production.** Local dev and previews use the Mock provider (§3.5), so do Part B and Part C on the production deployment.

Meta renames dashboard labels often (a WABA may appear as a "WhatsApp account" linked to a "Messaging account"). If a label below doesn't match, go by the links in §7B.8.

### 7B.1 Before you start
| Need | Notes |
|---|---|
| Admin access to a Meta business portfolio | Can be created during Step 1. Business verification is optional to begin with, but **start it early**: new portfolios are limited to 250 recipients per 24 hours, and verification is the quickest way to raise that (§7B.7) |
| A phone number for sending (D4) | Must be able to receive an SMS or voice call for verification. A number in use on the WhatsApp or WhatsApp Business app must be deleted from it or migrated first. Optional at first: Meta's test number is enough for a first send (§7.1.1) |
| The production deployment | Deployed with `APP_ENCRYPTION_KEY` set and P6 shipped. Its domain is the webhook URL, so attach `wa.graceferroexports.com` first; changing the domain later means repeating Step 7 |
| Somewhere to keep the secrets | The token and the registration PIN are needed again later; use the team's password manager |

### 7B.2 Part A: on Meta's side
**Step 1. Create the Meta app.**
1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps), then **Create app**.
2. Enter a name and contact email, and choose the use case **Connect with customers through WhatsApp**.
3. Select the business portfolio (or create one), then **Create app**.
4. In **App settings → Basic**, copy the **App ID** (`META_APP_ID`) and **App Secret** (`META_APP_SECRET`).

**Step 2. Connect the WhatsApp Business Account.**
1. Click **Start using the API**, and in **API Setup** select an existing account or create one.
2. Copy the account ID (`WHATSAPP_WABA_ID`).

**Step 3. Add the sending number.**
- *First test only:* in **API Setup**, use the test number and add up to 5 recipient numbers. Copy its **Phone number ID**, then skip Step 5.
- *Real number:* in **WhatsApp Manager → Phone numbers**, add the number, set the display name and verify it with the code. Copy its **Phone number ID** (`WHATSAPP_PHONE_NUMBER_ID`). This is not the phone number itself.

**Step 4. Create the permanent token.** The token on the API Setup page expires quickly, so don't use it in the app.
1. In **Business settings → Users → System users**, click **Add** and create a user with the **Admin** role.
2. Click **Assign assets**, select the app and grant **Manage app** (Full control). Reload to confirm it took effect; this can take a few minutes.
3. Assign the WhatsApp account too, with Full control. In Business Suite, assign both the WhatsApp account and the Messaging account if both are listed. Missing access shows up later as error 200.
4. Click **Generate token**, select the app, set expiry to **Never**, and tick `business_management`, `whatsapp_business_management` and `whatsapp_business_messaging`.
5. Copy the token straight away (`WHATSAPP_ACCESS_TOKEN`).

**Step 5. Register the number for Cloud API** (real number only). This call isn't made by the app, so run it once by hand. `pin` is a new 6-digit two-step verification PIN, or the existing PIN if two-step verification is already on:
```bash
curl -X POST "https://graph.facebook.com/$GRAPH_API_VERSION/$WHATSAPP_PHONE_NUMBER_ID/register" \
  -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"<6-digit-pin>"}'
```
Expect `{"success":true}`. Registration is limited to 10 requests per number in 72 hours; going over returns error 133016 and blocks the number for 72 hours. Register again after any display name change, once Meta has approved the new name.

### 7B.3 Part B: in the app
**Step 6. Enter the credentials.** Open **S-01 Settings → WhatsApp connection** on Production and use one of these (§7.1.2 has the precedence):

| Option | How | Applies |
|---|---|---|
| Settings screen (no developer needed) | Paste the values and save. The token and App Secret are encrypted and can't be read back | Immediately |
| Vercel env vars | `vercel env add WHATSAPP_ACCESS_TOKEN production`, marked sensitive, and the same for each value in §7.1.1 | After a redeploy |

Then:
1. Set the **Graph API version** to the current one (`v26.0` at the time of writing).
2. Production always uses the Graph API provider, so there is no provider to choose here.
3. Click **Test connection**. It should show the display number, verified name, quality rating and messaging limit. If it doesn't, see §7B.6.

**Step 7. Connect the webhook.** Sending works without this, but status updates, template approvals and STOP opt-outs all arrive through it. Save the App Secret first, or signature checks will fail.
1. From the **Webhook setup card** on S-01, copy the callback URL (`https://<prod-domain>/api/webhooks/whatsapp`) and the verify token.
2. In the Meta app, open **Use cases → Customize → Configuration** (older apps: **WhatsApp → Configuration**), paste both and click **Verify and save**. Meta calls the app's `GET` handshake at this point (§7.8).
3. Under **Webhook fields**, subscribe to `messages`, `message_template_status_update` and `phone_number_quality_update`.
4. Link the WhatsApp account to the app. The dashboard doesn't always do this, and without it real events never arrive even though the dashboard's **Test** button works:
   ```bash
   curl -X POST "https://graph.facebook.com/$GRAPH_API_VERSION/$WHATSAPP_WABA_ID/subscribed_apps" \
     -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"
   ```
   Expect `{"success":true}`. A `GET` on the same path lists the subscribed apps.
5. Switch the app to **Live** mode at the top of the dashboard, filling in anything it asks for, such as a privacy policy URL. Some webhooks are not sent while the app is in Dev mode.

An app that only uses the portfolio's own WhatsApp account doesn't need Advanced access, which is for acting on other businesses' accounts. If the dashboard asks for App Review, follow what it lists.

### 7B.4 Part C: confirm it works
Do these in order, using a phone the team controls. They match evals LIVE-01…04.

| # | Do this | Expect |
|---|---|---|
| 1 | S-01 → **Test connection** | Display number, verified name, quality rating and messaging limit |
| 2 | S-06 → submit a small test template to Meta | `PENDING`, then `APPROVED` or `REJECTED` with no manual refresh. This proves the webhook works; the card on S-01 shows the time of the last event |
| 3 | S-07 → **Send test** with the approved template, to a test phone number from S-01 | The message arrives on the phone, and the `delivered` webhook updates its row |
| 4 | Reply `STOP` from that phone | The number is on the suppression list within 5 s, with an S-10 entry from `system:webhook` |
| 5 | Remove that number from the suppression list if it will be used again, then send a small real campaign | Passes the messaging-limit check in S-07, and S-08 moves through accepted → sent → delivered → read |

### 7B.5 Going from the test number to the real number
1. Do Step 3 (real number) and Step 5.
2. Replace `WHATSAPP_PHONE_NUMBER_ID` on S-01 and click **Test connection**.
3. Repeat checks 3 and 4 of §7B.4. The token, webhook and WhatsApp account link stay the same if the number is on the same account.

### 7B.6 Troubleshooting
| Symptom | Likely cause | Fix |
|---|---|---|
| Error 190 | Token expired, revoked, or the temporary one from API Setup | Repeat Step 4 and update the token |
| Error 200 or 10 | System user lacks access to the app or account, or a permission is missing | Repeat Step 4 parts 2–4, then generate a new token |
| Error 133010 (account not registered) | Step 5 was skipped | Run Step 5 |
| Error 133016 | Too many registration attempts | Wait 72 hours |
| Error 131030 (recipient not allowed) | Test number sending to a number not on its recipient list | Add the recipient in API Setup, or move to the real number |
| "Verify and save" fails | Verify token mismatch, route blocked by Vercel Deployment Protection or Clerk, or the URL is a preview deployment | Copy the token again; check §7.8; use the production domain |
| Dashboard **Test** works but real events never arrive | The WhatsApp account isn't linked to the app, or the app is in Dev mode | Step 7 parts 4 and 5 |
| Events are stored with `signature_ok = false` and not processed | App Secret is wrong or from a different app | Copy it again from **App settings → Basic** |
| Template stays `PENDING` | Review is still running, or the webhook isn't connected | Click **Sync from Meta** on S-05; if the status changes, fix the webhook |
| Campaign pauses with a token banner | Token was revoked or rotated | Update the token on S-01, then resume |

Quote `fbtrace_id` (stored with every failure, §7.7) when contacting Meta support.

### 7B.7 After go-live
- **Messaging limit:** new portfolios start at 250 unique recipients per 24 hours. To reach 2,000, verify the business, or deliver 2,000 template messages outside customer service windows to unique numbers within 30 days using high-quality templates; Meta then reviews message quality. Later increases are automatic while quality stays high and at least half the limit has been used in the past 7 days.
- **API version:** `GRAPH_API_VERSION` is the only place to change it. Re-run the contract tests (LIVE-05) and §7B.4 after each change.
- **Token rotation:** generate the new token, update S-01 or the env var, and click **Test connection**. Revoke the old one afterwards. Rotate immediately if a leak is suspected.
- **Quality:** watch the rating on S-01. A drop to RED pauses all campaigns (§7.8).

### 7B.8 Meta documentation
[Get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started) · [Access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens) · [Phone number registration](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration) · [Webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview) · [Messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits) · [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog)

---

## 8. Sending Engine

### 8.1 Message state machine
```
pending ──► claimed ──► sending ──► accepted ──► sent ──► delivered ──► read
   │                      │            └──────────┴──► failed
   │                      ├──► retry_wait ──► claimed
   │                      ├──► failed
   │                      └──► unknown (step died mid-request) ──► webhook resolves | manual resend
   └──► skipped (cancel / suppressed / frequency cap / empty variable)
```
**Email messages** use the same claim/sending/unknown/retry states up to `accepted` (Resend returned an id), then:
```
accepted ──► sent ──► delayed ──► delivered ──► opened ──► clicked
   │           │         │            │
   │           │         │            └──► bounced (Permanent, async)     complained ◄── any state after accepted
   └───────────┴─────────┴──► bounced | failed
```
Precedence rank: accepted < sent < delayed < delivered < opened < clicked; a lower status never replaces a higher one (timestamps are still recorded). `bounced` and `failed` replace accepted / sent / delayed; `bounced` also replaces `delivered` (bounces can arrive after the receiving server first accepted), but not opened or clicked. `complained` replaces **every** post-accepted status, `bounced` included, because it must be counted and acted on; nothing replaces `complained`. Nothing but `complained` replaces `bounced` or `failed`. `unknown` is resolved by any status.

**Claims:** a `claimed` row whose `claimed_at` is more than 10 minutes old, with no live claim from the current run, returns to `pending`, so a dead run cannot strand it. Manual actions move `failed` (retryable codes only) and `unknown` rows back to `pending`.

### 8.2 Campaign workflow (Vercel Workflow)
One durable run at a time per campaign; only one campaign **per channel** is `running` at a time, enforced by a partial unique index on `campaigns(channel) WHERE status = 'running'`. The same workflow serves both channels; the channel picks the provider, batch size (WhatsApp 50, email 100) and pacing. The sketch below is illustrative; §8.7 defines the states.
```ts
export async function runCampaign(campaignId: string, runToken: string) {
  "use workflow";
  await prepareMedia(campaignId, runToken);           // step: upload header media once
  for (let n = 0; n < 1000; n++) {                    // hand off to stay under run limits
    const s = await loadControlState(campaignId, runToken); // step: ownership, heartbeat, status, open zones, holds
    if (s.action === "exit") return;                  // paused, cancelled or superseded
    if (s.action === "wait") {
      if (s.waitMs > FIVE_MINUTES) return await park(campaignId, runToken, s.waitUntil); // step: store wait_until, end run
      await sleep(s.waitMs);
      continue;
    }
    const batch = await claimBatch(campaignId, runToken, s.batchSize, s.openZones); // step: pending|due retry → claimed
    if (batch.length > 0) {
      await sendBatch(campaignId, runToken, batch);   // step: rate-limited sends, per-row persistence
    } else if (await finalizeIfDone(campaignId, runToken)) { // step: only when no pending/claimed/sending/retry_wait rows
      await startNextQueuedCampaign(s.channel);       // step
      return;
    } else {
      await sleep("30s");                             // rows waiting on a retry or claim expiry
    }
  }
  await handOff(campaignId, runToken);                // step: new run_token, starts a new run
}
```
- **Ownership:** every run has a `run_token`, stored on the campaign. Every step checks it, and a run whose token no longer matches exits. Starting a run always sets a new token in a transaction, so duplicate runs cannot accumulate.
- **Heartbeat:** `loadControlState` updates `heartbeat_at`. Webhooks do not, so they cannot hide a dead run.
- **Long waits end the run.** A wait of over 5 minutes stores `wait_until` and `wait_reason`, keeps the status `running` and ends the run. `reconcile-campaigns` starts a new run when it is due, so resumes can be up to 5 minutes late. New runs pick up the latest deployment, which pinning would otherwise prevent during a long wait.
- **Send window:** `loadControlState` finds which recipient time zones are inside the window, using the §5.2 rule for each zone. `claimBatch` claims rows in those zones only. If none are open, the wait is until the earliest window among zones with remaining rows.
- **Rate limit:** the token bucket is the `rate_limits` row for the channel, reserved atomically, so it holds across instances, runs and test sends. Halving the rate after a rate-limit error is stored there too.
```
- `sendBatch`: for each claimed row: re-check suppression, restricted countries and the frequency cap (→ `skipped`), set `sending` (commit), call the provider, then persist `accepted`+`wamid` / `retry_wait`+`next_attempt_at` / `failed`. Pacing uses the shared rate limit; at 20/s a 50-row batch takes about 2.5 s, well inside step limits.
- `sendBatch` for **email**: re-check email suppression and the email frequency cap for every row (→ `skipped`), render the remaining rows, set them all to `sending` with `batch_key = cmp_{campaign_id}_b_{claim_token}` (commit), make **one** `POST /emails/batch` with that `Idempotency-Key`, then persist `accepted` + `resend_id` per row by index. A retry selects the rows by `batch_key`, ordered by `id`, so the request is byte-identical. One request per batch; the rate limit paces requests, not emails. `loadControlState` also applies stages, the hourly cap and the daily cap (§7A.5).
- **Pause / cancel:** the API sets the campaign status. The workflow notices it at the next loop iteration (within one batch, about 3 s). Cancelling starts the next queued campaign. Pausing releases the channel slot too; **Resume** re-enters the queue and starts a new run when the slot is free.
- **Scheduling:** a scheduled campaign has no run while it waits. `reconcile-campaigns` starts it when `scheduled_at` passes, or queues it if the channel is busy, so it uses the latest deployment.
- **Fixing a bad deployment:** a run stays on its deployment, so a bug fix does not reach it. Pause the affected campaign and resume it; the new run uses the fixed deployment.

### 8.3 Crash & retry safety
- If a `sendBatch` step is retried by Workflow (after a timeout or instance failure), rows still `claimed` are sent normally. Rows found in `sending` are **ambiguous**: the request may have reached Meta. They become `unknown` and are **not** resent automatically, because a duplicate marketing message is worse than a missed one.
- A later webhook resolves `unknown` rows. The monitor offers **Resend N unknown** as an explicit, audit-logged action.
- **Email is different:** Resend honours idempotency keys for 24 h. Rows found in `sending` whose `batch_key` is younger than 23 h are resent as the **same batch, re-rendered byte-identically, with the same key**; Resend returns the original ids and sends nothing twice. Only rows whose key is older than 23 h become `unknown`. Their webhooks are still matched through the `message_id` tag, and `reconcile-emails` (§10) cannot look them up by id (none was stored), so they stay `unknown` until a webhook arrives or a user chooses **Resend N unknown**.
- The reconciliation cron (§10) catches runs that died: a `running` campaign with no `wait_until` and a `heartbeat_at` older than 10 minutes gets a new `run_token` and a new run. Campaigns with a future `wait_until` are left alone.

### 8.4 Idempotency
- `UNIQUE(campaign_id, contact_id)`: one message per contact per campaign.
- Claims use a `claim_token` (`UPDATE … SET status='claimed', claim_token=$t WHERE status='pending' … FOR UPDATE SKIP LOCKED`), so two runs can never claim the same row.
- Webhook processing is idempotent (forward-only status; `webhook_events` deduplicated by `external_id`).

### 8.5 Circuit breaker
Auto-pause if, over the last 200 attempts with a known outcome, the failure rate is above 25% (configurable), on any "Pause" code in §7.7, or on a RED quality webhook. Failures from `failed` status webhooks count alongside immediate errors, and the engine checks the rate before each batch.
**Email:** auto-pause if, over the last 500 accepted emails (evaluated once at least 100 have a final delivery status), the hard-bounce rate is above 5% or the complaint rate is above 0.3% (both configurable), or on any "Pause" response in §7A.7. The engine evaluates this before releasing each stage (§7A.5). A complaint rate above 0.3% across all email campaigns in the last 7 days blocks new email campaigns until a user acknowledges it; the acknowledgement is stored in `settings` and audit-logged. The reason is stored in `campaigns.pause_reason` and shown on S-08.

### 8.6 Progress reporting
`GET /api/campaigns/{id}/stats` returns counts by status from an indexed `GROUP BY` (email: plus unsubscribes and per-link clicks). S-08 polls it every 2 s while the campaign runs and every 30 s afterwards (webhooks keep arriving for days).

### 8.7 Campaign states
| From | To | When |
|---|---|---|
| `draft` | `scheduled` / `queued` / `running` | **Start**, depending on the schedule and whether the channel is free. Recipients are frozen at creation, and re-checked before each send |
| `scheduled` | `queued` / `running` | `scheduled_at` passes |
| `queued` | `running` | The channel is free; oldest first |
| `running` | `paused` | User, circuit breaker or a "Pause" code. Releases the channel |
| `paused` | `queued` / `running` | **Resume**. A user must first clear the cause shown in `pause_reason` for 131031, 368, RED quality or a domain failure |
| `draft` / `scheduled` / `queued` / `running` / `paused` | `cancelled` | **Cancel**: remaining rows → `skipped` |
| `running` | `completed` | No `pending`, `claimed`, `sending` or `retry_wait` rows. `unknown` rows may remain |
| `completed` / `cancelled` | `queued` / `running` | **Retry failed** or **Resend unknown**, for the rows it returns to `pending` |
| `running` | `failed` | A non-recoverable engine error, such as a missing template snapshot |

---

## 9. Backend API
Next.js route handlers under `/api`. JSON. Every route needs a Clerk session **except** `/api/webhooks/*` (signature-verified), `/api/cron/*` (`Authorization: Bearer $CRON_SECRET`) and the public unsubscribe route `/u/{token}` (signed token, §7A.5).

| Method | Path | Description |
|---|---|---|
| POST | `/imports/upload-token` | Client-upload authorisation for Blob (size and type checks) |
| POST | `/imports` | Register an uploaded file `{blob_path, file_name, sha256}` → `{import_id, duplicate_of?}` |
| POST | `/imports/{id}/analyze` | Detection + column stats + suggestions |
| POST | `/imports/{id}/validate` | Mapping + options → summary |
| GET | `/imports/{id}/rejects` | Signed download URL |
| POST | `/imports/{id}/commit` | Policy + consent → import transaction |
| GET | `/imports/{id}` | Status / result |
| POST | `/imports/{id}/undo` | Revert the latest import |
| GET | `/contacts` | `?q=&filters=&sort=&page=&page_size=` → `{items, total}` |
| POST | `/contacts` | Add one contact from the S-03 form |
| POST | `/contacts/count` | Selection object → count after exclusions |
| GET / PATCH / DELETE | `/contacts/{id}` | Single contact |
| POST | `/contacts/{id}/erase` | Immediate erasure (§12A) |
| GET | `/contacts/{id}/export` | One contact's data, for an access request (§12A) |
| GET / POST | `/snapshots` | List / create a snapshot |
| POST | `/snapshots/{version}/restore` | Restore, with confirmation |
| POST | `/contacts/bulk` | `{selection, action, args}` — tag_add, tag_remove, opt_out, delete, export |
| GET / POST / DELETE | `/mapping-presets` | |
| GET / POST | `/templates` | List / create draft; `?channel=whatsapp\|email` |
| PUT / DELETE | `/templates/{id}` | |
| POST | `/templates/{id}/submit` | Submit to Meta (WhatsApp only) |
| POST | `/templates/{id}/ready` | Validate and mark an email template `READY` |
| POST | `/templates/{id}/render` | Email: `{contact_id?}` → `{subject, preheader, html, text}` (samples when no contact) |
| POST | `/email-assets/upload-token` | Client upload for email images |
| POST | `/templates/sync` | Pull from Meta |
| POST | `/media/upload-token` | Client upload for header media |
| POST | `/campaigns` | `{channel, selection, template_id, mapping, schedule, name}` → frozen campaign |
| GET | `/campaigns` · `/campaigns/{id}` · `/campaigns/{id}/stats` | |
| GET | `/campaigns/{id}/messages` | Paged, filter by status |
| POST | `/campaigns/{id}/preview` | `{contact_id}` → rendered message |
| POST | `/campaigns/test-send` | Template + mapping → test number(s), or test email address(es) for an email template |
| POST | `/campaigns/{id}/start` · `/pause` · `/resume` · `/cancel` · `/retry-failed` · `/resend-unknown` | |
| GET | `/suppression` · POST · DELETE (with reason) | `?channel=whatsapp\|email` (default whatsapp) |
| GET / PUT | `/settings` | Non-secret settings |
| PUT | `/settings/credentials` | Write-only (Meta credentials, Resend API key, Resend webhook secret) |
| POST | `/settings/test-connection` | `{channel}` |
| GET | `/settings/email-domain` | Domain status and DNS records from Resend |
| GET / POST / DELETE | `/team` | Allowlist |
| GET | `/audit` | Paged activity log |
| GET / POST | `/webhooks/whatsapp` | Meta webhook |
| POST | `/webhooks/resend` | Resend webhook (Svix-signed) |
| GET / POST | `/u/{token}` (page route, not under `/api`) | Unsubscribe confirm / unsubscribe (also the RFC 8058 one-click target) |
| GET | `/cron/{job}` | §10 |

**Selection object**
```json
{ "mode": "ids", "ids": ["01J…", "01J…"] }
{ "mode": "filter", "filter": { "tags_any": ["steel"], "opt_in": ["opted_in"] }, "q": "", "exclude_ids": ["01J…"] }
{ "mode": "filter", "filter": { "has_email": true, "email_opt_in": ["opted_in"] }, "q": "", "exclude_ids": [] }
```

---

## 10. Scheduled Jobs (Vercel Cron, configured in `vercel.ts`)
| Job | Schedule | Purpose |
|---|---|---|
| `sync-templates` | every 15 min | Pull template statuses (fallback for the webhook) |
| `snapshot-contacts` | daily until the plan allows hourly (T5.13), then hourly | Write a Parquet snapshot if `contact_revision` has changed (§4.2) |
| `reconcile-campaigns` | every 5 min | Start runs whose `wait_until` or `scheduled_at` has passed; resume stalled runs; reprocess failed webhook events (both sources); start queued campaigns on each channel |
| `reconcile-emails` | every 15 min | For email rows `accepted` > 2 h with no webhook, `GET /emails/{id}` and apply `last_event` (covers missed webhooks and local dev without a public URL); max 500 lookups per run |
| `check-email-domain` | hourly | Refresh the Resend domain status; a domain that drops out of `verified` pauses email campaigns and shows a banner |
| `cleanup` | daily 02:00 IST | Delete snapshots > 30 days, import sources and rejects > 7 days, exports > 24 h, orphan blobs, unused `email-assets/` older than 1 year; trim `webhook_events` > 90 days; apply the §12A retention and purge rules |

---

## 11. Non-Functional Requirements
| Area | Target |
|---|---|
| Import | 50k rows (10 columns): validate + commit < 60 s |
| Contacts list | Warm page < 300 ms, cold < 1.5 s at 50k contacts |
| Send throughput | WhatsApp: configured rate ±10%. Email: configured batch request rate ±10% within a stage (default 2 req/s × 100 = up to 200 emails/s), with stages and the hourly cap on top |
| Reliability | No duplicate sends or emails (§8.3); no lost contact writes (§4.2); webhooks acknowledged in < 2 s |
| Concurrency | ≤ 10 team members at once; imports and restores serialised; a bulk action never takes more than 10 s at 50k rows |
| Availability | Vercel platform SLA; credentials-missing and Mock states degrade gracefully |
| Browsers | Latest Chrome, Edge, Firefox, Safari; layout usable on a tablet |
| Accessibility | Keyboard-operable grids and wizards; WCAG AA contrast |
| Observability | Structured logs with tokens and API keys redacted (`re_…` never logged), phones masked (`+91******3210`) and emails masked (`a••••@example.com`); Vercel Observability; custom metrics for sends/failures per minute |

---

## 12. Security, Privacy & Compliance
- **Authentication:** Clerk with an allowlist and public sign-up disabled. Sessions on every page and API route except webhooks and crons.
- **Webhooks:** Meta: HMAC signature verified on every POST. Resend: Svix signature + 5-minute timestamp tolerance verified on every POST. Invalid events are stored but not processed. **Cron:** checked against `CRON_SECRET`.
- **Unsubscribe route:** public but HMAC-signed tokens; GET never writes; rate-limited by Vercel Firewall; reveals only a masked address.
- **Secrets:** sensitive env vars or encrypted Postgres rows; never returned by the API; redacted in logs. The Resend key lives in `.local.bin` locally (git-ignored, never deployed) and in Vercel env vars in production; use a **sending-only** key restricted to the sending domain. Previews have no production secrets and are forced to Mock on both channels.
- **Blob:** a private store, plus a separate public store for `email-assets/` only. Downloads (rejects, exports, media) use short-lived signed URLs issued after a session check. A signed URL works for anyone holding it and cannot be revoked, so keep expiries short.
- **Data isolation per environment:** separate Neon branch and Blob prefix for previews, so production contacts never appear on preview URLs.
- **CSV export injection:** cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`; phones are exported as text.
- **Upload limits:** size, row count (200k) and column count (200) capped; CSVs are parsed as data only.
- **Consent:** importing as `opted_in` requires the confirmation checkbox (user + time stored). Proof is kept outside the app (D6), with an optional reference on the contact. Including `unknown` contacts follows D15.
- **Opt-out:** suppression lists are the authority, checked at freeze **and** at send time; STOP keywords, the button and error 131050 are all honoured for WhatsApp; unsubscribe link, one-click unsubscribe, hard bounces, complaints and Resend suppressions for email.
- **Email sender rules:** SPF, DKIM and DMARC on the sending subdomain; one-click unsubscribe; postal address in every email; complaint rate kept under 0.3% (§8.5).
- **Privacy:** contacts are personal data; §12A has the rules, retention and data-subject actions.
- **Rate safety:** frequency cap, send window, circuit breaker and tier guard reduce the risk of being blocked and of a lower quality rating.

---

## 12A. International Privacy & Marketing Rules
Recipients are mostly overseas (D14). This section sets product behaviour; it is not legal advice. **Have counsel review it for your main recipient countries before the first send.**

### 12A.1 Regional defaults
| Region | Main rules to check | Product behaviour |
|---|---|---|
| EU/EEA, UK and the Crown Dependencies (GG, JE, IM) | GDPR / UK GDPR or local equivalents, ePrivacy marketing rules: a lawful basis, usually prior consent for marketing; access and erasure rights; international transfer safeguards | Strict-consent: `unknown` always excluded. Consent source, date and proof reference recorded. `libphonenumber` reports these +44 ranges as GG, JE or IM, so they need their own entries |
| Sri Lanka, Indonesia, the Gulf, other Southeast Asia and Africa | Check per country, for example Sri Lanka PDPA 2022, Indonesia PDP Law 2022, UAE and Saudi PDPL, Singapore PDPA, Nigeria NDPA, Kenya DPA | Not strict by default. Counsel decides which to add to the strict list |
| Canada | CASL: consent, sender identification, working unsubscribe | Strict-consent. Fixed email footer |
| United States | CAN-SPAM for email: accurate headers, postal address, working opt-out | Fixed footer and one-click unsubscribe. WhatsApp marketing templates undeliverable (C14) |
| India | DPDP Act 2023 and DPDP Rules 2025, phased in through 2027 | Same retention and erasure tools as everywhere |
| Other / no known country | Local law varies | `unknown` always excluded when the country is unknown. Add countries to the strict list as needed |

The strict-consent list is editable in Settings, and its changes are audit-logged.

### 12A.2 Retention
| Data | Kept for |
|---|---|
| Source CSVs and `rejects.csv` | 7 days |
| Exports | 24 hours |
| Parquet snapshots | 30 days |
| Soft-deleted contacts | Purged after 30 days |
| `webhook_events` | 90 days; inbound message text is removed from `payload_json` once processed |
| `campaign_messages` phone, email and `params_json` | 24 months (configurable), then set to null; statistics remain, and an unsubscribe link then resolves the address through `contact_id` |
| Suppression lists | Until manually removed, because they are what keeps an opt-out honoured |
| `audit_log` | 24 months (configurable) |

### 12A.3 Data-subject actions
- **Access:** S-04 exports one contact's data, with their message history and consent records.
- **Erasure:** **Erase now** hard-deletes the contact, sets the personal fields on their `campaign_messages` to null, and adds the ID to `contact_erasures`, so restores skip it. Snapshots age out within 30 days. A suppression entry stays when the person opted out, and the audit log records the action with no personal data.
- **Delete** remains a soft delete, leaving audiences immediately and purged after 30 days.

### 12A.4 Transfers and vendors
Contact data reaches Vercel, Neon, Clerk, Resend and Meta, some outside the recipient's country. Keep a list of these vendors, sign their data processing terms, and check that the privacy notice linked from the email footer names them.

---

## 13. Testing Strategy
| Level | Coverage |
|---|---|
| Unit (Vitest) | Phone normalisation table (Indian formats, trunk 0, `00`, Excel cases); mapping engine; contact matching (§4.7); dedupe policies; time-zone and per-zone send window; template validator; payload builder (named and positional); status precedence; error classifier; email normalisation; email template validator and renderer (escaping, deterministic output); email status precedence; Svix signature check; unsubscribe tokens |
| Integration | Contact transactions against a real Neon branch (concurrent imports, undo, restore, erasure); snapshots against Blob; SQL filters; claim/`SKIP LOCKED`; webhook signature, including failures arriving by webhook and BSUID-only opt-outs |
| Workflow | `runCampaign` with MockProvider: pause/resume, cancel, step retry → `unknown`, parking and restart, duplicate-run exit, claim expiry, retry-wait finalisation, per-zone windows, email stages, queueing |
| Contract | Recorded Graph API responses for success and every §7.7 error, replayed with MSW; recorded Resend responses for every §7A.7 row and every webhook event type |
| E2E (Playwright, on preview deployments) | Sign-in → import → map → validate → commit → filter → select all → campaign in mock mode → monitor reaches 100% with simulated delivered/read |
| Live smoke (once credentials arrive) | Test connection; submit a test template; send to the test number; receive the delivery webhook; STOP reply suppresses the number |
| Live email smoke (once the key is in `.local.bin` / env) | Test connection shows the domain verified; send to `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`; webhooks update the rows and suppress the last two; Gmail "Unsubscribe" one-click works |

**Test harness (built in P1):** a controllable clock usable inside Workflow steps, fault injection to kill a step at a chosen row, Clerk test users on previews, a Deployment Protection bypass for Playwright, database seeding and reset per test branch.

Fixtures: CSVs with BOM, semicolons, quoted newlines, Excel scientific notation, duplicates; email-only rows; overseas numbers; a generated 50k-row file.

---

## 14. Delivery Plan
| Phase | Deliverables | Needs Meta credentials? |
|---|---|---|
| P1 Foundation | Next.js project, `vercel link`, Marketplace installs (**Clerk, Neon**) + **Blob** stores, env vars, CI and PR checks, deploy-time migrations, test harness, **spike** (Vercel Workflow crash, pinning and limits; Parquet writer; private and public Blob), Drizzle migrations, auth + allowlist, layout, audit log | No |
| P2 Import | S-02 wizard, client upload, ContactStore, contact matching, country and time zone, presets, undo, snapshots | No |
| P3 Contacts | S-03 list, filters, selection model, S-04 drawer, bulk actions, export | No |
| P4 Templates (offline) | S-05/S-06 designer, validator, preview, drafts | No |
| P5 Campaigns (mock) | Provider interface, MockProvider + simulated webhooks, S-07 wizard, Workflow engine, S-08/S-09, crons | No |
| P6 Meta integration | GraphApiProvider, test connection, template submit/sync, media upload, production webhook, live sends | **Yes** |
| P7 Live STOP flow & hardening | STOP flow, move to the real number, quality alerts, circuit-breaker tuning, load test with 50k mock sends | Yes |
| P8 Email (mock) | §4.6 normalisation in the send path, S-11 designer + renderer, email tab on S-05, channel step in S-07, staged sending, MockEmailProvider + signed fake webhooks, `/api/webhooks/resend`, S-12 unsubscribe page, email suppression, `.local.bin` loading, S-01 Email section. Email consent columns already exist from P2 | No (can start right after P5) |
| P9 Email live | ResendProvider, domain verification on S-01, register the Resend webhook, live email smoke, 50k mock-email load test | **Resend API key** in `.local.bin` (local) / env var (prod) and a verified domain |

**Start these outside the build, because they have lead time:** choose the production domain (needed for Clerk production and webhooks), set up Google OAuth credentials if Google sign-in is used, begin Meta business verification, and get legal review of §12A.

---

## 15. Open Questions
Resolved on 2026-10-30: default country (IN), one sending number, webhooks on Vercel, English only, equal-access team, opt-in proof outside the app, standard `/messages` endpoint, under 50k contacts. See §2.1.

Resolved on 2026-11-02: sign-in uses email code and Google; the STOP flow sends no confirmation reply; email-only contacts are allowed (D13); `.local.bin` stays the file name; contact store, recipients and `unknown` consent (D2, D14, D15).

Answered on 2026-11-02:
- **Q1.** Production runs on Vercel at `wa.graceferroexports.com`, which Clerk production sign-in needs. The app shows its URLs to copy (FR-SET-08).
- **Q4.** The project owner checks Marketing Messages API eligibility with Meta before P6.
- **Q7.** Business name **Grace Ferro Exports**; postal address **Door No 29-12, Second floor, RS Plaza, Palakkad Main Road, Kasturi Nagar, Kuniamuthur PO, Coimbatore 641008, Tamil Nadu, India**, from the company website; privacy notice https://graceferroexports.com/privacy-policy. These are the Settings defaults. As of 2026-11-02 the notice doesn't cover marketing messages, how to opt out of them, or this app's providers (Resend, Vercel, Neon, Clerk). Update it before the first real campaign.
- **Q6.** Sending subdomain `mail.graceferroexports.com`, from `offers@mail.graceferroexports.com`, reply-to `info@graceferroexports.com`. These are the Settings defaults.
- **Q8.** Resend **Free** plan to start: 100 emails per day, 3,000 per month and 1 webhook endpoint, checked on resend.com/pricing on 2026-11-02. The one endpoint goes to production, so local dev relies on the `reconcile-emails` cron. Larger campaigns need a paid plan; raise both caps in Settings after upgrading.
- **Q10.** Main regions are listed in D14. Add their countries to the price table from Meta's rate card, and include them in the legal review.
- **Q11.** English only for v1 (D5).
- **Q12.** The team is in India, so `Asia/Kolkata` stays. Functions moved from `bom1` to `sin1` on 2026-11-02, to sit next to the database (§3.1).

No questions remain open. Numbers are kept stable because `TASKS.md` refers to them.

---

## 16. Risks & Mitigations
| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Lists without real opt-in cause blocks and a RED quality rating | Number restricted | Consent gate, per-campaign limit and strict-consent countries for `unknown` contacts, suppression list, frequency cap, circuit breaker, STOP handling. Including `unknown` contacts remains a policy risk |
| R2 | Meta changes the API (versions, limits, codes, template rules) | Sends break | One version setting, provider abstraction, contract tests, error table as data |
| R3 | Two team members change contacts at once | Lost update | Postgres transactions; a refused save on a stale drawer; advisory lock for imports and restores (§4.2) |
| R4 | Duplicate sends after a step failure | Annoyance, cost | `claimed`/`sending`/`unknown` states; `biz_opaque_callback_data` matching; run tokens; no automatic resend (§8.2, §8.3) |
| R5 | Opt-out lost after an undo or restore | Policy breach | Postgres suppression list is the authority (§4.4) |
| R6 | Preview deployment sends real messages or exposes production data | Incident | Mock forced on previews; separate Neon branch and Blob prefix; no production secrets on previews |
| R7 | DuckDB native binary has trouble on Vercel | Snapshots unavailable; live contacts unaffected | Spike it in P1; fallback `hyparquet-writer` behind `SnapshotService` |
| R8 | Credentials delayed | Build blocked | Mock provider; P1–P5 need no credentials |
| R9 | Excel-mangled phone numbers | Wrong or rejected recipients | Read as text; reject scientific notation |
| R10 | Public app is attacked | Data leak | Clerk allowlist, private Blob, signed URLs, Vercel Firewall rate limit on `/api/*` |
| R11 | Bulk email harms the domain's reputation (bounces, spam complaints) | Emails land in spam or the Resend account is suspended | Dedicated subdomain, SPF/DKIM/DMARC, email consent gate, one-click unsubscribe, auto-suppression, bounce/complaint circuit breaker, ramp-up warning |
| R12 | Resend API key committed or leaked | Abuse of the account | `.local.bin` git-ignored, sending-only key restricted to one domain, never logged or returned, rotate on suspicion |
| R13 | Duplicate emails after a step failure | Annoyance, complaints | Idempotency key per batch (24 h), deterministic rendering, `unknown` after 23 h (§8.3) |
| R14 | Link scanners trigger unsubscribes | Lost subscribers | GET only confirms; unsubscribe happens on POST (§5.13) |
| R15 | Vercel Workflow behaves differently from the design (crash handling, pinning, limits) | Sending engine rework | P1 spike with fault injection; short runs; hand-offs; parked waits (§8.2) |
| R16 | Mock data reaches production | Real addresses suppressed; fake templates | Mock unavailable in production; mock-only webhook secrets (D16) |
| R17 | A send breaks a recipient country's marketing law | Fines, complaints | §12A defaults, strict-consent list, legal review before the first send |
| R18 | An opt-out arrives with only a BSUID | Message sent after opt-out | `whatsapp_identities` mapping; unmatched opt-outs shown on S-01 (§7.8) |

---

## 17. Revision Log
| Version | Change |
|---|---|
| 0.9 | First full draft (local single-machine app). |
| 1.0 | Review pass: suppression list, upload lifecycle, DuckDB⇄SQLite join, `unknown` state, re-check before each send, Marketing Messages API option, CSV injection, designer wireframe, risks. |
| 2.0 | **Re-architected for a shared Vercel deployment** after the open questions were answered. Local disk → private Vercel Blob with versioned Parquet and a Postgres pointer; SQLite → Neon Postgres; asyncio worker → Vercel Workflow + Cron; browser→Blob client upload (4.5 MB body limit); Clerk sign-in with allowlist; audit log with user attribution; S-10 Activity screen; per-environment isolation (Mock forced on previews); webhooks at the production URL (tunnel removed); credentials via env vars or encrypted Postgres row; campaign queue (one sending number); scope fixed to IN default / English / <50k contacts / `/messages`. |
| 2.1 | **Bulk email via Resend.** Email channel next to WhatsApp: per-channel consent (Parquet schema v2) and suppression lists; §4.6 email normalisation; S-11 email template designer; S-12 public unsubscribe page; channel step and email exclusions in S-07; email counters in S-08; channel column/filter on S-09 and S-03; Email section on S-01; §7A Resend integration (`/emails/batch`, idempotency keys, Svix webhooks, one-click unsubscribe); per-channel campaign queues; email circuit breaker; Resend key read from `.local.bin` locally (§7A.1); P8/P9 phases; FR-EML-01…12, FR-SET-06/07. |
| 2.2 | **Meta Graph API setup guide.** §7B: step-by-step runbook for the Meta app, system user token, number registration, S-01 credentials, webhook connection, end-to-end checks and troubleshooting. Aligned with Meta's current docs: `business_management` added to the token permissions (§7.1.1), the 1k messaging tier corrected to 2k (§7.6), example API version `v26.0`, and the limit read from `whatsapp_business_manager_messaging_limit` (§5.2, §7.2). |
| 2.3 | **Review pass and four decisions.** Live contacts moved from Parquet to Postgres, with Parquet as snapshots (D2); the suppression-sync cron removed; email-only contacts (D13, §4.7); overseas recipients: per-country pricing, per-recipient send windows, restricted countries, §12A (D14); `unknown` consent limits (D15); Mock barred from production (D16). Engine fixes: run tokens, heartbeats, parked waits, hand-offs, claim expiry, safe finalisation, shared rate limit, campaign state table (§8.2, §8.7). `biz_opaque_callback_data` matching; webhook failures use the error classifier; BSUID opt-outs; staged email sending and enforced ramp; 409 retry; unsubscribe secrets kept indefinitely; test-send tokens. Spec gaps G-01…22 and the `TASKS.md` decisions merged. All §15 answers recorded; FR-SET-08 and the monthly send cap added. `TASKS.md`, `evals/` and `docs/wireframes.html` are aligned with this version. |
