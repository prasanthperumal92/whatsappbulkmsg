# P2 Import: build reflection

Date: 2026-11-02. Branch: `p2/import`, based on `p1/foundation`, not pushed.

## Verdict

**The code for P2 is written and passes locally, but P2's gate (T2.13) can't pass yet.** Only T2.1, T2.2 and T2.12 are ticked. Every other P2 task depends on a P1 task that is still open, and T1.2, T1.3 and T1.4 need real infrastructure. TASKS.md says to tick a task only when its dependencies are ticked, so the rest stay open.

## Status

| Task | Status | What's left |
|---|---|---|
| T2.1 Phone, T2.2 Email, T2.12 Country and zone | **Done, ticked** | Nothing |
| T2.3 ContactStore, T2.4 Suppression, T2.7 Mapping | Code done, own checks pass | T1.4, T1.7 and T1.8 |
| T2.5 Upload, T2.6 Detection | Code done, own checks pass locally | T1.3 (SPK-05), and the Blob stores (H-2) |
| T2.8 Validate, T2.9 Commit and undo | Code done, own checks pass locally | Dependencies above |
| T2.10 Snapshots | Code done, own checks pass locally | T1.3 (SPK-04 on a deployment), Blob stores, and the hourly cron (H-1) |
| T2.11 Wizard | Code done, E2E-02…04 pass locally with the Clerk stand-in | A real deployment |
| T2.13 Gate | Can't pass yet | See below |

## Gate evals

| Eval | Result |
|---|---|
| PN-*, EN-*, TZ-*, MA-* | Pass (unit) |
| IS-01…18 | Pass, on local Postgres and the local blob directory. IS-09's export half is P3 |
| WP-01…14, CR-01, EM-02 | Pass, same environment |
| SEC-09, SEC-11, AU-02 | Pass |
| E2E-02…04 | Pass in Chromium, locally. E2E-02's "no 4.5 MB error" is **not proven**: locally the file goes through the app, not to Blob |
| NFR-01 | 4.2 s against the 60 s target, but on local Postgres on this machine. **Not evidence for Neon** |

### Evidence

From a fresh clone at `a40881e`: type check and `evals:check` pass, 358 Vitest tests pass, the production build passes, `test:proxy` passes, and `npm audit --omit=dev` reports 0. In the working copy at `e210334`, 11 of 11 browser tests pass. The one later commit changes the cron schedule and a banner's wording, and only the type check and Vitest were re-run after it.

**Never run:** the `VercelBlobStore` adapter, the browser's direct upload to Blob, signed download URLs, and the crons on Vercel. They have type checks and nothing else. `SPK-05` is the task meant to prove them, and the installed `@vercel/blob` is newer than anything in the spec, so this is the likeliest part of P2 to need changes.

## Critique

**Deliberate breaks.** All tests passed on the first run, which proves little, so I broke the code on purpose in 22 ways.

| Result | Breaks |
|---|---|
| Caught | 16 |
| **Real test gaps, now fixed and caught** | Removing the email consent check; accepting any upload path; snapshot isolation (the first WP-09 test edited contacts too late to exercise it) |
| Not real: behaviour didn't change | Removing the early opted-out return, and removing the `email_opt_in_status` default. Later code enforces both, and the second line is now deleted |
| My mistake | The first WP-03 break was a no-op. A proper one was caught |

**Bugs and mistakes found on the way**

1. `Promise.all` on a single transaction connection. The tests passed, and only a `pg` deprecation warning showed it. Fixed.
2. I committed T2.3–T2.10 with a type error in a test file, because I read the test results and not the type-check output. Fixed in the next commit.
3. The first E2E-02 fixture had 1.4 million rows, over the 200k limit. The app was right to refuse it.

**What held up**

- Validate and commit share `buildPlan`, so commit re-matches with exactly the rules the user saw.
- A forced failure in WP-04 is a real database trigger, so production code needs no test hook.
- The server recomputes the file's SHA-256, so the browser can't mis-claim a duplicate.

**Weak, or worth watching**

- **Memory.** The file and all its rows are held in memory during validate and commit, and snapshots are built in memory. That's fine at D8's scale. A 50 MB, 200k-row file is untested on a function.
- **Long transactions.** `withAudit` opens its transaction before the file is read, so a connection sits idle in a transaction during the Blob read. It holds no locks at that point, but check it against Neon's pooler.
- **Commit is one request, not polled.** §5.3 says the UI polls. It waits for the response, and other users see the in-progress state by polling `/api/imports/active`.

## Things to decide or report

TASKS.md says to report mismatches rather than resolve them quietly. No golden or scenario was changed.

1. **The Vercel team is on Hobby (needs a decision).** Vercel's API reports the plan as `hobby`. Vercel documents Hobby as daily crons only, with deployments asking for more refused, though I haven't tried one on this account. So §10's hourly `snapshot-contacts` runs **daily** for now. P5 needs crons every 5 minutes, so H-1 will block that regardless. Hobby is also for non-commercial use, which this isn't.
2. **`rejects.csv` isn't escaped against formula injection.** §12 requires this for "CSV export", and the rejects file repeats untrusted cells that someone will open in Excel. IS-01 asks it to keep the original columns, and CE-* is wired in P3, so I left it. I recommend applying the P3 escaper to this file too (T3.3).
3. **Adding a phone under the Skip policy.** §4.7 says a phone is added to a matching email-only contact, with no exception for Skip, so it's added. Someone who chose Skip might not expect that.
4. **A later row in the same file adds a phone to an email-only contact created earlier.** It counts as a duplicate, but the phone is kept, not dropped. "First occurrence kept" could be read as dropping it, and that would lose data.
5. **Departures from the spec's mechanism, same behaviour.** §4.2's temporary table is replaced by in-memory matching under the lock plus JSON bulk writes. §5.3's `upload()` is replaced by `put()` with a token from our route, because the path must be known first.
6. **Additions beyond the spec's lists:** `GET /api/imports/active`, a dev-only `PUT /api/imports/local-upload` that refuses to run with a real store, three `import_batches` columns, and an extra audit action for upload authorisation. Campaign links on the result card go to the plain Campaigns page until P5, and the contacts filter arrives in P3.

## Next steps

1. **You:** decide on the plan (H-1) and create the two Blob stores (H-2), in Singapore to match the database and functions (§3.1). T1.2 remains open.
2. Run the P1 spikes on a preview deployment, especially SPK-05, then tick T1.4, T1.8 and the others.
3. Run IS-*, WP-* and NFR-01 against a Neon test branch with `TEST_DATABASE_URL`. **Never point it at a shared branch: the test setup drops the schema.**
4. Tick T2.3–T2.11, then run the T2.13 gate.
