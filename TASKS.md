# Implementation Tasks

The build plan for the coding agent, derived from [`SPEC.md`](SPEC.md) v2.3 and [`evals/`](evals/README.md). `SPEC.md` says what to build; this file sets the order and when each piece is done. [`docs/wireframes.html`](docs/wireframes.html) shows the screen layouts, and SPEC wins if they differ.

## How to work through this file

1. Take the first unticked task whose dependencies are ticked. Read its **Spec** sections before writing code.
2. Write the tests first. Load goldens from `evals/golden/*.json` with `describe.each` (example in `evals/README.md`) and automate scenarios from `evals/SCENARIOS.md` at the level their row states.
3. Tick a task only when everything under **Done when** passes. Work on a branch with one pull request per task, and mention the task ID in the commit message. Merging to `master` deploys to production, so it needs passing checks (T1.9).
4. A phase is finished when its **Gate** task passes. Don't start the next phase before that, unless the dependencies say otherwise.

**Rules that apply to every task**
- Never change a golden or scenario to make a test pass. If one looks wrong, stop and report it.
- Where a case is tagged `SPEC GAP G-nn`, the answer is in SPEC §2.3.
- If the spec, an eval and a wireframe disagree, the spec wins for now. Stop and report the mismatch.
- Tests and previews never call `graph.facebook.com` or `api.resend.com`. Live calls happen only in `[LIVE]` tasks.
- Secrets are never logged, returned by an API or committed. `.local.bin` stays git-ignored.
- Every state-changing route writes one audit row (T1.7) and needs a session unless §9 exempts it.
- Stop and ask at a **`[HUMAN]`** task or a `[LIVE]` task whose prerequisites are missing. Move on to other unblocked tasks in the meantime.

**Task labels**
- No label: the agent can finish it alone.
- `[HUMAN]`: needs a person with account access.
- `[LIVE]`: needs real credentials from a `[HUMAN]` task.

## Suggested order

```
P1 Foundation → P2 Import → P3 Contacts → P4 Templates → P5 Campaigns (mock) → P8 Email (mock)
                                                                                    │
       Blocked on credentials only for their [LIVE] tasks:   P6 Meta → P7 Hardening ┤
                                                             P9 Email live ─────────┘
```
Phases keep their numbers from SPEC §14. P8 comes before P6 because it needs no credentials.

---

## Human prerequisites

| ID | Who | What | Blocks |
|---|---|---|---|
| H-1 | Vercel account owner | Create or choose the Vercel team, and confirm a plan that allows crons every 5 minutes (§10) | T1.2, T5.13 |
| H-2 | Vercel account owner | Authorise the Clerk and Neon Marketplace installs and the two Blob stores | T1.2 |
| H-3 | Team | Give the first allowlist email(s) | T1.5 |
| H-4 | Team | Attach `wa.graceferroexports.com` to the Vercel project and add its DNS records. Clerk production cannot run on `*.vercel.app` | T1.5 (production sign-in), T6.4, T9.2 |
| H-5 | Meta portfolio admin (project owner) | Complete §7B Part A, and check Marketing Messages API eligibility | T6.4 |
| H-6 | Resend account owner | Create the Free account, provide the API key and add the DNS records for `mail.graceferroexports.com` | T9.2 |
| H-7 | Team | Update the privacy policy to cover marketing messages, opting out and this app's providers (§15 Q7) | First real campaign, not the build |
| H-8 | Google Workspace admin | Create Google OAuth credentials for Clerk production | T1.5 (production Google sign-in) |
| H-9 | Meta portfolio admin | **Start now:** begin business verification. Without it, sending is limited to 250 recipients per 24 hours | First real campaign, not the build |
| H-10 | Team + counsel | Fill the price table for the D14 regions from Meta's rate card, and get legal review of §12A for those countries | First real campaign, not the build |

---

## P1 Foundation

- [x] **T1.1 Scaffold the project**
  - **Spec:** §3.1, §3.2
  - **Build:** Next.js App Router with TypeScript, Tailwind and shadcn/ui, TanStack Query, Vitest and Playwright. Region `bom1` in `vercel.ts`. Scripts: `test`, `test:e2e`, `evals:check` (runs `node evals/check.mjs`).
  - **Done when:** `build`, `test` and `evals:check` pass, and one Vitest case loads a golden file through the import shown in `evals/README.md`.

