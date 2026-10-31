# Evaluation Scenarios

Behavioural evals for things a golden table can't express: concurrency, durability, timing, access control and end-to-end flows. Each row is one pass/fail check. **Level** is where it should be automated (see SPEC.md §13): `U` unit · `I` integration (real Neon branch + Blob) · `W` workflow with MockProvider · `C` contract (MSW-replayed Graph responses) · `E` Playwright on a preview deployment · `P` performance · `L` live smoke with real credentials.

Unless stated otherwise: provider = Mock, store starts empty, send window disabled, frequency cap 7 days, rate 20/s.

---

## 1. Contact store write protocol (§4.2)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| WP-01 | I | FR-IMP-08, C5 | Two functions commit different imports at the same moment. | Both succeed one after the other; final version = start + 2; both imports' rows present; no lost update. |
| WP-02 | I | FR-IMP-11 | User B commits while user A's commit holds the lock. | B waits then succeeds, or gets a "busy" response naming A. Never a corrupted or skipped version. |
| WP-03 | I | §4.2 step 6 | Force the pointer to move between read and CAS (bypass lock in test). | CAS updates 0 rows → write aborts and retries; no version is skipped. |
| WP-04 | I | §4.2 | Upload succeeds, then the transaction is forced to fail before commit. | Pointer unchanged; orphan blob exists; `cleanup` cron later deletes it; readers never see it. |
| WP-05 | I | §4.2 integrity | Inject a write that would produce a duplicate `phone_e164`. | Pointer does not move; error is logged; store unchanged. |
| WP-06 | I | FR-IMP-08 | Import (v1→v2), then undo. | Pointer = v1; row count = pre-import count; batch status `undone`; audit entry. |
| WP-07 | I | FR-IMP-08 | Import (v1→v2), bulk-tag (v2→v3), then try undo of the import. | Undo refused with an explanation; pointer stays v3. |
| WP-08 | I | §4.4, R5 | Import as opted_in (v2), STOP arrives for one contact, undo import. | That number is still opted-out/suppressed after undo. |
| WP-09 | I | §4.2 read | Instance has v5 cached in `/tmp`; another instance writes v6. | Next read on the first instance downloads v6 (no stale data). |
| WP-10 | I | §4.2 migrations | Load a store file written with `schema_version = 0` (one column missing). | Reads fill the default; the next write produces a file at the current schema_version. |
| WP-11 | I | §4.1 | Inspect any committed Parquet. | KV metadata has `app.schema_version`, `app.version`, `app.row_count` (equals actual rows), `app.written_by`; compression ZSTD. |
| WP-12 | I | §10 cleanup | 25 versions exist; v3 is the pre-version of an undoable import. | Cleanup keeps the latest 20 plus v3; deletes the rest; `store_versions.deleted_at` set. |

