# Evaluation Scenarios

Behavioural evals for things a golden table can't express: concurrency, durability, timing, access control and end-to-end flows. Each row is one pass/fail check. **Level** is where it should be automated (see SPEC.md §13): `U` unit · `I` integration (real Neon branch + Blob) · `W` workflow with MockProvider · `C` contract (MSW-replayed Graph responses) · `E` Playwright on a preview deployment · `P` performance · `L` live smoke with real credentials.

Unless stated otherwise: provider = Mock on a preview or local environment, store starts empty, send window disabled, frequency cap 7 days, rate 20/s.

---

## 1. Contact writes & Parquet snapshots (§4.2)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| WP-01 | I | FR-IMP-08, C5 | Two functions commit different imports at the same moment. | Both succeed one after the other; `contact_revision` = start + 2; both imports' rows present; no lost update. |
| WP-02 | I | FR-IMP-11 | User B commits while user A's commit holds the lock. | B waits then succeeds, or gets a "busy" response naming A. Never a corrupted or skipped version. |
| WP-03 | I | §4.2 commit | Validate a file, then edit a contact it matches and add a contact with one of its phones, then commit. | Matching re-runs at commit: no duplicate contact, and the result reflects current data. |
| WP-04 | I | §4.2 | Force the import transaction to fail after the merge. | No rows changed; no `contact_import_changes` rows; revision unchanged; batch status `failed`. |
| WP-05 | I | §4.1 constraints | Bypass validation to insert a duplicate non-deleted `phone_e164`, a duplicate email-only address, and a row with neither identifier. | The database rejects all three; the transaction rolls back; the error is logged. |
| WP-06 | I | FR-IMP-08 | Import adds rows and updates others, then undo. | New rows removed; updated rows restored from `contact_import_changes`; row count = pre-import count; batch status `undone`; audit entry. |
| WP-07 | I | FR-IMP-08 | Import, bulk-tag, then try to undo the import. | Undo refused with an explanation; the bulk tag stays. |
| WP-08 | I | §4.4, R5 | Import as opted_in, STOP arrives for one contact, undo import, at any delay. | Undo is allowed, and that number is still opted-out/suppressed afterwards. |
| WP-09 | I | §4.2 snapshots | Edit contacts while a snapshot is being written. | The snapshot is consistent with one point in time; `app.row_count` equals its actual rows; duplicate-phone check passes. |
| WP-10 | I | §4.2 restore | Restore a snapshot written with an older `schema_version` (one column missing). | Missing columns get defaults; live table stays at the current schema. |
| WP-11 | I | §4.2 | Inspect any snapshot Parquet. | KV metadata has `app.schema_version`, `app.version`, `app.row_count` (equals actual rows), `app.written_by`; compression ZSTD; excludes soft-deleted contacts. |
| WP-12 | I | §10 cleanup | Snapshots aged 10, 29 and 31 days exist. | Cleanup deletes only the 31-day file; `contact_snapshots.deleted_at` set. |
| WP-13 | I | §4.2, §12A | Restore a snapshot containing an erased contact and a since-suppressed contact. | A pre-restore snapshot exists; the erased contact is not restored; the suppressed contact stays opted-out; audit entry. |
| WP-14 | I | §4.2 | Blob upload fails during a snapshot. | Banner shown; no `contact_snapshots` row; contact reads and writes unaffected. |