- [ ] **T1.2 `[HUMAN]` Link Vercel and provision services**
  - **Depends:** T1.1, H-1, H-2
  - **Spec:** §3.1, §3.5, §14 P1
  - **Build:** `vercel link` with `master` as the production branch, Clerk, Neon (with a branch per preview) and Blob. Set `APP_ENCRYPTION_KEY`, `CRON_SECRET` and `EMAIL_UNSUBSCRIBE_SECRET` per environment. Pull them locally with `vercel env pull`. Production secrets never go on previews.
  - **Done when:** a pushed branch gets a preview deployment that connects to its own Neon branch.

- [ ] **T1.3 Spike the platform**
  - **Depends:** T1.2
  - **Spec:** §3.2, §3.4, §8.2, C13, R7, R15
  - **Build:** throwaway routes, plus `docs/spikes/platform.md` recording the results. Answer: how does Vercel Workflow retry a killed step? How does pinning behave across deploys, and does a parked campaign restart on the new deployment? How many events does the §8.2 loop use? Which Parquet writer works, DuckDB or `hyparquet-writer`? Do private client uploads, signed downloads and the public `email-assets/` store work?
  - **Done when:** SPK-01…05 and WP-11 pass on a preview deployment, and the document names the Parquet writer and the hand-off count.

- [ ] **T1.4 Database schema**
  - **Depends:** T1.2
  - **Spec:** §4.1, §4.3
  - **Build:** Drizzle schema and migrations for every table in §4.1 and §4.3, with a pooled or WebSocket Postgres driver that supports interactive transactions. Include the partial unique indexes and `CHECK` on `contacts`, and the partial unique index on `campaigns(channel) WHERE status = 'running'`.
  - **Done when:** migrations apply to an empty Neon branch, and an integration test proves `UNIQUE(campaign_id, contact_id)`, the partial `UNIQUE(campaign_id, email_to)` and the one-running-campaign index.

- [ ] **T1.5 Sign-in and allowlist**
  - **Depends:** T1.4, H-3
  - **Spec:** §3.5, §5.1, §5.2 (Team), §9, §12
  - **Build:** Clerk with email code and Google, no public sign-up, allowlist check backed by `team_allowlist`. Use a development instance on previews; production needs H-4 and H-8. Exempt only `/api/webhooks/*`, `/api/cron/*` and `/u/*`. A `requireCron` helper checks `CRON_SECRET`. `GET/POST/DELETE /team` and the S-01 Team section.
  - **Done when:** FR-SET-01, SEC-01, SEC-02 and SEC-03 pass. Add a route-table test that fails if a new route is left unauthenticated.

- [ ] **T1.6 App shell**
  - **Depends:** T1.5
  - **Spec:** §5.1
  - **Build:** sidebar, user menu, and a banner system fed by one status endpoint. Banners for missing credentials and Mock mode work now; the rest plug in later.
  - **Done when:** all sidebar routes render with empty states, and the Mock banner always shows on previews.

- [ ] **T1.7 Audit log and safe logging**
  - **Depends:** T1.5
  - **Spec:** §5.11, §11, FR-SET-05, G4
  - **Build:** `withAudit` route helper; structured logger that redacts tokens and keys and masks phones and emails; `GET /audit`; S-10 Activity log with filters.
  - **Done when:** SEC-10 and SEC-18 pass, and AU-01 passes for the routes that exist so far. Extend AU-01 as routes are added.

- [ ] **T1.8 Environment and settings layer**
  - **Depends:** T1.4
  - **Spec:** §3.4, §3.5, §7.1.2, D16
  - **Build:** `lib/env.ts` for environment detection, Blob prefix (`prod/`, `preview/<branch>/`, `dev/`) and whether Mock is allowed; typed settings store with defaults; AES-256-GCM secrets store; `GET/PUT /settings`.
  - **Done when:** unit tests cover encrypt/decrypt round trips and each environment's prefix and Mock rule, and settings defaults match §5.2.

- [ ] **T1.9 CI and deploy-time migrations**
  - **Depends:** T1.2, T1.4
  - **Spec:** §3.1, §13
  - **Build:** required pull request checks (type check, unit and integration tests, `evals:check`), protection on `master`, migrations as a deploy step, and a short note in the repo on expand-then-contract changes.
  - **Done when:** a failing test blocks a merge, and a merged migration reaches its environment.