## 2. Contacts list & selection (§5.4, FR-CON)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| CT-01 | I | FR-CON-01 | 50k store; page through with sort by `city` desc, then `created_at`. | Pages don't overlap or skip rows (stable tiebreak on `contact_id`). |
| CT-02 | I | FR-CON-01 | Filter tags_any `[steel, export]` vs tags_all. | Counts match a reference computed in plain JS over the fixture. |
| CT-03 | I | FR-CON-01 | Filter "last messaged older than 30 days" (Postgres data) combined with a tag filter (Parquet data). | Result equals the intersection computed independently. |
| CT-04 | E | FR-CON-02 | Filter, "select all 8,412 matching", untick 3 rows on page 2, open campaign wizard. | Wizard audience count = 8,409 before exclusions; same as `POST /contacts/count`. |
| CT-05 | E | FR-CON-02 | Copy the URL with a selection to a second user's session. | Second user sees the same selection and count. |
| CT-06 | E | FR-CON-02 | Shift-click range across a virtualised boundary (rows 5→95). | Exactly 91 selected. |
| CT-07 | I | FR-CON-03 | Bulk add tag to 8,000 contacts. | Exactly one new store version; tags lowercased and trimmed; no duplicates in the tag list. |
| CT-08 | I | FR-CON-04 | Edit a contact's phone to another contact's number. | Rejected with a duplicate error; store unchanged. |
| CT-09 | I | FR-CON-04 | Edit a phone to `098765 43210` format. | Stored normalised as E.164 (same rules as import). |
| CT-10 | I | FR-CON-05 | Contact received 2 campaigns (one delivered, one failed). | Drawer history shows both with status, timestamps and error. |
| CT-11 | I | §12 DPDP | Delete a contact, run cleanup. | Not in list/count/campaign audiences immediately; absent from the next written version after cleanup. |
| CT-12 | I | FR-CON-03 | Bulk "Mark opted-out" on 10 contacts. | Suppression rows with reason `manual`, user recorded, one store version, audit entries. |

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
| CM-07 | W | §8.3 | `unknown` row later gets a `delivered` webhook. | Row → delivered; not counted in "Resend N unknown". |
| CM-08 | W | FR-CMP-05 | "Resend unknown" on 3 rows. | Exactly 3 sends; audit entry with user and count; requires explicit confirmation. |
| CM-09 | W | FR-CMP-05 | Pause mid-campaign. | No provider calls start more than ~1 batch (≤ 50 rows / ~3 s) after pause; status `paused`. Resume starts a new run and finishes the remaining rows only. |
| CM-10 | W | FR-CMP-05 | Cancel mid-campaign. | All `pending` → `skipped`; in-flight batch finishes; status `cancelled`; next queued campaign starts. |
| CM-11 | W | FR-CMP-05 | "Retry failed" with failures 131026, 130429 (exhausted), 131049 (2 h ago), 131049 (25 h ago). | Only the 130429 and the 25 h-old 131049 rows are retried (see EC-* goldens). |
| CM-12 | W | §8.5 | Mock fails 30% over 200 attempts. | Auto-pause with `pause_reason` mentioning the failure rate; banner on S-08. At 20% it does not pause. |
| CM-13 | W | §8.5 | Mock returns 132000 once. | Campaign pauses immediately (single occurrence). |
| CM-14 | W | §7.7 | Mock returns 131031. | All campaigns (running and queued) stop. |
| CM-15 | W | §7.6 | Mock returns 130429 for 3 calls. | Backoff with jitter; effective rate halves for 5 min then recovers; rows eventually `accepted`. |
| CM-16 | W | §7.6 | Mock returns 131056 for one recipient. | That row `retry_wait` with `next_attempt_at ≈ now + 60 s`; others continue. |
| CM-17 | W | FR-CMP-07 | Mock returns 131050. | Row `failed`; number in suppression list with reason `error_131050` within 5 s. |
| CM-18 | W | FR-CMP-08 | Two campaigns started 1 s apart. | Second is `queued`; starts automatically after the first finalises; never two `running`. |
| CM-19 | W | FR-CMP-08 | Schedule at 21:00 IST (clock faked). | No sends until 09:00 IST next day (see SW-* goldens). Same for a campaign that runs past 20:00. |
| CM-20 | W | FR-CMP-09 | Tier 1k, 900 unique users messaged in last 24 h, campaign of 300. | Wizard warns and offers a split; if sent, engine holds after 100 and continues when the window rolls. |
| CM-21 | W | §7.5 | Image header campaign of 500. | Exactly one `/media` upload; same media id in all 500 payloads. Resuming after > 30 days re-uploads. |
| CM-22 | W | §8.6 | 1,000-row campaign; poll stats. | Counts by status sum to total at every poll; final state all terminal. |
| CM-23 | C | FR-CMP-03 | Test send with mapping. | One send per configured test number using the first sample contact's params; not recorded as campaign messages. |
| CM-24 | E | §5.8 step 5 | Confirm dialog. | Send disabled until the typed number equals the recipient count. |
| CM-25 | I | §5.8 step 3 | 20 recipients have empty `first_name`, no fallback. | Listed in the wizard; frozen as `skipped` (EMPTY_VARIABLE), never sent. |
| CM-26 | P | NFR send throughput | 2,000 mock sends at 20/s. | Measured rate 18–22/s over any 30 s window after warm-up. |

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
| WB-08 | I | FR-CMP-07 | STOP text inbound (see OO-* goldens). | Suppressed within 5 s; audit `system:webhook`; contact shows opted-out in UI before the Parquet cron runs. |
| WB-09 | U | §7.8 | Every WS-* / WH-* golden. | Matches. |

## 6. Security, access & environments (§12, FR-SET)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| SEC-01 | E | FR-SET-01 | Sign in with a non-allowlisted email. | Refused; no public sign-up path exists. |
| SEC-02 | I | §9 | Call every `/api/*` route (generated from the route table) without a session. | 401/redirect for all except `/api/webhooks/*` and `/api/cron/*`. |
| SEC-03 | I | §9 | Call `/api/cron/*` without / with wrong / with correct `CRON_SECRET`. | 401 / 401 / 200. |
| SEC-04 | I | FR-SET-02 | Save a token via `PUT /settings/credentials`, then read `GET /settings` and grep all logs. | Token absent from every response body and log line; DB value is AES-256-GCM ciphertext (decrypts with `APP_ENCRYPTION_KEY` only). |
| SEC-05 | I | FR-SET-02 | Env var token and DB token both set. | Env var is used; UI shows "set by env var". |
| SEC-06 | E | FR-SET-04, R6 | On a preview deployment, set provider to Graph API and send a campaign. | Provider stays Mock; zero requests to `graph.facebook.com` (network log). |
| SEC-07 | E | §3.5 | Preview deployment contacts list. | Shows the preview branch's data only; Blob paths use `preview/<branch>/`. |
| SEC-08 | I | §12 Blob | Request a rejects/export URL; wait past expiry. | URL works only after session check and expires (short-lived). Blob store is private (direct URL without token → 403). |
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
| CR-01 | I | §10 | 3 new suppressions; run `apply-suppressions`. | One new store version with those 3 opted_out; second run writes no version (no-op). |
| CR-02 | W | §8.3 | Running campaign with no row changes for 10 min. | `reconcile-campaigns` starts a new run; no duplicates (`sending` rows → `unknown`). |
| CR-03 | I | §10 | Cleanup with import sources 8 days old, exports 25 h old, webhook events 91 days old. | All deleted; younger ones kept. |
| CR-04 | I | §10 | Two overlapping invocations of the same cron. | Second is a no-op (lock); no double processing. |