## 2. Contacts list & selection (§5.4, FR-CON)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| CT-01 | I | FR-CON-01 | 50k store; page through with sort by `city` desc, then `created_at`. | Pages don't overlap or skip rows (stable tiebreak on `contact_id`). |
| CT-02 | I | FR-CON-01 | Filter tags_any `[steel, export]` vs tags_all. | Counts match a reference computed in plain JS over the fixture. |
| CT-03 | I | FR-CON-01 | Filter "last messaged older than 30 days" (Postgres data) combined with a tag filter (Parquet data). | Result equals the intersection computed independently. |
| CT-04 | E | FR-CON-02 | Filter, "select all 8,412 matching", untick 3 rows on page 2, open campaign wizard. | Wizard audience count = 8,409 before exclusions; same as `POST /contacts/count`. |
| CT-05 | E | FR-CON-02 | Copy the URL with a selection to a second user's session. | Second user sees the same selection and count. |
| CT-06 | E | FR-CON-02 | Shift-click range across a virtualised boundary (rows 5→95). | Exactly 91 selected. |
| CT-07 | I | FR-CON-03 | Bulk add tag to 8,000 contacts. | One transaction and one audit entry; tags lowercased and trimmed; no duplicates in the tag list. |
| CT-08 | I | FR-CON-04 | Edit a contact's phone to another contact's number. | Rejected with a duplicate error; store unchanged. |
| CT-09 | I | FR-CON-04 | Edit a phone to `098765 43210` format. | Stored normalised as E.164 (same rules as import). |
| CT-10 | I | FR-CON-05 | Contact received 2 campaigns (one delivered, one failed). | Drawer history shows both with status, timestamps and error. |
| CT-11 | I | §12A | Delete a contact, then run cleanup at 29 and 31 days. | Gone from list/count/campaign audiences immediately; row still exists at 29 days and is purged at 31. Re-importing it creates a new contact. |
| CT-12 | I | FR-CON-03 | Bulk "Mark opted-out" on 10 contacts. | Suppression rows with reason `manual`, user recorded, contact statuses updated in the same transaction, audit entries. |
| CT-13 | I | §4.7 | Edit a contact to remove its only identifier; give an email-only contact another email-only contact's address. | Both rejected; contact unchanged. |
| CT-14 | I | §4.7 | Change the email of an email-opted-in contact, and the phone of a WhatsApp-opted-in contact, without a confirmation; repeat with one; then change to a suppressed address. | Without: that channel becomes `unknown`, the other is unchanged. With: `opted_in`. Suppressed: `opted_out`. |
| CT-15 | I | §12A.3 | **Erase now** on a contact with message history who has opted out. | Contact row gone; personal fields on their `campaign_messages` null; ID in `contact_erasures`; suppression entry stays; audit entry contains no personal data. |
| CT-16 | I | §12A.3 | Export one contact's data. | Includes fields, consent records and both channels' history, and no other contact. Audit entry. |
| CT-17 | I | §4.4 | Remove a suppression entry with a reason. | Status becomes `unknown`, not `opted_in`; audit entry. |
| CT-18 | I | §12A.2 | Run cleanup with `campaign_messages` at 23 and 25 months, then POST an unsubscribe token for the older row. | Only the older row's phone, email and params are null; statistics remain; the unsubscribe suppresses the contact's current address. |

## 3. Templates (§5.6–5.7, FR-TPL)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| TP-01 | E | FR-TPL-03 | No credentials configured. Create, edit, save draft. | Works; "Submit to Meta" disabled with the reason. |
| TP-02 | E | FR-TPL-01 | Type in the body. | Preview updates on each keystroke with sample values substituted and WhatsApp formatting rendered (`*bold*` → bold). |
| TP-03 | W | FR-TPL-04 | Mock mode: submit. | Status PENDING, then APPROVED after ~10 s on S-05 **without a manual refresh**. |
| TP-04 | C | FR-TPL-04 | Replay `message_template_status_update` (REJECTED with reason). | Status REJECTED; reason visible; audit entry `system:webhook`. |
| TP-05 | C | FR-TPL-04 | Webhook missed; `sync-templates` cron runs. | Status corrected from `GET message_templates` (follows `paging.next` across ≥ 2 pages). |
| TP-06 | C | FR-TPL-05 | Submit with an image header. | Resumable upload session → bytes upload with `Authorization: OAuth` → `header_handle` placed in `example.header_handle`. |
| TP-07 | C | §7.3 | Create response returns `category: UTILITY` for a MARKETING draft. | Stored category is UTILITY; the template is not offered in the campaign wizard (MARKETING only). SPEC GAP G-20: confirm. |
| TP-08 | C | FR-TPL-06 | Delete an approved template. | `DELETE …?name=&hsm_id=` called; local row removed; campaigns referencing it keep their `template_snapshot_json`. |
| TP-09 | C | §7.3 | Submit body from TV-01. | Request body equals §7.3 example exactly (`parameter_format: NAMED`, `body_text_named_params`). |