- [ ] **T1.10 Test harness**
  - **Depends:** T1.3, T1.5, T1.9
  - **Spec:** §13
  - **Build:** controllable clock in Workflow steps, fault injection at a chosen row, Clerk test users, Deployment Protection bypass for Playwright, seeding and reset per test branch.
  - **Done when:** HN-01…03 pass.

- [ ] **T1.11 Gate P1**
  - **Done when:** SEC-01…03, SEC-10, AU-01 (existing routes), SPK-01…05, HN-01…03 and WP-11 pass on a preview deployment.

---

## P2 Import

Email consent columns are built here, not in P8, because the IS-* goldens need them.

- [x] **T2.1 Phone normalisation**
  - **Depends:** T1.1
  - **Spec:** §4.5
  - **Build:** `normalisePhone` in `lib/contacts/phone.ts`, usable in browser and server, with `libphonenumber-js` pinned.
  - **Done when:** PN-* pass and FR-IMP-05 holds.

- [x] **T2.2 Email normalisation**
  - **Depends:** T1.1
  - **Spec:** §4.6
  - **Build:** `normaliseEmail` in `lib/contacts/email.ts`, usable in browser and server, with role-address flagging.
  - **Done when:** EN-* pass and FR-EML-02 holds.

- [ ] **T2.3 ContactStore and matching**
  - **Depends:** T1.4, T1.8
  - **Spec:** §4.1, §4.2, §4.7
  - **Build:** `ContactStore` on Postgres: transactions, `contact_revision`, list and write methods, and a pure `matchContact` function for the §4.7 rules.
  - **Done when:** MA-* and WP-05 pass.

- [ ] **T2.4 Suppression service**
  - **Depends:** T1.7, T2.3
  - **Spec:** §4.4, §9
  - **Build:** one service for both lists, updating contact statuses in the same transaction, and storing opt-outs that have no contact yet; `GET/POST/DELETE /suppression?channel=`; removal needs a reason and sets status to `unknown`.
  - **Done when:** AU-02 passes, and tests show one channel's opt-out leaves the other unchanged.

- [ ] **T2.5 File upload**
  - **Depends:** T1.3, T1.8
  - **Spec:** §5.3 Step 1, §9, §12
  - **Build:** `POST /imports/upload-token` with session, size and type checks; `POST /imports` with SHA-256 duplicate detection; `GET /imports/{id}`.
  - **Done when:** FR-IMP-01 and SEC-09 pass, and a repeat upload returns `duplicate_of`.

- [ ] **T2.6 Detection and analysis**
  - **Depends:** T2.5
  - **Spec:** §5.3 Step 1, §12
  - **Build:** PapaParse Web Worker preview; `POST /imports/{id}/analyze` for encoding, delimiter, quote, header and skip detection, column stats and limits.
  - **Done when:** FR-IMP-02 and SEC-11 pass, and the analyze parts of `import-summaries.json` pass for each fixture.

- [ ] **T2.7 Mapping engine and presets**
  - **Depends:** T2.6
  - **Spec:** §5.3 Step 2
  - **Build:** header synonyms, target-field rules, header signature matching, `GET/POST/DELETE /mapping-presets`.
  - **Done when:** FR-IMP-03, FR-IMP-04 and FR-IMP-09 pass at unit level ("Mobile No" maps to Phone).

- [ ] **T2.8 Validate**
  - **Depends:** T2.1, T2.2, T2.3, T2.4, T2.7, T2.12
  - **Spec:** §4.7, §4.8, §5.3 Step 3
  - **Build:** `POST /imports/{id}/validate` and `GET /imports/{id}/rejects`: full-file normalisation, matching, all three existing-contact policies, suppression, email-only, no-country and restricted-country counts, `rejects.csv`.
  - **Done when:** FR-IMP-04, FR-IMP-06 and FR-IMP-07 pass, and the validate parts of IS-01…18 pass.

- [ ] **T2.9 Commit and undo**
  - **Depends:** T2.8
  - **Spec:** §4.2, §5.3 Steps 3–4
  - **Build:** `POST /imports/{id}/commit` (advisory lock, re-matching, change log, both consent confirmations) and `POST /imports/{id}/undo`, which never re-enables an opted-out contact.
  - **Done when:** FR-IMP-08, FR-IMP-10, FR-IMP-11, WP-01…04, WP-06…08, NFR-01 and all of IS-01…18 pass.

