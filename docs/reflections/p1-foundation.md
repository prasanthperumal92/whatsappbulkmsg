# P1 Foundation: build reflection

Date: 2026-11-02. Branch: `p1/foundation`, not pushed. This records what was built, a critique of how it was built, and the two review rounds.

## Verdict

**P1 isn't finished, and its gate (T1.11) can't pass yet.** Only T1.1 is ticked. All the code that doesn't need an account is written and tested locally, but nearly every other **Done when** requires a real Vercel, Clerk or Neon environment, and those come from the `[HUMAN]` task T1.2.

I stopped after round 2 because it found no major problems in the code. What remains is blocked on people and accounts, and another review round wouldn't change that.

## Status

"Code done" means the code is written and passes locally, but the task isn't ticked because its **Done when** or a dependency is still open.

| Task | Status | What's left |
|---|---|---|
| T1.1 Scaffold | **Done, ticked** | Nothing |
| T1.2 `[HUMAN]` Vercel and services | Not started, on purpose | H-1, H-2, and `docs/clerk-setup.md` |
| T1.3 Platform spike | Partial | SPK-01, 02, 03 and 05 not run. SPK-04 measured locally only |
| T1.4 Schema | Code done | Apply the migrations to an empty Neon branch |
| T1.5 Sign-in and allowlist | Code done | H-3, and SEC-01 with real Clerk |
| T1.6 App shell | Code done | See the Mock banner on a real preview |
| T1.7 Audit and logging | Code done | Depends on T1.5. Extend AU-01 as routes are added |
| T1.8 Environment and settings | Code done; its own checks all pass | Depends on T1.4 |
| T1.9 CI and migrations | Files only | Workflow has never run on GitHub. Branch protection and the merge-blocking proof are outstanding |
| T1.10 Test harness | Not started | Depends on T1.3, T1.5 and T1.9 |
| T1.11 Gate | Can't pass yet | See below |

### Gate evals

| Eval | Result |
|---|---|
| SEC-02 no session | Passes locally, plus the real SDK proxy check |
| SEC-03 cron secret | Passes locally, plus the real SDK proxy check |
| SEC-10 phone masking | Passes (unit level, as the eval specifies) |
| AU-01 audit rows | Passes for existing routes, on local Postgres rather than Neon |
| SEC-01 non-allowlisted sign-in | **Not proven.** The allowlist refusal passes with a stand-in for Clerk. Real sign-in and Restricted mode are unverified |
| SPK-01, 02, 03, 05 | **Not run** |
| SPK-04 | Measured locally only; the eval requires a deployment |
| WP-11 | Writer output meets it, but the real `SnapshotService` is T2.10 |
| HN-01, 02, 03 | **Not run** (T1.10) |

### Evidence

From a fresh clone at commit `0d4c0f2` (`npm ci`, then each check):

- Type check and `evals:check` pass (295 golden cases, 190 scenarios, 51/51 FRs).
- 130 Vitest tests pass, including integration tests on a real throwaway Postgres.
- The production build passes.
- `test:proxy` passes 16 of 16 checks against the real Clerk SDK with placeholder keys.
- 4 of 4 browser tests pass in Chromium, using the Clerk stand-in.
- `npm audit --omit=dev` reports 0 vulnerabilities.

**Not evidence of production behaviour:** local Postgres is version 18 and Neon's version may differ. No real Clerk account, Vercel deployment or GitHub Actions run has touched this code. `vercel.ts` is type-checked, but Vercel has never read it.

## Critique of the thought process

**What held up**

- **Treating T1.2 as a hard stop.** The Vercel CLI was logged in, so provisioning was technically possible. But the team also hosts live production projects, and the task is explicitly `[HUMAN]`, so I only ran read-only listing commands.
- **Not ticking tasks to look finished.** It would have been easy to tick T1.6 or T1.8 on local evidence. The tick rule is clear, and a false tick would make later work trust things nobody has checked.
- **Real Postgres over an in-memory substitute.** Partial indexes, row locks and transactions behave for real, and this is the same engine family as production.
- **Asking "what can't my tests see?"** This produced the most valuable finding of the build (next section).

**What didn't**

1. **Testing through my own fake gave false confidence.** With all tests passing, the real Clerk SDK still sent signed-out users to Clerk's hosted page instead of `/sign-in`. The stand-in was written from my assumptions, so it shared them. I should have run the real SDK before building on it, not during review.
2. **Too much batching.** Very large writes mixed T1.5, T1.6 and T1.7 together, so failures arrived in clumps and commits had to be split by path afterwards. Two commits still carry two task IDs each.
3. **Trusted guidance without checking it.** The skill's advice on Geist font names didn't match what the `geist` package emits. The page silently used a fallback font, and I only noticed it in a screenshot.
4. **Added a dependency without auditing it.** `@vercel/functions`, added as a round 1 improvement, brought in a high-severity advisory (a nested `zod`). Round 2 caught it, but only because I ran the audit at the end.
5. **A careless command.** A cleanup `pkill` pattern included `next-server`, which could have stopped any other Next.js server of yours running at that moment, and it killed its own shell. I switched to stopping specific PIDs. **If a dev server of yours stopped around 17:45 IST, this is why.**
6. **A weak assertion, caught while fixing something else.** One test accepted either 201 or 400 for a pasted email, which tests nothing. It now requires 201, and the API trims the input.

## Critique of the output

**Strong**

- **Protection by construction.** Each route must use a wrapper, and the route-table test finds routes from the filesystem, so a new route can't be forgotten.
- **The audit row and the change share one transaction.** Neither can exist without the other.
- **Safety defaults fail closed.** An unset `CRON_SECRET` refuses everything, an unrecognised Vercel environment counts as production so Mock can't run, and the allowlist is checked on every request.