## 4. Campaigns & sending engine (§5.8, §8, FR-CMP)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| CM-01 | I | FR-CMP-01 | Create a campaign, then edit a contact's first name and add a new contact matching the filter. | `campaign_messages` unchanged (frozen recipients and rendered params). |
| CM-02 | I | §5.8 step 1 | Audience of 100: 5 suppressed, 10 unknown opt-in, 7 messaged 3 days ago, 2 deleted. | Exclusion counts 5/10/7/2; final 76. With "include unknown" + acknowledgement: 86. |
| CM-03 | W | §5.8, §4.4 | STOP arrives for a frozen recipient after creation, before their turn. | Row becomes `skipped` (reason suppressed); provider never called for that number. |
| CM-04 | W | §5.8 | Contact receives another campaign between freeze and send (within cap). | Row `skipped` (frequency cap). |
| CM-05 | W | FR-CMP-04, §8.3 | Kill the `sendBatch` step after rows 1–20 are `accepted`, row 21 is `sending`, rows 22–50 `claimed`. Workflow retries the step. | Rows 1–20 not resent; row 21 → `unknown`, not resent; rows 22–50 sent exactly once; campaign completes. Provider call log has no duplicate `to`. |
| CM-06 | W | §8.4 | Two `runCampaign` runs for the same campaign started concurrently. | No row claimed twice (claim_token unique per row); total provider calls = recipients. |
| CM-07 | W | §8.3 | `unknown` row with no saved `wamid` later gets a `delivered` webhook carrying its `biz_opaque_callback_data`. | Row → delivered; `wamid` saved; not counted in "Resend N unknown". |
| CM-08 | W | FR-CMP-05 | "Resend unknown" on 3 rows. | Exactly 3 sends; audit entry with user and count; requires explicit confirmation. |
| CM-09 | W | FR-CMP-05 | Pause mid-campaign. | No provider calls start more than ~1 batch (≤ 50 rows / ~3 s) after pause; status `paused`; channel slot released. Resume re-enters the queue, starts a new run and finishes the remaining rows only. |
| CM-10 | W | FR-CMP-05 | Cancel mid-campaign. | All `pending` → `skipped`; in-flight batch finishes; status `cancelled`; next queued campaign starts. |
| CM-11 | W | FR-CMP-05 | "Retry failed" with failures 131026, 130429 (exhausted), 131049 (2 h ago), 131049 (25 h ago). | Only the 130429 and the 25 h-old 131049 rows are retried (see EC-* goldens). |
| CM-12 | W | §8.5 | Mock fails 30% over 200 attempts. | Auto-pause with `pause_reason` mentioning the failure rate; banner on S-08. At 20% it does not pause. |
| CM-13 | W | §8.5 | Mock returns 132000 once. | Campaign pauses immediately (single occurrence). |
| CM-14 | W | §7.7 | Mock returns 131031. | All campaigns (running and queued) stop. |
| CM-15 | W | §7.6 | Mock returns 130429 for 3 calls. | Backoff with jitter; effective rate halves for 5 min then recovers; rows eventually `accepted`. |
| CM-16 | W | §7.6 | Mock returns 131056 for one recipient. | That row `retry_wait` with `next_attempt_at ≈ now + 60 s`; others continue. |
| CM-17 | W | FR-CMP-07 | Mock returns 131050. | Row `failed`; number in suppression list with reason `error_131050` within 5 s. |
| CM-18 | W | FR-CMP-08 | Two campaigns started 1 s apart on one channel. | Second is `queued`; starts automatically after the first finalises; the partial unique index makes two `running` impossible, even when forced. |
| CM-19 | W | FR-CMP-08 | Schedule at 21:00 IST (clock faked), recipients in India only. | No sends until 09:00 IST next day, up to 5 min late (see SW-* goldens). Same for a campaign that runs past 20:00. |
| CM-20 | W | FR-CMP-09 | Tier 2k, 1,900 unique users messaged in last 24 h, campaign of 300. | Wizard warns and offers a split; if sent, engine holds after 100 and continues when the window rolls. |
| CM-21 | W | §7.5 | Image header campaign of 500. | Exactly one `/media` upload; same media id in all 500 payloads. Resuming after > 30 days re-uploads. |
| CM-22 | W | §8.6 | 1,000-row campaign; poll stats. | Counts by status sum to total at every poll; final state all terminal. |
| CM-23 | C | FR-CMP-03 | Test send with mapping. | One send per configured test number using the first sample contact's params; not recorded as campaign messages. |
| CM-24 | E | §5.8 step 5 | Confirm dialog. | Send disabled until the typed number equals the recipient count. |
| CM-25 | I | §5.8 step 3 | 20 recipients have empty `first_name`, no fallback. | Listed in the wizard; frozen as `skipped` (EMPTY_VARIABLE), never sent. |
| CM-26 | P | NFR send throughput | 2,000 mock sends at 20/s. | Measured rate 18–22/s over any 30 s window after warm-up. |
| CM-27 | I | D15 | 800 `unknown` opted recipients in non-strict countries, limit 500, toggle on with the acknowledgement. | 500 included, earliest `contact_id` first; 300 stay excluded; toggle, user and count audit-logged. Without the acknowledgement: refused. |
| CM-28 | I | D15, §12A | `unknown` contacts in DE, GB, GG, CA and with no country; toggle on. | All stay excluded; the wizard explains why. Removing a country from the strict list in Settings changes the result and is audit-logged. |
| CM-29 | I | D13 | WhatsApp campaign with email-only contacts selected. | Excluded with the count "no phone"; no row frozen for them. |
| CM-30 | W | C14 | Recipient in US; a second recipient's country is added to the restricted list after freeze. | US excluded at creation; the second becomes `skipped` (`RESTRICTED_COUNTRY`) before sending; provider never called for either. |
| CM-31 | I | D14 | Audience in IN, GB and a country with no price set. | Estimate equals the sum per country; the unpriced country uses the default and shows a warning. |
| CM-32 | W | FR-CMP-08 | Recipients in Asia/Kolkata, Europe/London, America/Chicago; clock moved across a day. | Every send falls inside 09:00–20:00 in the recipient's zone; the campaign completes; all rows sent once; channel stays held throughout. |
| CM-33 | W | §8.2 | Next window is 10 h away. Run `reconcile-campaigns` 20 times during the wait. | The run ends and `wait_until` is stored; no run is started before it is due; exactly one starts after; no duplicates. |
| CM-34 | W | §8.2 | Start a new run for a campaign whose old run is alive. | The old run exits at its next step; throughput never exceeds the configured rate. |
| CM-35 | W | §8.1 | All remaining rows are `retry_wait`, due in 60 s. | Campaign is not finalised early; rows are sent when due; then `completed`. |
| CM-36 | W | §8.1 | A dead run left 30 rows `claimed`. | After 10 min they return to `pending` and are sent exactly once. |
| CM-37 | W | §8.2 | Two runs and a test send act together at 20/s, then a 130429. | Combined rate stays within 20/s across instances; halving applies to all, from `rate_limits`. |
| CM-38 | W | C13 | Campaign needing more than 1,000 batches. | A new run takes over at 1,000 batches; no row is lost or repeated. |
| CM-39 | W | §7.7, FR-CMP-07 | `accepted` row gets a `failed` webhook: 131050; then another: 132015. | First: row `failed`, error fields stored, number suppressed within 5 s. Second: campaign pauses. |
| CM-40 | W | §8.5 | Mock accepts every send, then fails 30% through webhooks over 200 attempts. At 20%: no pause. | Auto-pause before the next batch, with a failure-rate `pause_reason`. |
| CM-41 | W | §7.8 | `delivered` webhook arrives while the row is `sending`, then the step saves `accepted`. | Row ends `delivered`; `wamid` and `accepted_at` set. |
| CM-42 | W | §8.2 | Scheduled campaign, with a new deployment before it is due. | No run exists while waiting; it starts within 5 min of `scheduled_at` on the new deployment, or `queued` if the channel is busy. |
| CM-43 | I | §8.7 | Attempt every transition in the §8.7 table, and some not in it. | Listed ones succeed, others are refused. Retry on a `completed` campaign re-runs only returned rows. Resume after 131031 is refused until the cause is cleared. |