- [ ] **T2.10 Snapshots, restore and `cleanup` cron**
  - **Depends:** T1.3, T2.9
  - **Spec:** §4.2, §10, §12A.2
  - **Build:** `SnapshotService` with the writer chosen in T1.3; `GET/POST /snapshots`; `POST /snapshots/{version}/restore`; `snapshot-contacts` cron; `/api/cron/cleanup` with a job lock, deleting snapshots over 30 days, orphan blobs, and import sources and rejects over 7 days. T5.13 adds the rest.
  - **Done when:** WP-09…14, CR-01 and EM-02 pass.

- [ ] **T2.11 S-02 Import wizard**
  - **Depends:** T2.9
  - **Spec:** §5.3, §5.2 (Import)
  - **Build:** all four steps, including the virtualised mapping grid, default country for the file, red and amber cell highlights, consent checkboxes, result card and the "import in progress" state. Add the S-01 Import section.
  - **Done when:** E2E-02, E2E-03 and E2E-04 pass.

- [x] **T2.12 Country and time zone**
  - **Depends:** T2.1
  - **Spec:** §4.8
  - **Build:** `lib/geo` country-to-zone table, and a pure function resolving a contact's country and zone.
  - **Done when:** TZ-* pass.

- [ ] **T2.13 Gate P2**
  - **Done when:** PN-*, EN-*, MA-*, TZ-*, IS-01…18, WP-01…14, CR-01, EM-02, E2E-02…04, NFR-01, SEC-09 and SEC-11 pass.

---

## P3 Contacts

- [ ] **T3.1 List and filters API**
  - **Depends:** T2.3, T2.4
  - **Spec:** §4.3 (joining), §5.4, §9
  - **Build:** `GET /contacts` with search, every §5.4 filter, stable sort with a `contact_id` tiebreak, and SQL joins for suppression and activity.
  - **Done when:** FR-CON-01, CT-01…03 and NFR-02 pass.

- [ ] **T3.2 Selection model**
  - **Depends:** T3.1
  - **Spec:** §5.4, §9 (Selection object)
  - **Build:** shared selection resolver and `POST /contacts/count`.
  - **Done when:** the count matches a reference computed over a fixture, for both `ids` and `filter` modes with `exclude_ids`.

- [ ] **T3.3 Bulk actions and export**
  - **Depends:** T3.2
  - **Spec:** §5.4, §9, §12
  - **Build:** `POST /contacts/bulk` (`tag_add`, `tag_remove`, `opt_out`, `delete`, `export`), each in one transaction; CSV export escaper; short-lived export downloads.
  - **Done when:** FR-CON-03, CE-*, CT-07, CT-12, NFR-03 and SEC-08 pass.

- [ ] **T3.4 Single contact API**
  - **Depends:** T2.3
  - **Spec:** §4.7, §5.5, §9, §12
  - **Build:** `GET/PATCH/DELETE /contacts/{id}` with the same normalisation and identity rules as import, consent reset when an identifier changes, stale-edit refusal and soft delete.
  - **Done when:** FR-CON-04, CT-08, CT-09, CT-13, CT-14 and the immediate-removal half of CT-11 pass.

- [ ] **T3.5 S-03 Contacts list**
  - **Depends:** T3.3
  - **Spec:** §5.4
  - **Build:** virtualised grid, column chooser, filter UI, range selection, "select all matching", selection in the URL, bulk action bar.
  - **Done when:** FR-CON-02, CT-04, CT-05, CT-06 and SEC-07 pass. CT-04's wizard half is completed in T5.11.

- [ ] **T3.6 S-04 Contact drawer**
  - **Depends:** T3.4, T3.5
  - **Spec:** §5.5
  - **Build:** editable fields, per-channel consent panel, proof reference, message history for both channels, suppression actions with reasons.
  - **Done when:** FR-CON-05, CT-10 and CT-17 pass, with seeded `campaign_messages` rows.

- [ ] **T3.7 S-01 Data section, retention and data-subject actions**
  - **Depends:** T2.10, T3.3, T3.6
  - **Spec:** §5.2 (Data), §10, §12, §12A
  - **Build:** snapshot history with restore, contact export, suppression list management, `POST /contacts/{id}/erase`, `GET /contacts/{id}/export`, and the retention rules in `cleanup` (30-day purge, `campaign_messages` personal fields, audit log, inbound text removal).
  - **Done when:** CT-15, CT-16, CT-18 and all of CT-11 pass, and a restore through the UI cannot re-enable a suppressed contact.

