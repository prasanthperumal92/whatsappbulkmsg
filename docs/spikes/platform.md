# Platform spike (T1.3)

**Status: mostly done. T1.3 stays open.** Measured on 2026-11-02 on throwaway preview deployments in `sin1`, using `workflow` 5.2.3. The spike code was not committed. Two things keep T1.3 open: the public store half of SPK-05, and T1.2.

| Eval | Question | Result |
|---|---|---|
| SPK-01 | How does Vercel Workflow retry a killed step? | **Pass.** See below |
| SPK-02 | Pinning across deploys; does a restarted run use the new deployment? | **Pass.** See below |
| SPK-03 | Events per run through the §8.2 loop; hand-off count | **Pass. Keep the hand-off at 1,000 batches** |
| SPK-04 | Which Parquet writer works on a deployment? | **Pass: `hyparquet-writer`** |
| SPK-05 | Private client uploads, signed downloads, public `email-assets/` | **Partial.** Private works, public not run |
| WP-11 | Snapshot metadata and compression | **Pass** on a deployment |

## SPK-01: killed step

A step called `process.exit(1)` on its first attempt. It was retried and succeeded on attempt 2, about 1.7 s later, and the run completed. A step that threw a plain error also succeeded on attempt 2. The default is 3 retries (`maxRetries`).

**This needs care in P5:** a retried step runs again from the top, so `sendBatch` must rely on the per-row `sending` state and idempotency keys in §8.2.

## SPK-02: pinning

| Run | Started on | Before the wait | After the wait |
|---|---|---|---|
| Asleep for 4 minutes while a new deployment went live | A | A | **A** |
| Started after that deployment | B | B | B |

A sleeping run stays on its old deployment, and a new run uses the new one, as §8.2 assumes. The second row was started directly on deployment B, which is what a restart does. The park and restart logic itself is P5 code and wasn't run.

## SPK-03: 1,000 batches

A mock loop of three steps per batch (`loadControlState`, `claimBatch`, `sendBatch`), with 10 short sleeps.

| Measure | Result | Limit from §C13 |
|---|---|---|
| Steps | 3,000 | 10,000 |
| Events | 9,023 | 25,000 |
| Time, with no pacing | 367 s, about 8 steps per second | |

So each step costs three events. Step overhead was about 0.12 s, which is small next to the 2.5 s a 50-row batch takes at 20/s. **Not covered:** retries, which add events, and `prepareMedia` and `finalizeIfDone`. A run would need well over 2,000 extra steps' worth of events to matter. The limits are the ones C13 quotes. I couldn't confirm them from the SDK's bundled docs.

## SPK-04 and WP-11: snapshot on a function

50,000 contacts written by the real `writeSnapshotFile`, on Node 24.22 in `sin1`.

| Measure | Result |
|---|---|
| Write time | 1.14 s |
| File size | 1.15 MB |
| Process memory afterwards | 294 MB |
| Rows read back | 50,000 |
| Codec | ZSTD only |
| Metadata | All `app.*` keys, `app.row_count` = 50,000 |

`node:zlib` ZSTD works on the Vercel runtime, so **the writer is `hyparquet-writer`**. Excluding soft-deleted contacts is covered by the WP tests, not this synthetic file.

## SPK-05: storage

| Check | Result | Where it ran |
|---|---|---|
| Write, read, list and delete on the private store | Works | Local machine |
| Client token upload, including 7 MB multipart | Works | Node on the local machine, **not a browser** |
| Token refuses a wrong type and an oversized file | Works | Local machine |
| Signed URL | 200, then 403 after expiry | Deployment |
| URL without its signature | 403 | Local machine |
| Public `email-assets/` read | **Not run.** The store has no token until it is connected to the project | |

## Found on the way

- `lib/storage/blob.ts` made Turbopack trace the whole project into every function. Fixed; the warning is gone on a clean deployment.
- Workflow needs `.well-known/workflow/` excluded from the `proxy.ts` matcher, and `withWorkflow` around the Next config. Neither is in the repo yet: P5 adds them with the `workflow` package.

## Parquet writer: why `hyparquet-writer`

Measured on 2026-11-02 on Linux x64 with Node 24.19, writing 50,000 synthetic contacts with 14 §4.1 columns. The script was throwaway and isn't in the repo. Peak RSS is for the whole process, which also held the test rows, and the DuckDB figure comes after the first run, so compare it only roughly.

| | `hyparquet-writer` 0.18 + `node:zlib` ZSTD | DuckDB (`@duckdb/node-api` 2.0.0-r.1) |
|---|---|---|
| Time | 244 ms | 214 ms |
| File size | 1.23 MB | 1.27 MB |
| Peak RSS | 356 MB | 443 MB |
| Install size | 0.5 MB, pure JS | 92 MB native binary, per platform |
| ZSTD on every column chunk | Yes | Yes |
| `app.*` key/value metadata | Yes | Yes |
| Rows read back, with nulls intact | 50,000 / 5,000 null phones | 50,000 / 5,000 null phones |

DuckDB also read the `hyparquet-writer` file correctly, which is an independent check that the file is valid.

**Why this choice:** output and speed are equivalent at our scale (D8: under 50k contacts), so the deciding factor is deployment risk. SPEC §3.2 names DuckDB first and `hyparquet-writer` as the fallback "if the native binary causes trouble", and leaves the choice to this spike. Avoiding a 92 MB native binary removes that trouble altogether.

**Trade-off:** `hyparquet-writer` builds the file in memory rather than streaming it to `/tmp` as §4.2 describes. That's fine at 50k rows, but needs another look if the contact count grows far beyond D8.

**Confirmed on a deployment:** see SPK-04 above.