## 5. Webhooks (§7.8)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| WB-01 | I | §8.4 | Same status payload POSTed 3 times. | One `webhook_events` row processed (dedup by payload hash); counters change once. |
| WB-02 | I | §7.8 | Processing throws (DB error injected). | Response 200; event marked with error; `reconcile-campaigns` reprocesses it successfully. |
| WB-03 | P | NFR reliability | 100 concurrent status webhooks. | p99 response < 2 s; all processed. |
| WB-04 | I | FR-CMP-06 | Delivered webhook during a running campaign. | Counter on S-08 updates within 10 s. |
| WB-05 | I | §7.8 | Status for a wamid that doesn't exist. | 200; stored; logged as unmatched; no crash. |
| WB-06 | I | §7.8 | `phone_number_quality_update` → RED. | All campaigns paused; banner shown; audit entry. |
| WB-07 | I | §7.6 | Status webhook with `pricing.category = marketing`. | `price_category` stored on the row. |
| WB-08 | I | FR-CMP-07 | STOP text inbound (see OO-* goldens). | Suppressed within 5 s; audit `system:webhook`; contact shows opted-out in UI immediately. |
| WB-09 | U | §7.8 | Every WS-* / WH-* golden. | Matches. |
| WB-10 | I | C15 | Status webhook with both a phone and a BSUID. | `whatsapp_identities` maps them; `last_seen_at` updated. |
| WB-11 | I | C15 | STOP with only a BSUID, mapping known. | Phone suppressed within 5 s. |
| WB-12 | I | C15 | STOP with only an unmapped BSUID; later a status webhook maps it. | BSUID suppressed and listed on S-01; the phone is suppressed when mapped, and a pending row becomes `skipped`. |