- [ ] **T3.8 Gate P3**
  - **Done when:** CT-01…18, CE-*, NFR-02 and NFR-03 pass. CT-04's wizard half stays open until T5.11.

---

## P4 Templates

- [ ] **T4.1 Template validator**
  - **Depends:** T1.1
  - **Spec:** §5.7
  - **Build:** pure validator used by browser and server, mapping internal errors to the golden codes in one place.
  - **Done when:** TV-* pass and FR-TPL-02 holds.

- [ ] **T4.2 Template and media API**
  - **Depends:** T1.7, T4.1
  - **Spec:** §5.7, §9
  - **Build:** `GET/POST /templates?channel=`, `PUT/DELETE /templates/{id}`, `POST /media/upload-token` with the §5.7 size and type limits.
  - **Done when:** FR-TPL-03 passes through the API with no credentials set.

- [ ] **T4.3 S-06 Template designer**
  - **Depends:** T4.2
  - **Spec:** §5.7
  - **Build:** the layout in §5.7: editor, toolbar, variable menu, sample values, buttons, live validation and a light/dark WhatsApp preview.
  - **Done when:** FR-TPL-01, TP-01 and TP-02 pass.

- [ ] **T4.4 S-05 Template library (WhatsApp tab)**
  - **Depends:** T4.2
  - **Spec:** §5.6
  - **Build:** table with status badges, duplicate, edit, delete, rejection reason. **Sync from Meta** is wired up in T5.1.
  - **Done when:** an E2E test creates, duplicates and deletes a draft.

- [ ] **T4.5 Gate P4**
  - **Done when:** TV-*, TP-01 and TP-02 pass.

---

## P5 Campaigns (mock)

- [ ] **T5.1 Provider interface and MockProvider**
  - **Depends:** T1.8, T4.2
  - **Spec:** §7.1.3, §3.5, D16
  - **Build:** `WhatsAppProvider`, a single `getWhatsAppProvider()` that forces Mock on previews and refuses it in production, and `MockProvider` with latency, real error codes as immediate errors and as later `failed` webhooks, 10 s template approval and webhooks signed with `MOCK_WEBHOOK_SECRET`. Previews post them through a Deployment Protection bypass secret. Add `POST /templates/{id}/submit` and `POST /templates/sync`.
  - **Done when:** FR-SET-04, SEC-06, SEC-19 (WhatsApp half), SEC-20 and TP-03 pass. A test proves previews can't construct the real provider.

- [ ] **T5.2 Credentials and S-01 WhatsApp sections**
  - **Depends:** T1.8, T5.1
  - **Spec:** §5.2 (1, 3), §7.1.2, §9
  - **Build:** `PUT /settings/credentials`, `POST /settings/test-connection`, precedence and "set by env var" status, app URLs card, webhook setup card, sending settings, price table, restricted countries, opt-out keywords, and the S-01 Audience rules section.
  - **Done when:** FR-SET-08, E2E-07, FR-SET-02, SEC-04 and SEC-05 pass.

- [ ] **T5.3 Payload builder and send window**
  - **Depends:** T1.1, T2.12
  - **Spec:** §5.2, §5.8, §7.4, §8.2
  - **Build:** template payload builder with variable mapping, fallbacks and `biz_opaque_callback_data`; open-zone and `waitUntil` calculation.
  - **Done when:** SP-* and SW-* pass.

- [ ] **T5.4 Status, error and opt-out logic**
  - **Depends:** T1.1
  - **Spec:** §7.7, §7.8, §8.1
  - **Build:** webhook status reducer; `lib/whatsapp/errors.ts` classifier, kept as data; inbound opt-out detector.
  - **Done when:** ST-*, EC-* and OO-* pass.

- [ ] **T5.5 WhatsApp webhook**
  - **Depends:** T2.4, T5.2, T5.4
  - **Spec:** §7.7, §7.8, §8.4, §12
  - **Build:** `GET/POST /api/webhooks/whatsapp`: handshake, HMAC check on the raw body, storage in `webhook_events` with the raw-body hash as `external_id`, matching by `biz_opaque_callback_data` then `wamid`, status updates, the §7.7 classifier for `failed` statuses, opt-outs, `whatsapp_identities`, template status, quality alerts. Invalid signatures return 401 and are not processed.
  - **Done when:** FR-CMP-06, FR-CMP-07, WS-*, WH-*, WB-01, WB-02, WB-04…12 pass.

