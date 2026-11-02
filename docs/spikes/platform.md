# Platform spike (T1.3)

**Status: partly done. T1.3 stays open.** Everything except the local Parquet measurement needs a Vercel project (T1.2), and no Vercel resources have been created.

| Eval | Question | Status |
|---|---|---|
| SPK-01 | How does Vercel Workflow retry a killed step? | Not run: needs a preview deployment |
| SPK-02 | Pinning across deploys; does a parked campaign restart on the new deployment? | Not run: needs a preview deployment |
| SPK-03 | Events per run through the §8.2 loop; hand-off count | Not run: needs a preview deployment |
| SPK-04 | Which Parquet writer works on a deployment? | **Measured locally only**, see below. Must be repeated on a deployment |
| SPK-05 | Private client uploads, signed downloads, public `email-assets/` | Not run: needs the Blob stores (H-2) |
| WP-11 | Snapshot metadata and compression | Writer output meets it (below). The real `SnapshotService` comes in T2.10 |

## Parquet writer: provisional choice `hyparquet-writer`

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

**To confirm on a deployment:** that `node:zlib` ZSTD is available on the Vercel runtime (it needs Node 22.15 or later), and the memory used inside a function.