## 6. Security, access & environments (§12, FR-SET)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| SEC-01 | E | FR-SET-01 | Sign in with a non-allowlisted email. | Refused; no public sign-up path exists. |
| SEC-02 | I | §9 | Call every `/api/*` route (generated from the route table) without a session. | 401/redirect for all except `/api/webhooks/*` and `/api/cron/*`. |
| SEC-03 | I | §9 | Call `/api/cron/*` without / with wrong / with correct `CRON_SECRET`. | 401 / 401 / 200. |
| SEC-04 | I | FR-SET-02 | Save a token via `PUT /settings/credentials`, then read `GET /settings` and grep all logs. | Token absent from every response body and log line; DB value is AES-256-GCM ciphertext (decrypts with `APP_ENCRYPTION_KEY` only). |
| SEC-05 | I | FR-SET-02 | Env var token and DB token both set. | Env var is used; UI shows "set by env var". |
| SEC-06 | E | FR-SET-04, R6 | On a preview deployment, set provider to Graph API and send a campaign. | Provider stays Mock; zero requests to `graph.facebook.com` (network log). |
| SEC-07 | E | §3.5 | Preview deployment contacts list and snapshot. | Shows the preview branch's data only; Blob paths use `preview/<branch>/`. |
| SEC-08 | I | §12 Blob | Request a rejects/export URL; wait past expiry. Upload an email asset. | URL works only after session check and expires. Private store rejects a direct URL without a token. Only `email-assets/` is in the public store. |
| SEC-09 | I | FR-IMP-01, §12 | Upload-token request for 60 MB / `application/x-msdownload`. | Refused for size and for type. |
| SEC-10 | U | NFR observability | Log a send error for `+919876543210`. | Log shows `+91******3210`; no token, no full number. |
| SEC-11 | I | §12 | 200k+1 row CSV. | Rejected with the row limit message. |

## 7. Audit (FR-SET-05, G4)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| AU-01 | I | FR-SET-05 | Perform each state-changing API call once (import commit, undo, bulk action, contact edit, suppression add/remove, template submit/delete, campaign create/start/pause/resume/cancel/retry/resend, settings, credentials, allowlist). | Each produces exactly one `audit_log` row with user id, email, action, entity. Credentials audit row contains no secret. |
| AU-02 | I | §4.4 | Remove from suppression without a reason. | Refused (400). With reason: allowed and audited. |

## 8. Scheduled jobs (§10)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| CR-01 | I | §10 | Run `snapshot-contacts` after: 3 new suppressions only; then one contact edit; then nothing. | No snapshot; one snapshot; no snapshot. |
| CR-02 | W | §8.3 | `running` campaign, no `wait_until`, `heartbeat_at` older than 10 min; webhooks still updating rows. Separately, one with a future `wait_until`. | First gets a new `run_token` and run, `sending` rows → `unknown`, no duplicates. Second is left alone. |
| CR-03 | I | §10 | Cleanup with import sources and rejects 8 days old, exports 25 h old, webhook events 91 days old. | All deleted; younger ones kept. |
| CR-04 | I | §10 | Two overlapping invocations of the same cron. | Second is a no-op (lock); no double processing. |

## 9. End-to-end (§13 E2E)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| E2E-01 | E | Happy path | Sign in → import `basic.csv` → auto-mapping accepted → validate (IS-01 numbers) → commit → filter tag `steel` → select all → campaign with mock-approved template → send now → monitor. | Monitor reaches 100%: 2 accepted, simulated delivered/read counts appear; activity log shows each step under the user. |
| E2E-02 | E | FR-IMP-01 | Upload a 30 MB CSV. | Preview appears from the first 200 rows before upload finishes; upload completes; no 4.5 MB error. |
| E2E-03 | E | FR-IMP-04 | Mapping step with neither Phone nor Email mapped. | Next disabled; enabled after mapping either. |
| E2E-04 | E | FR-IMP-09 | Save a preset, re-upload a file with the same headers. | Preset auto-applied. |
| E2E-05 | E | §5.1 | Start a campaign; navigate to Contacts. | Global sending banner with live count. |
| E2E-06 | E | NFR accessibility | Complete the import wizard and campaign wizard with keyboard only; run axe on every screen. | Completed without a mouse; no WCAG AA contrast violations. |
| E2E-07 | E | FR-SET-08 | Open S-01 on a deployment, then copy each URL. | The app and webhook URLs match the deployment and copy correctly. A `*.vercel.app` production URL shows the custom-domain warning; a custom domain doesn't. |

## 10. Performance (§11)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| NFR-01 | P | G1, NFR import | IS-14 (50k rows, 10 columns). | validate + commit < 60 s. |
| NFR-02 | P | FR-CON-01 | 50k store; 20 random filter/sort/page requests. | Warm p95 < 300 ms; cold (new instance) < 1.5 s. |
| NFR-03 | P | NFR concurrency | Bulk tag 50k contacts. | Transaction completes in < 10 s; other contact reads are not blocked. |
| NFR-04 | P | P7, C13 | 50k mock sends with simulated webhooks. | Completes; no duplicates; stats consistent; no step exceeds its time limit; no run exceeds the Workflow event and step limits. |