- [ ] **T5.6 Campaign creation**
  - **Depends:** T3.2, T5.3
  - **Spec:** §5.8, §4.3, §9, §12A, D15
  - **Build:** `POST /campaigns` with channel-aware exclusions (no phone, restricted countries, the `unknown` limit and strict-consent countries), frozen recipients with country and zone, template snapshot and rendered params; `GET /campaigns` and `/campaigns/{id}`; `GET /campaigns/{id}/messages`; `POST /campaigns/{id}/preview`; `POST /campaigns/test-send`.
  - **Done when:** FR-CMP-01, FR-CMP-02, FR-CMP-03 (with Mock), CM-01, CM-02, CM-25, CM-27…29 and CM-31 pass.

- [ ] **T5.7 Workflow engine**
  - **Depends:** T1.10, T5.1, T5.5, T5.6
  - **Spec:** §8.1–8.4, §7.5, C13
  - **Build:** `runCampaign` with Vercel Workflow per §8.2: `run_token` ownership, heartbeat, parking long waits, hand-offs, claims with `SKIP LOCKED` and expiry, safe finalisation; `sendBatch` with re-checks and row-level persistence; `rate_limits`; per-channel queue; scheduling started by cron; per-zone send windows; one media upload per campaign.
  - **Done when:** FR-CMP-04, FR-CMP-08, CM-03…07, CM-09, CM-10, CM-18, CM-19, CM-21, CM-26, CM-30, CM-32…38, CM-41 and CM-42 pass.

- [ ] **T5.8 Retries, controls and circuit breaker**
  - **Depends:** T5.7
  - **Spec:** §5.9, §7.6, §7.7, §8.3, §8.5, §8.7, §9
  - **Build:** `POST /campaigns/{id}/start`, `/pause`, `/resume`, `/cancel`, `/retry-failed`, `/resend-unknown`, enforcing the §8.7 table; backoff and rate halving; `pause_reason`; a breaker that counts webhook failures; stop-all behaviour for 131031 and 368.
  - **Done when:** FR-CMP-05, CM-08, CM-11…17, CM-39, CM-40 and CM-43 pass.

- [ ] **T5.9 Messaging-limit guard**
  - **Depends:** T5.7
  - **Spec:** §5.8 step 5, §7.6
  - **Build:** guard in the wizard API and hold in the engine, with the optional split across days.
  - **Done when:** FR-CMP-09 and CM-20 pass.

- [ ] **T5.10 Campaign stats**
  - **Depends:** T5.7
  - **Spec:** §8.6
  - **Build:** `GET /campaigns/{id}/stats` from an indexed `GROUP BY`.
  - **Done when:** CM-22 passes.

- [ ] **T5.11 S-07 Campaign wizard**
  - **Depends:** T3.5, T5.6, T5.9
  - **Spec:** §5.8
  - **Build:** Steps 0–5 for WhatsApp, with exclusions, the `unknown` toggle, cost by country, recipients per time zone, typed-count confirmation and test send. Step 0 appears with email disabled until T8.8.
  - **Done when:** CM-24 and the wizard half of CT-04 pass.

- [ ] **T5.12 S-08 monitor, S-09 list, global banner**
  - **Depends:** T5.8, T5.10, T5.11
  - **Spec:** §5.1, §5.9, §5.10, §8.6
  - **Build:** live counters, controls, hold line, failures table and export; campaign list with queue view and expected start; the sending banner on every screen.
  - **Done when:** E2E-01 and E2E-05 pass.

- [ ] **T5.13 Remaining crons**
  - **Depends:** T2.10, T5.8, H-1
  - **Spec:** §8.2, §8.3, §10
  - **Build:** `sync-templates` and `reconcile-campaigns` (due parked and scheduled campaigns, stalled runs, failed webhook events, queues), the remaining cleanup work, a shared job lock, and the full schedule in `vercel.ts`.
  - **Done when:** CR-02, CR-03 and CR-04 pass.

- [ ] **T5.14 Gate P5**
  - **Done when:** SP-*, ST-*, EC-*, OO-*, WS-*, WH-*, SW-*, CM-01…43 (CM-23 stays with P6), WB-01…12 (WB-03 re-run in P7), CR-02…04, TP-03, E2E-01, E2E-05, E2E-07, SEC-04…08, SEC-19 (WhatsApp half) and SEC-20 pass on a preview deployment.

