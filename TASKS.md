# Implementation Tasks

The build plan for the coding agent, derived from [`SPEC.md`](SPEC.md) v2.2 and [`evals/`](evals/README.md). `SPEC.md` says what to build; this file sets the order and when each piece is done.

## How to work through this file

1. Take the first unticked task whose dependencies are ticked. Read its **Spec** sections before writing code.
2. Write the tests first. Load goldens from `evals/golden/*.json` with `describe.each` (example in `evals/README.md`) and automate scenarios from `evals/SCENARIOS.md` at the level their row states.
3. Tick a task only when everything under **Done when** passes. Mention the task ID in the commit message, one task per commit.
4. A phase is finished when its **Gate** task passes. Don't start the next phase before that, unless the dependencies say otherwise.

**Rules that apply to every task**
- Never change a golden or scenario to make a test pass. If one looks wrong, stop and report it.
- Where a case is tagged `SPEC GAP G-nn`, implement the assumed answer in `evals/README.md`.
- Follow the decisions in [Decisions to confirm](#decisions-to-confirm); where they differ from the spec, they win until someone says otherwise.
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
| H-2 | Vercel account owner | Authorise the Clerk and Neon Marketplace installs and the Blob store | T1.2 |
| H-3 | Team | Give the first allowlist email(s) | T1.5 |
| H-4 | Team | Choose the production domain (§15 Q1) | T7.1 |
| H-5 | Meta portfolio admin | Complete §7B Parts A and B, and answer §15 Q4 (Marketing Messages API eligibility) | T6.4, T7.1 |
| H-6 | Resend account owner | Provide the API key, sending subdomain, DNS records, from and reply-to addresses, and plan limits (§15 Q6, Q8) | T9.2 |
| H-7 | Team | Give the business postal address (§15 Q7) | T9.2 |

---

## P1 Foundation

- [ ] **T1.1 Scaffold the project**
  - **Spec:** §3.1, §3.2
  - **Build:** Next.js App Router with TypeScript, Tailwind and shadcn/ui, TanStack Query, Vitest and Playwright. Region `bom1` in `vercel.ts`. Scripts: `test`, `test:e2e`, `evals:check` (runs `node evals/check.mjs`).
  - **Done when:** `build`, `test` and `evals:check` pass, and one Vitest case loads a golden file through the import shown in `evals/README.md`.

- [ ] **T1.2 `[HUMAN]` Link Vercel and provision services**
  - **Depends:** T1.1, H-1, H-2
  - **Spec:** §3.1, §3.5, §14 P1
  - **Build:** `vercel link` with `master` as the production branch, Clerk, Neon (with a branch per preview) and Blob. Set `APP_ENCRYPTION_KEY`, `CRON_SECRET` and `EMAIL_UNSUBSCRIBE_SECRET` per environment. Pull them locally with `vercel env pull`. Production secrets never go on previews.
  - **Done when:** a pushed branch gets a preview deployment that connects to its own Neon branch.

- [ ] **T1.3 Spike DuckDB and Blob on Vercel**
  - **Depends:** T1.2
  - **Spec:** §3.2, §4.2, R7, §12
  - **Build:** a throwaway route, plus `docs/spikes/storage.md` recording the results. Answer: does `@duckdb/node-api` run on Vercel with a Parquet read and write in `/tmp`? Can Blob do private client uploads and short-lived downloads? How should public `email-assets/` be served (decision D7)?
  - **Done when:** the spike route writes a ZSTD Parquet file whose metadata passes WP-11 on a preview deployment, and the document names the engine (DuckDB, or the `hyparquet` fallback) and the Blob approach.

- [ ] **T1.4 Database schema**
  - **Depends:** T1.2
  - **Spec:** §4.3
  - **Build:** Drizzle schema and migrations for every table in §4.3, email columns included, with the listed unique constraints and indexes. Add `email_link_clicks` (D5). Use a Postgres driver that supports interactive transactions (D10).
  - **Done when:** migrations apply to an empty Neon branch, and an integration test proves `UNIQUE(campaign_id, contact_id)` and the partial `UNIQUE(campaign_id, email_to)`.

- [ ] **T1.5 Sign-in and allowlist**
  - **Depends:** T1.4, H-3
  - **Spec:** §5.1, §5.2 (Team), §9, §12
  - **Build:** Clerk with email code and Google, no public sign-up, allowlist check backed by `team_allowlist`. Exempt only `/api/webhooks/*`, `/api/cron/*` and `/u/*`. A `requireCron` helper checks `CRON_SECRET`. `GET/POST/DELETE /team` and the S-01 Team section.
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
  - **Spec:** §3.4, §3.5, §7.1.2
  - **Build:** `lib/env.ts` for environment detection and Blob prefix (`prod/`, `preview/<branch>/`, `dev/`); typed settings store with defaults; AES-256-GCM secrets store; `GET/PUT /settings`.
  - **Done when:** unit tests cover encrypt/decrypt round trips and each environment's prefix, and settings defaults match §5.2.

- [ ] **T1.9 Gate P1**
  - **Done when:** SEC-01…03, SEC-10, AU-01 (existing routes) and WP-11 (spike) pass on a preview deployment.

---

## P2 Import

Schema v2 and email consent are built here, not in P8, because the IS-* goldens need them (D8).

- [ ] **T2.1 Phone normalisation**
  - **Depends:** T1.1
  - **Spec:** §4.5
  - **Build:** `normalisePhone` in `lib/contacts/phone.ts`, usable in browser and server, with `libphonenumber-js` pinned.
  - **Done when:** PN-* pass and FR-IMP-05 holds.

- [ ] **T2.2 Email normalisation**
  - **Depends:** T1.1
  - **Spec:** §4.6
  - **Build:** `normaliseEmail` in `lib/contacts/email.ts`, usable in browser and server, with role-address flagging.
  - **Done when:** EN-* pass and FR-EML-02 holds.

- [ ] **T2.3 ContactStore**
  - **Depends:** T1.3, T1.4, T1.8
  - **Spec:** §4.1, §4.2
  - **Build:** read and write protocol behind a `ContactStore` interface: advisory lock, `/tmp` cache by version, immutable version files, compare-and-set pointer, integrity checks, Parquet metadata, read-time defaults and migrate-on-write.
  - **Done when:** WP-01…05, WP-09…11 and EM-02 pass.

- [ ] **T2.4 Suppression service**
  - **Depends:** T1.7
  - **Spec:** §4.4, §9
  - **Build:** one service for both lists; `GET/POST/DELETE /suppression?channel=`; removal needs a reason.
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
  - **Depends:** T2.1, T2.2, T2.3, T2.4, T2.7
  - **Spec:** §5.3 Step 3
  - **Build:** `POST /imports/{id}/validate` and `GET /imports/{id}/rejects`: full-file normalisation, duplicate handling, all three existing-contact policies, suppression counts, `rejects.csv`.
  - **Done when:** FR-IMP-06 and FR-IMP-07 pass, and the validate parts of IS-01…15 pass.

- [ ] **T2.9 Commit and undo**
  - **Depends:** T2.8
  - **Spec:** §4.2, §5.3 Steps 3–4
  - **Build:** `POST /imports/{id}/commit` (with both consent confirmations) and `POST /imports/{id}/undo`, reapplying suppressions after undo.
  - **Done when:** FR-IMP-08, FR-IMP-10, FR-IMP-11, WP-06…08, NFR-01 and all of IS-01…15 pass.

- [ ] **T2.10 `cleanup` cron (stores and imports)**
  - **Depends:** T2.9
  - **Spec:** §10
  - **Build:** `/api/cron/cleanup` with a job lock, deleting old versions (keep 20 plus undo targets), orphan blobs and import sources over 7 days. T5.13 adds the rest.
  - **Done when:** WP-04 and WP-12 pass.

- [ ] **T2.11 S-02 Import wizard**
  - **Depends:** T2.9
  - **Spec:** §5.3, §5.2 (Import)
  - **Build:** all four steps, including the virtualised mapping grid, red and amber cell highlights, consent checkboxes, result card and the "import in progress" state. Add the S-01 Import section.
  - **Done when:** E2E-02, E2E-03 and E2E-04 pass.

- [ ] **T2.12 Gate P2**
  - **Done when:** PN-*, EN-*, IS-01…15, WP-01…12, E2E-02…04, NFR-01, SEC-09 and SEC-11 pass.

---

## P3 Contacts

- [ ] **T3.1 List and filters API**
  - **Depends:** T2.3, T2.4
  - **Spec:** §4.3 (joining), §5.4, §9
  - **Build:** `GET /contacts` with search, every §5.4 filter, stable sort with a `contact_id` tiebreak, suppression and activity overlays.
  - **Done when:** FR-CON-01, CT-01…03 and NFR-02 pass.

- [ ] **T3.2 Selection model**
  - **Depends:** T3.1
  - **Spec:** §5.4, §9 (Selection object)
  - **Build:** shared selection resolver and `POST /contacts/count`.
  - **Done when:** the count matches a reference computed over a fixture, for both `ids` and `filter` modes with `exclude_ids`.

- [ ] **T3.3 Bulk actions and export**
  - **Depends:** T3.2
  - **Spec:** §5.4, §9, §12
  - **Build:** `POST /contacts/bulk` (`tag_add`, `tag_remove`, `opt_out`, `delete`, `export`), each writing one store version; CSV export escaper; short-lived export downloads.
  - **Done when:** FR-CON-03, CE-*, CT-07, CT-12, NFR-03 and SEC-08 pass.

- [ ] **T3.4 Single contact API**
  - **Depends:** T2.3
  - **Spec:** §5.5, §9, §12
  - **Build:** `GET/PATCH/DELETE /contacts/{id}` with the same normalisation as import; soft delete.
  - **Done when:** FR-CON-04, CT-08, CT-09 and the immediate-removal half of CT-11 pass.

- [ ] **T3.5 S-03 Contacts list**
  - **Depends:** T3.3
  - **Spec:** §5.4
  - **Build:** virtualised grid, column chooser, filter UI, range selection, "select all matching", selection in the URL, bulk action bar.
  - **Done when:** FR-CON-02, CT-04, CT-05, CT-06 and SEC-07 pass. CT-04's wizard half is completed in T5.11.

- [ ] **T3.6 S-04 Contact drawer**
  - **Depends:** T3.4, T3.5
  - **Spec:** §5.5
  - **Build:** editable fields, per-channel consent panel, message history for both channels, suppression actions with reasons.
  - **Done when:** FR-CON-05 and CT-10 pass, with seeded `campaign_messages` rows.

- [ ] **T3.7 `apply-suppressions` cron and S-01 Data section**
  - **Depends:** T3.3
  - **Spec:** §4.4, §5.2 (Data), §10, §12
  - **Build:** the cron, version history with restore (reapplying suppressions), contact export, suppression list management. Cleanup removes soft-deleted contacts from future versions.
  - **Done when:** CR-01 and all of CT-11 pass, and a restore cannot re-enable a suppressed contact.

- [ ] **T3.8 Gate P3**
  - **Done when:** CT-01…12, CE-*, NFR-02 and NFR-03 pass. CT-04's wizard half stays open until T5.11.

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
  - **Spec:** §7.1.3, §3.5, D4 in this file
  - **Build:** `WhatsAppProvider`, a single `getWhatsAppProvider()` that forces Mock on previews, and `MockProvider` with latency, real error codes, 10 s template approval and signed fake webhooks. Add `POST /templates/{id}/submit` and `POST /templates/sync`.
  - **Done when:** FR-SET-04, SEC-06 and TP-03 pass. A test proves previews can't construct the real provider.

- [ ] **T5.2 Credentials and S-01 WhatsApp sections**
  - **Depends:** T1.8, T5.1
  - **Spec:** §5.2 (1, 3), §7.1.2, §9
  - **Build:** `PUT /settings/credentials`, `POST /settings/test-connection`, precedence and "set by env var" status, webhook setup card, sending settings, opt-out keywords.
  - **Done when:** FR-SET-02, SEC-04 and SEC-05 pass.

- [ ] **T5.3 Payload builder and send window**
  - **Depends:** T1.1
  - **Spec:** §5.2, §5.8, §7.4, §8.2
  - **Build:** template payload builder with variable mapping and fallbacks; `waitUntil` calculation.
  - **Done when:** SP-* and SW-* pass.

- [ ] **T5.4 Status, error and opt-out logic**
  - **Depends:** T1.1
  - **Spec:** §7.7, §7.8, §8.1
  - **Build:** webhook status reducer; `lib/whatsapp/errors.ts` classifier, kept as data; inbound opt-out detector.
  - **Done when:** ST-*, EC-* and OO-* pass.

- [ ] **T5.5 WhatsApp webhook**
  - **Depends:** T2.4, T5.2, T5.4
  - **Spec:** §7.8, §8.4, §12
  - **Build:** `GET/POST /api/webhooks/whatsapp`: handshake, HMAC check on the raw body, storage in `webhook_events` (D6), status updates, opt-outs, template status, quality alerts. Invalid signatures return 401 (G-13) and are not processed.
  - **Done when:** FR-CMP-06, FR-CMP-07, WS-*, WH-*, WB-01, WB-02 and WB-04…09 pass.

- [ ] **T5.6 Campaign creation**
  - **Depends:** T3.2, T5.3
  - **Spec:** §5.8, §4.3, §9
  - **Build:** `POST /campaigns` with channel-aware exclusions, frozen recipients, template snapshot and rendered params; `GET /campaigns` and `/campaigns/{id}`; `GET /campaigns/{id}/messages`; `POST /campaigns/{id}/preview`; `POST /campaigns/test-send`.
  - **Done when:** FR-CMP-01, FR-CMP-02, FR-CMP-03 (with Mock), CM-01, CM-02 and CM-25 pass.

- [ ] **T5.7 Workflow engine**
  - **Depends:** T5.1, T5.5, T5.6
  - **Spec:** §8.1–8.4, §7.5, D3 in this file
  - **Build:** `runCampaign` with Vercel Workflow; claims with `SKIP LOCKED`; `sendBatch` with re-checks and row-level persistence; token bucket; per-channel queue; scheduling; send-window sleep; one media upload per campaign.
  - **Done when:** FR-CMP-04, FR-CMP-08, CM-03…06, CM-09, CM-10, CM-18, CM-19, CM-21 and CM-26 pass.

- [ ] **T5.8 Retries, controls and circuit breaker**
  - **Depends:** T5.7
  - **Spec:** §5.9, §7.6, §7.7, §8.3, §8.5, §9
  - **Build:** `POST /campaigns/{id}/start`, `/pause`, `/resume`, `/cancel`, `/retry-failed`, `/resend-unknown`; backoff and rate halving; `pause_reason`; stop-all behaviour for 131031 and 368.
  - **Done when:** FR-CMP-05, CM-07, CM-08 and CM-11…17 pass.

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
  - **Build:** Steps 0–5 for WhatsApp, typed-count confirmation, test send. Step 0 appears with email disabled until T8.8.
  - **Done when:** CM-24 and the wizard half of CT-04 pass.

- [ ] **T5.12 S-08 monitor, S-09 list, global banner**
  - **Depends:** T5.8, T5.10, T5.11
  - **Spec:** §5.1, §5.9, §5.10, §8.6
  - **Build:** live counters, controls, failures table and export; campaign list with queue view; the sending banner on every screen.
  - **Done when:** E2E-01 and E2E-05 pass.

- [ ] **T5.13 Remaining crons**
  - **Depends:** T2.10, T5.8, H-1
  - **Spec:** §8.3, §10
  - **Build:** `sync-templates` and `reconcile-campaigns`, the remaining cleanup work, a shared job lock, and the full schedule in `vercel.ts`.
  - **Done when:** CR-02, CR-03 and CR-04 pass.

- [ ] **T5.14 Gate P5**
  - **Done when:** SP-*, ST-*, EC-*, OO-*, WS-*, WH-*, SW-*, CM-01…26 (CM-23 stays with P6), WB-01…09 (WB-03 re-run in P7), CR-01…04, TP-03, E2E-01, E2E-05 and SEC-04…08 pass on a preview deployment.

---

## P8 Email (mock)

- [ ] **T8.1 Email provider, `.local.bin` and S-01 Email section**
  - **Depends:** T5.2
  - **Spec:** §5.2 (2), §7A.1, §7A.2, D2 in this file
  - **Build:** `EmailProvider`, `MockEmailProvider` (idempotency keys, Svix-signed webhooks, `@bounce.test` and `@complain.test`), provider selection, the `.local.bin` loader, `GET /settings/email-domain` and the full S-01 Email section.
  - **Done when:** FR-SET-06, FR-SET-07, SEC-12…16 pass.

- [ ] **T8.2 Email renderer and unsubscribe tokens**
  - **Depends:** T1.1
  - **Spec:** §5.12, §7A.4, §7A.5
  - **Build:** block-to-React-Email renderer with deterministic output and correct escaping; `/emails/batch` element builder; token sign and verify with secret rotation.
  - **Done when:** FR-EML-04 (payload half), EP-*, EM-08, UT-* and EM-28 pass.

- [ ] **T8.3 Email templates and S-11**
  - **Depends:** T4.2, T8.2
  - **Spec:** §5.6, §5.12, §9
  - **Build:** email validator (no golden exists, so write the table from §5.12); `POST /templates/{id}/ready`, `/render`, `POST /email-assets/upload-token`; S-11 designer; S-05 Email tab.
  - **Done when:** FR-EML-03, FR-EML-04 (footer half), EM-05, EM-06 and EM-07 pass.

- [ ] **T8.4 Resend webhook and email reducer**
  - **Depends:** T2.4, T8.1
  - **Spec:** §7A.8, §8.1, D5 in this file
  - **Build:** `POST /api/webhooks/resend`: Svix check, `svix-id` dedupe, matching by id then `message_id` tag, status reducer, suppression, link click counts.
  - **Done when:** FR-EML-08, FR-EML-09, ES-*, RS-*, EM-21…25 pass. EM-25's campaign half is completed in T8.6.

- [ ] **T8.5 S-12 Unsubscribe page**
  - **Depends:** T2.4, T8.2
  - **Spec:** §5.13
  - **Build:** public `/u/{token}`: GET confirms, POST unsubscribes (including RFC 8058 one-click), masked address, generic invalid page.
  - **Done when:** FR-EML-10, EM-29, EM-30 and SEC-17 pass.

- [ ] **T8.6 Email in the campaign engine**
  - **Depends:** T5.8, T8.1, T8.2
  - **Spec:** §5.8, §7A.6, §7A.7, §8.2, §8.3
  - **Build:** email exclusions and duplicate-address handling at creation; `sendBatch` with `batch_key`, byte-identical retries, the 23-hour rule, 422 splitting; daily cap hold; separate queues per channel. Add `lib/email/errors.ts`.
  - **Done when:** FR-EML-05, FR-EML-06, FR-EML-07, EM-09, EM-11…20, EM-34 and EM-35 pass.

- [ ] **T8.7 Email circuit breaker**
  - **Depends:** T8.6
  - **Spec:** §8.5
  - **Build:** bounce and complaint thresholds, plus the 7-day complaint block with acknowledgement.
  - **Done when:** FR-EML-11, EM-26 and EM-27 pass.

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
  - **Done when:** EN-*, EP-*, ES-*, RS-*, UT-*, EM-01…36 and SEC-12…18 pass.

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
  - **Depends:** T6.3, H-5
  - **Spec:** §7B, §13
  - **Build:** follow §7B on Production with the test number first. Replace hand-written fixtures with recorded responses, with secrets and phones scrubbed.
  - **Done when:** FR-SET-03, LIVE-01, LIVE-02 (status arrives via `sync-templates` if the webhook isn't connected yet) and LIVE-03 pass. LIVE-01 must also show the messaging limit.

---

## P7 Webhooks live and hardening

- [ ] **T7.1 `[LIVE]` Register the production webhook**
  - **Depends:** T6.4, H-4, H-5
  - **Spec:** §7.8, §7B Step 7
  - **Build:** complete Step 7, including `subscribed_apps` and Live mode, and confirm Deployment Protection doesn't cover the route.
  - **Done when:** LIVE-02 passes via the webhook and LIVE-04 passes.

- [ ] **T7.2 Load, accessibility and tuning**
  - **Depends:** T5.14
  - **Spec:** §8.5, §11
  - **Build:** run the load tests, fix what they find, tune breaker defaults, fix accessibility issues on every screen.
  - **Done when:** NFR-04, WB-03 and E2E-06 pass.

- [ ] **T7.3 Gate P6 and P7**
  - **Depends:** T7.1, T7.2
  - **Done when:** TP-04…09, CM-23, LIVE-01…05, NFR-04, WB-03 and E2E-06 pass, and a full re-run of every earlier gate passes.

---

## P9 Email live

- [ ] **T9.1 ResendProvider**
  - **Depends:** T8.10
  - **Spec:** §7A.3, §7A.7
  - **Build:** `ResendProvider` with the `resend` SDK, replaying a response for every §7A.7 row and every webhook event type through MSW. No key needed.
  - **Done when:** contract tests pass and the engine's actions match §7A.7.

- [ ] **T9.2 `[LIVE]` Verify the domain and smoke test**
  - **Depends:** T9.1, H-4, H-6, H-7
  - **Spec:** §7A.1, §7A.5, §13
  - **Build:** add the key, verify the domain from S-01, add DMARC, register the webhook, then run the smoke tests.
  - **Done when:** LIVE-EM-01…04 pass.

- [ ] **T9.3 Gate P9**
  - **Depends:** T9.2
  - **Done when:** LIVE-EM-01…04 pass and EM-34 and EM-35 pass in a re-run with `ResendProvider` replaced by the mock at the HTTP level, so load never reaches Resend.

---

## Decisions to confirm

I found these while turning the spec into tasks. Each has a default so work can continue; the agent follows it unless told otherwise.

| ID | Problem in the spec | Default | Tasks |
|---|---|---|---|
| D2 | §7A.1 uses `process.loadEnvFile`, which doesn't overwrite variables that are already set (tested on Node 25). If Next.js has already loaded `.env.local`, its value beats `.local.bin` and SEC-13 fails | Parse the file with `util.parseEnv` and assign values explicitly. Confirm with SEC-13 | T8.1 |
| D3 | The §8.2 sketch uses `s` outside the loop where it's declared, and `return` on `cancelled` skips starting the next campaign, which CM-10 requires | Treat the sketch as pseudocode. Cancelling starts the next queued campaign. A paused campaign also releases its slot, and resuming re-enters the queue | T5.7 |
| D4 | Mock webhooks call the app's own URL, which Vercel Deployment Protection may block on previews. Vercel Cron also only runs on Production | Send Mock webhooks through the signed route using a protection-bypass secret. On previews, E2E tests trigger cron routes directly | T5.1, T5.14 |
| D5 | S-08 needs clicks per URL (§5.9), but §4.3 has nowhere to store them. Skip reasons (`EMPTY_VARIABLE`) have no column either | Add `email_link_clicks(campaign_id, url, clicks)`. Store skip reasons in `error_code` | T1.4, T8.4 |
| D6 | §8.4 dedupes Meta webhooks by payload hash, but `webhook_events` only describes `external_id` for Resend | Store the SHA-256 of the raw body in `external_id` for Meta | T5.5 |
| D7 | §3.4 puts all Blob files in a private store but needs `email-assets/` public, and §12 assumes signed URLs on private Blob | Settle in the T1.3 spike. Likely a second, public store for `email-assets/` only, and session-checked download routes if signed URLs aren't available | T1.3 |
| D8 | §14 puts schema v2 in P8, but §4.1 already specifies v2 and the P2 goldens need email fields | Write schema v2 from P2. Still test migration from older files (WP-10, EM-02) | T2.2, T2.3, T2.8 |
| D9 | §15 has open questions that affect the build | Q2: both email code and Google (§5.1). Q3: no STOP confirmation reply. Q5: phone stays required. Q9: keep `.local.bin` | T1.5, T5.5 |
| D10 | The advisory lock must be held across a whole write (§4.2), which HTTP-only Postgres drivers can't do | Use a pooled or WebSocket driver for write paths | T1.4, T2.3 |
| D11 | `FR-SET-03` and `LIVE-01` don't check that Test connection shows the messaging limit (§5.2) | Check it in T6.4, and update both texts when convenient | T6.4 |