## 11. Live smoke (once Meta credentials exist, §13)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| LIVE-01 | L | FR-SET-03 | Test connection. | Display number, verified name, quality rating and messaging limit shown. |
| LIVE-02 | L | FR-TPL-04 | Submit a test template. | Reaches APPROVED/REJECTED via webhook without manual refresh. |
| LIVE-03 | L | FR-CMP-03 | Send to the test number. | Message arrives; `delivered` webhook updates the row. |
| LIVE-04 | L | FR-CMP-07 | Reply STOP from the test phone. | Number suppressed within 5 s. |
| LIVE-05 | C | R2 | Replay recorded responses for every §7.7 code (EC-* goldens). | Engine action matches. Re-record on each `GRAPH_API_VERSION` bump. |
| LIVE-06 | L | C15 | Inspect recorded status and inbound webhooks. | BSUID field names match §7.8, or the spec and fixtures are corrected. `biz_opaque_callback_data` is returned. |

## 12. Email via Resend (§7A, FR-EML)

Unless stated otherwise: email provider = MockEmailProvider, domain verified, postal address set, email frequency cap 7 days, 2 batch requests/s, staged sending, hourly cap and new-domain ramp off.

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| EM-01 | I | FR-EML-01 | Contact is opted_in on both channels; STOP arrives on WhatsApp; then an unsubscribe POST arrives for the email. | After the STOP: `suppression_list` has the phone, email opt-in unchanged. After the unsubscribe: `email_suppression_list` has the address; S-04 shows both. |
| EM-02 | I | FR-EML-01, §4.2 | Restore a snapshot from before email consent existed (schema v1). | Restored contacts have `email_opt_in_status = unknown`; the next snapshot has `app.schema_version = 3`. |
| EM-03 | I | FR-EML-01 | Import `email-opt-in.csv` mapping an email opt-in column, consent box ticked. | `email_opt_in_status/source/at` set; the confirming user is stored; WhatsApp opt-in untouched. Without the box: commit refused. |
| EM-04 | I | FR-EML-02 | Import a file whose email column has every EN-* raw value (phones valid). | Every row imported; email values match EN-* goldens; Step 3 shows the INVALID_EMAIL count and role count. |
| EM-05 | E | FR-EML-03 | Type in subject and a text block on S-11. | Preview (desktop, mobile, plain text) updates on each keystroke with samples substituted. |
| EM-06 | E | FR-EML-03 | Add an image block without alt text; then a button with an `http://` URL. | *Mark ready* disabled with both errors listed; fixed → enabled; status `READY`. |
| EM-07 | E | FR-EML-04 | Try to delete or edit the footer block. | Not possible; footer always shows the postal address and the unsubscribe link. |
| EM-08 | U | FR-EML-04, FR-EML-05 | Every EP-* golden. | Matches. |
| EM-09 | I | FR-EML-05 | Audience of 100: 10 no email, 4 email-suppressed, 6 email opted_out, 15 email unknown, 5 emailed 2 days ago, 2 deleted, and 3 pairs of contacts sharing an address. | Exclusion counts 10/4/6/15/5/2 and 3 duplicates; final 55; frozen rows have unique `email_to`. |
| EM-10 | E | FR-EML-05 | Email campaign wizard with no postal address set / domain pending / no key. | *Send* disabled with the specific reason for each; *Send test email* also disabled without a key. |
| EM-11 | W | FR-EML-05, §7A.6 | Daily cap 1,000, 900 emails sent today (IST), campaign of 300. | Wizard warns and offers a split; if sent, the engine holds after 100 and resumes after 00:00 IST. |
| EM-12 | W | FR-EML-06 | 1,050-recipient campaign. | Exactly 11 `/emails/batch` calls (10 × 100 + 1 × 50); every row `accepted` with the id at its index; no request > 100 emails or > 1 recipient per email. |
| EM-13 | W | FR-EML-06, FR-EML-07, §8.3 | Kill `sendBatch` after the batch request was sent but before ids are persisted (rows `sending`). Workflow retries the step within minutes. | Same payload bytes and same `Idempotency-Key` are re-sent; Mock reports 0 new emails; rows get the original ids; campaign completes. Provider "delivered" log has no duplicate address. |
| EM-14 | W | FR-EML-07, §8.3 | Same as EM-13 but the clock is moved 24 h forward before the retry. | Rows become `unknown`, are **not** resent; a later webhook with the `message_id` tag resolves them (ES-19). |
| EM-15 | W | §7A.7 | Mock returns 422 for a batch of 100 (one invalid address). | Batch split into 100 `POST /emails` with `msg_{message_id}` keys; 99 accepted, 1 failed with the error message; no row sent twice. |
| EM-16 | W | §7A.7 | Mock returns 401. | Campaign `paused`; banner tells the user to update the key in `.local.bin` / env / Settings; no further calls. |
| EM-17 | W | §7A.6 | Mock returns 429 for 3 calls. | Backoff with jitter; request rate halves for 5 min; all rows eventually accepted. |
| EM-18 | W | §7A.7 | Mock returns 409 `invalid_idempotent_request`. | Campaign `paused` with a bug-level reason; no automatic send under a new key. |
| EM-19 | W | FR-EML-06, §5.8 | A WhatsApp campaign is running; start an email campaign; then start a second email campaign. | Email campaign 1 runs in parallel with WhatsApp; email campaign 2 is `queued` and starts after email 1 finalises. |
| EM-20 | W | §5.8, §7A.5 | Address unsubscribes after freeze, before its batch. | Row `skipped` (suppressed); not in the batch request. |
| EM-21 | I | FR-EML-08 | Every ES-* golden applied through `POST /api/webhooks/resend` with valid signatures. | Rows and suppression list match the goldens. |
| EM-22 | U | FR-EML-08 | Every RS-* golden. | Matches (`svix` behaviour). |
| EM-23 | I | FR-EML-08 | Same event delivered 3 times with the same `svix-id`. | One `webhook_events` row processed; counters change once. |
| EM-24 | I | FR-EML-08 | Delivered webhook during a running email campaign. | S-08 counters update within 10 s. |
| EM-25 | I | FR-EML-09 | `email.bounced` (Permanent) and `email.complained` for two addresses in campaign A; campaign B targets both. | Both suppressed within 5 s (reasons `hard_bounce`, `complaint`); campaign B excludes them at freeze and at send. |
| EM-26 | W | FR-EML-11 | Mock bounces 6% over 500 accepted emails. | Auto-pause with a bounce-rate `pause_reason`; at 4% it does not pause. |
| EM-27 | W | FR-EML-11 | Mock complaint rate 0.4% over 500. | Auto-pause; new email campaigns blocked until a user acknowledges. |
| EM-28 | U | FR-EML-10 | Every UT-* golden. | Matches. |
| EM-29 | I | FR-EML-10 | GET `/u/{valid}`; then POST; then POST again; then POST `/u/{tampered}`. | GET writes nothing and shows the masked address; first POST suppresses (`unsubscribe_link`), sets `unsubscribed_at`, audits `system:unsubscribe`; second POST no-op; tampered writes nothing. |
| EM-30 | I | FR-EML-10, RFC 8058 | POST `/u/{token}` with body `List-Unsubscribe=One-Click`, no cookies, no session. | 200; suppressed with reason `one_click`. |
| EM-31 | C | FR-EML-12 | Send test email from S-11 and from S-07. | One email per configured test address, `[TEST]` subject; no `campaign_messages` rows; audit entry. |
| EM-32 | I | §10 | Row `accepted` 3 h ago, no webhook; run `reconcile-emails`. | `GET /emails/{id}` called; `last_event = delivered` applied. |
| EM-33 | I | §10 | Mock domain status flips to `failed`; run `check-email-domain`. | Running email campaigns paused; banner shown; WhatsApp campaigns unaffected. |
| EM-34 | P | NFR send throughput | 20,000 mock emails at 2 req/s. | Measured 1.8–2.2 batch requests/s over any 30 s window; ~200 emails/s. |
| EM-35 | P | NFR-04 | 50k mock emails with simulated webhooks. | Completes; no duplicates; stats consistent; no step exceeds its time limit. |
| EM-36 | E | E2E | Sign in → import `email-opt-in.csv` (email opt-in column mapped, consent box ticked) → filter has-email + email opted_in → select all → Send campaign ▾ Email → READY template → send now → monitor. | Filter matches 3 (Asha, Ravi, Priya; Kiran's email was dropped, Meena's `no` is `unknown` per G-15, Tom has none). Wizard removes 1 duplicate address (Priya = Asha) → **2 recipients**. Monitor reaches 100% with simulated delivered/opened/clicked; activity log shows each step. |
| EM-37 | W | §7A.7 | Mock returns 409 `concurrent_idempotent_requests` twice, then success. | Same batch and key are retried; campaign does not pause; no duplicates. |
| EM-38 | W | §7A.5 | Staging on, 3,000 recipients, clock faked. | Releases 500, 1,000 and 1,500 with 15-minute waits; the run parks during each wait. A campaign of 400 is one stage. |
| EM-39 | W | FR-EML-11, §7A.5 | Staging on, 10,000 recipients, stage 1 bounces 6%. | Paused before stage 2; only 500 emails sent; bounce-rate `pause_reason`. |
| EM-40 | W | §7A.5 | Domain in its first week, 2,000 recipients. | Wizard warns; engine sends 500 per day. Override with an acknowledgement sends up to the daily cap, audit-logged. |
| EM-41 | W | §7A.6 | Hourly cap 1,000, 2,500 recipients, staging off. | At most 1,000 accepted in any clock hour; completes in the third hour. |
| EM-42 | I | §7A.5 | Send a test email, then GET and POST its unsubscribe link. | Page shows; nothing is written (UT-10). |
| EM-43 | W | FR-EML-05, §7A.6 | Daily cap 100, monthly cap 3,000. Campaign of 300 with nothing sent; then a campaign of 200 with 2,950 sent this month. | First: wizard warns; 100 sent per day over 3 days, and a second email campaign stays queued. Second: wizard warns; 50 sent, then paused with a monthly-cap reason. |