---

## P8 Email (mock)

- [ ] **T8.1 Email provider, `.local.bin` and S-01 Email section**
  - **Depends:** T5.2
  - **Spec:** §5.2 (2), §7A.1, §7A.2, D16
  - **Build:** `EmailProvider`, `MockEmailProvider` (idempotency keys, Svix-signed webhooks with a mock-only secret, `@bounce.test` and `@complain.test`), provider selection that refuses Mock in production, the `.local.bin` loader using `util.parseEnv`, `GET /settings/email-domain` and the full S-01 Email section.
  - **Done when:** FR-SET-06, FR-SET-07, SEC-12…16 and SEC-19 (email half) pass.

- [ ] **T8.2 Email renderer and unsubscribe tokens**
  - **Depends:** T1.1
  - **Spec:** §5.12, §7A.4, §7A.5
  - **Build:** block-to-React-Email renderer with deterministic output and correct escaping; `/emails/batch` element builder; token sign and verify with old secrets kept indefinitely, and test tokens.
  - **Done when:** FR-EML-04 (payload half), EP-*, EM-08, UT-* and EM-28 pass.

- [ ] **T8.3 Email templates and S-11**
  - **Depends:** T4.2, T8.2
  - **Spec:** §5.6, §5.12, §9
  - **Build:** email validator (no golden exists, so write the table from §5.12); `POST /templates/{id}/ready`, `/render`, `POST /email-assets/upload-token`; S-11 designer; S-05 Email tab.
  - **Done when:** FR-EML-03, FR-EML-04 (footer half), EM-05, EM-06 and EM-07 pass.

- [ ] **T8.4 Resend webhook and email reducer**
  - **Depends:** T2.4, T8.1
  - **Spec:** §7A.8, §8.1
  - **Build:** `POST /api/webhooks/resend`: Svix check, `svix-id` dedupe, matching by id then `message_id` tag, status reducer, suppression, `email_link_clicks`.
  - **Done when:** FR-EML-08, FR-EML-09, ES-*, RS-*, EM-21…25 pass. EM-25's campaign half is completed in T8.6.

- [ ] **T8.5 S-12 Unsubscribe page**
  - **Depends:** T2.4, T8.2
  - **Spec:** §5.13
  - **Build:** public `/u/{token}`: GET confirms, POST unsubscribes (including RFC 8058 one-click), masked address, generic invalid page.
  - **Done when:** FR-EML-10, EM-29, EM-30, EM-42 and SEC-17 pass.

- [ ] **T8.6 Email in the campaign engine**
  - **Depends:** T5.8, T8.1, T8.2
  - **Spec:** §5.8, §7A.6, §7A.7, §8.2, §8.3
  - **Build:** email exclusions and duplicate-address handling at creation; `sendBatch` with `batch_key`, byte-identical retries, the 23-hour rule, 422 splitting, both 409 cases; daily cap hold and monthly cap pause; separate queues per channel. Add `lib/email/errors.ts`.
  - **Done when:** FR-EML-05, FR-EML-06, FR-EML-07, EM-09, EM-11…20, EM-34, EM-35, EM-37 and EM-43 pass.

- [ ] **T8.7 Staged sending and email circuit breaker**
  - **Depends:** T8.6
  - **Spec:** §7A.5, §7A.6, §8.5
  - **Build:** stages, hourly cap, enforced new-domain ramp with override, bounce and complaint thresholds checked before each stage, and the 7-day complaint block with acknowledgement.
  - **Done when:** FR-EML-11, EM-26, EM-27 and EM-38…41 pass.

- [ ] **T8.8 Email in the UI**
  - **Depends:** T5.11, T5.12, T8.3, T8.6
  - **Spec:** §5.4, §5.5, §5.8–5.10
  - **Build:** email path in S-07, including readiness blocks and test email; email counters, top links and failures on S-08; channel column and filter on S-09; email filters and actions on S-03; both channels on S-04.
  - **Done when:** FR-EML-01, FR-EML-12, EM-01, EM-03, EM-04, EM-10, EM-31 and EM-36 pass.

- [ ] **T8.9 Email crons**
  - **Depends:** T8.6
  - **Spec:** §10
  - **Build:** `reconcile-emails` and `check-email-domain`; extend `reconcile-campaigns` to Resend events and the email queue; extend `cleanup` to `email-assets/`.
  - **Done when:** EM-32 and EM-33 pass.