**Weak, or worth watching**

- **The invitation flow is a design decision of mine, and it's unverified.** The spec says "allowlist, no public sign-up" but not how. I chose Clerk's Restricted mode with an invitation on each Team add. Whether a new member can actually complete sign-up, including through Google, is unknown until T1.2. It's the likeliest part of P1 to need rework.
- **Thin UI coverage.** Four browser tests cover the main paths. There's no automated accessibility check, even though one caught-by-accident bug was exactly that (the "no access" page had no heading). T7.2 covers this, but it's a long way off.
- **The Settings page shows only Team.** That matches T1.5, but it isn't yet the S-01 screen in the wireframe. T1.8 built the API behind the other sections.
- **CSRF relies on Clerk's `SameSite=Lax` cookie.** There's no separate origin check on state-changing routes. I think that's enough here, but a security review should confirm it.
- **Logging masks by pattern and field name.** A phone number in an unusual format, in free text, under an unrecognised key, could still get through. Import errors in P2 are the first real test of this.
- **`/api/audit` filter options scan the log.** That's fine now, but worth checking as the log approaches its 24-month size.
- **14 advisories remain in dev-only tools,** such as `drizzle-kit` and the `shadcn` CLI. None is in the production dependency tree.

## Review rounds

### Round 1: try to break it from outside

Booted the production build with the real Clerk SDK, and re-ran from a fresh clone.

| Finding | Severity | Action |
|---|---|---|
| Signed-out users sent to Clerk's hosted page, not `/sign-in` | **Major** | Fixed in `proxy.ts` |
| Nothing in CI could catch a real-SDK mistake, such as Clerk redirecting webhooks | **Major** | Added `test:proxy` and a CI step |
| Public patterns too loose (`/api/webhooksfoo` skipped the proxy check) | Medium | Now exact. The route wrappers already protected it |
| Raw-format phone values such as `098765 43210` weren't masked in phone fields | Medium | Masked by field name |
| Stand-in for Clerk could in principle be built for production | Medium | Now refused for anything except `next dev` |
| Failed invitation gave a generic 500 | Low | Clear 502 message, and the change rolls back |
| No error page if the database is down, and expired sessions just showed errors | Low | Error boundary and redirect to sign-in |
| Webhook tasks would have had no approved wrapper to use | Low | Added `withWebhook` for T5.5 and T8.4 |
| Connections not managed for Fluid Compute suspension | Low | Added `attachDatabasePool` |

### Round 2: do the safety nets actually catch things?

Broke the code on purpose, and each check had to fail. T1.5 asks for a test that fails on an unprotected route, and a passing test can't show that.

| Deliberate break | Caught by |
|---|---|
| New route with no protection | Route-table test (3 failures) |
| State-changing route with no audit | Route-table test (1 failure) |
| Cron route with no secret check | Route-table test (3 failures) |
| `withAudit` stops writing the row | Audit tests (4 failures) |
| Allowlist check removed | Route-table test (7 failures) |
| Env-var precedence removed from secrets | Secrets test (1 failure) |
| Proxy loses the sign-in path and the webhook exemption | `test:proxy` (4 failures) |

Round 2's one new finding was the `zod` advisory (item 4 above). I moved the `shadcn` CLI to dev dependencies and pinned the patched `zod` with a scoped override, which took production advisories to 0. It didn't call for a third round, and two is the agreed limit in any case.

## Things to decide or report

TASKS.md says to report mismatches rather than resolve them quietly. None of these changed a golden or a scenario.

1. **Preview data (needs a decision at T1.2).** §14 asks for a Neon branch per preview, but §12 says production contacts must never appear on previews, and a Neon branch made from `main` copies all its data. `docs/clerk-setup.md` recommends a schema-only parent branch. This is the most important item here, because it's a privacy problem that no test would flag.
2. **Parquet writer.** §3.2 names DuckDB first. My provisional choice is the fallback, `hyparquet-writer`, for the reasons in `docs/spikes/platform.md`. It builds the file in memory, where §4.2 describes streaming to `/tmp`.
3. **FR-SET-06 and the wireframe's provider picker.** A Resend key in the environment moves local email off Mock automatically, so with a key present, picking Mock does nothing. T8.1 needs to settle this.
4. **Additions beyond the spec's lists:**
   - `/api/cron/ping`, because SEC-03 needs a cron route and none exists until T2.10.
   - `/sign-in` and `/not-allowed`. T1.5 says to exempt "only" three paths, but a sign-in page has to be public.
   - A database check that an email-only contact can't be `opted_in` for WhatsApp, enforcing a rule §4.1 states in prose.
   - `include_unknown_ack_by` and `include_unknown_ack_at` columns, for §4.3's "with acknowledgement user and time".
   - A guard against removing the last team member.
5. **Workflow.** TASKS.md asks for one pull request per task. This is one branch with commits labelled by task, because `gh` isn't installed and CI can't run until T1.2.

## Next steps

1. **You:** do T1.2, H-1, H-2 and H-3, following `docs/clerk-setup.md`.
2. Run the migrations on a Neon branch, then tick T1.4 and T1.8.
3. Verify real sign-in and SEC-01, then tick T1.5, T1.6 and T1.7.
4. Push, confirm CI runs and blocks a failing merge, and finish T1.9.
5. Run the Workflow and Blob spikes (T1.3), then build T1.10 and run the gate.

**P2 needn't wait for most of this.** T2.1, T2.2 and T2.12 depend only on ticked or pure code, and P2's other tasks can be built the same way, though TASKS.md says not to start the next phase before the gate unless the dependencies allow it.