## 13. Email key, environments & security (FR-SET-06, FR-SET-07)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| SEC-12 | I | FR-SET-06 | Start `next dev` with no `.local.bin`; stop; add `RESEND_API_KEY=re_test…` to `.local.bin`; start again. | First run: email provider Mock, S-01 "Not set". Second: S-01 "Loaded from `.local.bin`", Test connection calls `GET /domains` with that key. |
| SEC-13 | I | FR-SET-06 | `.env.local` and `.local.bin` both define `RESEND_API_KEY` with different values. | The `.local.bin` value is used. |
| SEC-14 | I | FR-SET-06 | Key in env and in the Settings row. | Env value is used; S-01 says so; the Settings value is never returned by `GET /settings`. |
| SEC-15 | U | FR-SET-06, R12 | `git check-ignore .local.bin`; grep the build output and logs after a send. | File is ignored; the key (`re_…`) never appears in logs, responses or the client bundle. |
| SEC-16 | E | FR-SET-07, R6 | On a preview deployment, set the email provider to Resend and send a campaign. | Provider stays Mock; zero requests to `api.resend.com`. |
| SEC-17 | I | §9 | Unauthenticated calls to `/u/{token}` and `/api/webhooks/resend`; authenticated-only check for every other new route. | Those two are reachable without a session (and verify their own signatures); every other new `/api/*` route returns 401 without one. |
| SEC-18 | U | NFR observability | Log a bounce for `asha@example.com`. | Log shows `a••••@example.com`. |
| SEC-19 | I | D16, FR-SET-04, FR-SET-07 | In a production environment, set either provider to Mock through the API, and POST webhooks signed with the mock secrets. | Provider unchanged; both webhooks return 401 and are not processed. |
| SEC-20 | I | D16 | Production with no credentials. | S-01 shows not connected; sending, template submission and campaign start are refused; no mock data is created. |