- [ ] **T8.10 Gate P8**
  - **Done when:** EP-*, ES-*, RS-*, UT-*, EM-01…43, SEC-12…18 and SEC-19 (email half) pass.

---

## P6 Meta integration

T6.1–T6.3 use hand-written MSW fixtures based on §7 and Meta's docs, so they can be done without credentials. T6.4 re-records them.

- [ ] **T6.1 GraphApiProvider: connection and templates**
  - **Depends:** T5.14
  - **Spec:** §5.2, §7.2, §7.3, §7.5
  - **Build:** `checkConnection` (including `whatsapp_business_manager_messaging_limit`, falling back to manual entry for unknown values), `listTemplates` with paging, create, edit, delete, resumable sample upload.
  - **Done when:** FR-TPL-04, FR-TPL-05, FR-TPL-06, TP-04…09 pass.

- [ ] **T6.2 GraphApiProvider: sending**
  - **Depends:** T6.1
  - **Spec:** §7.2, §7.2.1, §7.4, §7.5
  - **Build:** `uploadSendMedia`, `sendTemplate`, signed-link fallback, and the `send_endpoint` switch.
  - **Done when:** CM-23 passes, and the request body matches the SP-* goldens through MSW.

- [ ] **T6.3 Error contract tests**
  - **Depends:** T6.2
  - **Spec:** §7.7, R2
  - **Build:** a contract test replaying a response for every §7.7 code through the engine.
  - **Done when:** LIVE-05 passes.

- [ ] **T6.4 `[LIVE]` Connect and smoke test**
  - **Depends:** T6.3, H-4, H-5
  - **Spec:** §7B, §13
  - **Build:** follow §7B Parts B and C on Production with the test number first, including Step 7 (webhook, `subscribed_apps`, Live mode), and confirm Deployment Protection doesn't cover the route. Replace hand-written fixtures with recorded responses, with secrets and phones scrubbed.
  - **Done when:** FR-SET-03, LIVE-01, LIVE-02, LIVE-03 and LIVE-06 pass.

---

## P7 Webhooks live and hardening

- [ ] **T7.1 `[LIVE]` STOP flow and the real number**
  - **Depends:** T6.4
  - **Spec:** §7.8, §7B.4, §7B.5
  - **Build:** run the STOP check, then move from the test number to the real number (§7B.5) and repeat checks 3 and 4.
  - **Done when:** LIVE-04 passes on the real number.

- [ ] **T7.2 Load, accessibility and tuning**
  - **Depends:** T5.14
  - **Spec:** §8.5, §11
  - **Build:** run the load tests, fix what they find, tune breaker defaults, fix accessibility issues on every screen.
  - **Done when:** NFR-04, WB-03 and E2E-06 pass.

- [ ] **T7.3 Gate P6 and P7**
  - **Depends:** T7.1, T7.2
  - **Done when:** TP-04…09, CM-23, LIVE-01…06, NFR-04, WB-03 and E2E-06 pass, and a full re-run of every earlier gate passes.

---

## P9 Email live

- [ ] **T9.1 ResendProvider**
  - **Depends:** T8.10
  - **Spec:** §7A.3, §7A.7
  - **Build:** `ResendProvider` with the `resend` SDK, replaying a response for every §7A.7 row and every webhook event type through MSW. No key needed.
  - **Done when:** contract tests pass and the engine's actions match §7A.7.

- [ ] **T9.2 `[LIVE]` Verify the domain and smoke test**
  - **Depends:** T9.1, H-4, H-6
  - **Spec:** §7A.1, §7A.5, §13
  - **Build:** add the key, verify the domain from S-01, add DMARC, register the webhook, then run the smoke tests.
  - **Done when:** LIVE-EM-01…04 pass.

- [ ] **T9.3 Gate P9**
  - **Depends:** T9.2
  - **Done when:** LIVE-EM-01…04 pass and EM-34 and EM-35 pass in a re-run with `ResendProvider` replaced by the mock at the HTTP level, so load never reaches Resend. Before a real campaign, H-7, H-9 and H-10 must also be complete.

---

## Decisions

The decisions that used to be listed here are merged into SPEC v2.3 (§2.1 and the sections they affect). The answers to the SPEC §15 questions are recorded there.