## 9. End-to-end (§13 E2E)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| E2E-01 | E | Happy path | Sign in → import `basic.csv` → auto-mapping accepted → validate (IS-01 numbers) → commit → filter tag `steel` → select all → campaign with mock-approved template → send now → monitor. | Monitor reaches 100%: 2 accepted, simulated delivered/read counts appear; activity log shows each step under the user. |
| E2E-02 | E | FR-IMP-01 | Upload a 30 MB CSV. | Preview appears from the first 200 rows before upload finishes; upload completes; no 4.5 MB error. |
| E2E-03 | E | FR-IMP-04 | Mapping step without Phone mapped. | Next disabled; enabled after mapping Phone. |
| E2E-04 | E | FR-IMP-09 | Save a preset, re-upload a file with the same headers. | Preset auto-applied. |
| E2E-05 | E | §5.1 | Start a campaign; navigate to Contacts. | Global sending banner with live count. |
| E2E-06 | E | NFR accessibility | Complete the import wizard and campaign wizard with keyboard only; run axe on every screen. | Completed without a mouse; no WCAG AA contrast violations. |

## 10. Performance (§11)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| NFR-01 | P | G1, NFR import | IS-14 (50k rows, 10 columns). | validate + commit < 60 s. |
| NFR-02 | P | FR-CON-01 | 50k store; 20 random filter/sort/page requests. | Warm p95 < 300 ms; cold (new instance, empty `/tmp`) < 1.5 s. |
| NFR-03 | P | NFR concurrency | Bulk tag 50k contacts. | Write holds the lock < 10 s. |
| NFR-04 | P | P7 | 50k mock sends with simulated webhooks. | Completes; no duplicates; stats consistent; no step exceeds its time limit. |

## 11. Live smoke (once Meta credentials exist, §13)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| LIVE-01 | L | FR-SET-03 | Test connection. | Display number, verified name and quality rating shown. |
| LIVE-02 | L | FR-TPL-04 | Submit a test template. | Reaches APPROVED/REJECTED via webhook without manual refresh. |
| LIVE-03 | L | FR-CMP-03 | Send to the test number. | Message arrives; `delivered` webhook updates the row. |
| LIVE-04 | L | FR-CMP-07 | Reply STOP from the test phone. | Number suppressed within 5 s. |
| LIVE-05 | C | R2 | Replay recorded responses for every §7.7 code (EC-* goldens). | Engine action matches. Re-record on each `GRAPH_API_VERSION` bump. |

## 12. Email via Resend (§7A, FR-EML)

Unless stated otherwise: email provider = MockEmailProvider, domain verified, postal address set, email frequency cap 7 days, 2 batch requests/s.

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| EM-01 | I | FR-EML-01 | Contact is opted_in on both channels; STOP arrives on WhatsApp; then an unsubscribe POST arrives for the email. | After the STOP: `suppression_list` has the phone, email opt-in unchanged. After the unsubscribe: `email_suppression_list` has the address; S-04 shows both. |
| EM-02 | I | FR-EML-01, §4.2 migrations | Load a schema v1 store, then commit an import. | Reads show `email_opt_in_status = unknown`; the new version has `app.schema_version = 2` and the three email consent columns. |
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
| EM-18 | W | §7A.7 | Mock returns 409 (idempotency key reused with a different payload). | Campaign `paused` with a bug-level reason; no automatic send under a new key. |
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

## 14. Live email smoke (once the Resend key exists)

| ID | Level | Covers | Scenario | Pass if |
|---|---|---|---|---|
| LIVE-EM-01 | L | FR-SET-06 | Test connection with the real key. | Domain name and `verified` status shown (or the DNS records to add). |
| LIVE-EM-02 | L | FR-EML-06, FR-EML-08 | Campaign to `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`. | Rows end `delivered`, `bounced`, `complained`; the last two are suppressed. |
| LIVE-EM-03 | L | FR-EML-04 | Send to a real Gmail inbox; click Gmail's "Unsubscribe". | One-click POST arrives; address suppressed. |
| LIVE-EM-04 | L | FR-EML-07 | Send the same batch twice with the same `Idempotency-Key`. | Second response returns the same ids; one email in the inbox. |