## 14. Live email smoke (once the Resend key exists)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| LIVE-EM-01 | L | FR-SET-06 | Test connection with the real key. | Domain name and `verified` status shown (or the DNS records to add). |
| LIVE-EM-02 | L | FR-EML-06, FR-EML-08 | Campaign to `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`. | Rows end `delivered`, `bounced`, `complained`; the last two are suppressed. |
| LIVE-EM-03 | L | FR-EML-04 | Send to a real Gmail inbox; click Gmail's "Unsubscribe". | One-click POST arrives; address suppressed. |
| LIVE-EM-04 | L | FR-EML-07 | Send the same batch twice with the same `Idempotency-Key`. | Second response returns the same ids; one email in the inbox. |

## 15. Platform spike & test harness (§14 P1, §13)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| SPK-01 | W | R15 | Kill a Workflow step mid-way on a preview deployment. | It is retried; the observed retry count and timing are recorded in `docs/spikes/platform.md`. |
| SPK-02 | W | C13 | Start a run, deploy again, then let it continue; also park and restart. | The running one stays on the old deployment; the restarted one uses the new deployment. |
| SPK-03 | W | C13 | Run 1,000 batches through the §8.2 loop with Mock. | Events and steps per run are measured and within the current limits, or the hand-off count is changed. |
| SPK-04 | I | §3.2 | Write a 50k-contact ZSTD snapshot on a deployment. | Passes WP-11; the writer (DuckDB or `hyparquet-writer`) is named. |
| SPK-05 | I | §3.4 | Client upload to the private store; signed download; public `email-assets/` read. | All work; a signed URL fails after expiry. |
| HN-01 | W | §13 | Use the controllable clock across a durable wait and a parked run. | A 10-hour wait completes in test time, without real waiting. |
| HN-02 | W | §13 | Use fault injection to kill a step at row 21. | Reproduces CM-05 deterministically. |
| HN-03 | E | §13 | Playwright signs in as a Clerk test user on a protected preview deployment. | Reaches the Contacts page; seeded data is isolated to that branch. |
