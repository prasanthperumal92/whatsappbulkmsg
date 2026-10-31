# Evaluations — WhatsApp Bulk Messenger

An acceptance suite derived from [`SPEC.md`](../SPEC.md) v2.1, written before the implementation exists. It defines what "correct" means in terms you can check, so tests in each delivery phase (§14) can be wired straight to it.

| Path | What it is |
|---|---|
| `golden/*.json` | Input → expected-output tables for pure logic. Load them in Vitest with `describe.each` / `it.each`. |
| `fixtures/generate.mjs` | Generates the import CSVs byte-for-byte (encodings, BOMs, CRLF). `--large` adds the 50k-row file. |
| `golden/import-summaries.json` | Expected analyze / validate / commit results for each fixture. |
| `SCENARIOS.md` | Behavioural evals (concurrency, durability, timing, access, E2E, performance) as pass/fail rows. |
| `check.mjs` | Checks the suite itself: valid JSON, unique ids, every `FR-*` in SPEC.md covered, every spec gap listed below. |

```sh
node evals/fixtures/generate.mjs          # writes evals/fixtures/*.csv
node evals/fixtures/generate.mjs --large  # + large-50k.csv (git-ignored)
node evals/check.mjs
```

## Golden tables

| File | Spec | Cases | Wire to |
|---|---|---|---|
| `phone-normalisation.json` | §4.5 | PN-01…32 | `normalisePhone(raw, { countryCode, defaultCountry })`, browser and server (same rules) |
| `template-validation.json` | §5.7 | TV-01…31 | Template validator; codes are this suite's vocabulary, so map them in one place |
| `send-payload.json` | §7.4, §5.8 | SP-01…06 | Payload builder + variable mapping / fallbacks |
| `status-transitions.json` | §7.8, §8.1 | ST-01…16 | Webhook status reducer |
| `error-classification.json` | §7.7 | EC-01…22 | `lib/whatsapp/errors.ts` classifier |
| `opt-out-detection.json` | §7.8 | OO-01…15 | Inbound message → suppress? |
| `webhook-signature.json` | §7.8, §12 | WS-01…09, WH-01…04 | Signature check (real HMACs, exact raw bodies) and GET handshake |
| `send-window.json` | §5.2, §8.2 | SW-01…10 | `waitUntil` computation (UTC in, UTC out) |
| `csv-export-escaping.json` | §12 | CE-01…12 | Export cell escaper |
| `import-summaries.json` | §5.3, §6.1 | IS-01…15 | Import service against a test Neon branch + Blob |
| `email-normalisation.json` | §4.6 | EN-01…18 | `normaliseEmail(raw)`, browser and server |
| `email-send-payload.json` | §7A.4, §7A.5 | EP-01…10 | Email renderer + `/emails/batch` element builder |
| `email-status-transitions.json` | §8.1, §7A.8 | ES-01…25 | Email webhook status reducer + suppression |
| `email-webhook-signature.json` | §7A.8 | RS-01…13 | Resend (Svix) signature check; real HMACs, cross-checked against `svix@1.40.0` |
| `unsubscribe-token.json` | §7A.5 | UT-01…08 | Unsubscribe token sign/verify (real HMACs) |

Phone goldens were checked against `libphonenumber-js/max` 1.x with a reference implementation of §4.5. Several obvious-looking cases behave differently from what you'd guess (`+91 12345 67890` is **valid**; `919876543210` without `+` is accepted as Indian), so keep the library version pinned and re-run PN-* when you upgrade it.

Example wiring:

```ts
import golden from '../../evals/golden/phone-normalisation.json';
describe.each(golden.cases)('$id $raw', ({ raw, country_code, expect: want }) => {
  it('normalises', () => expect(normalisePhone(raw, { countryCode: country_code })).toEqual(want));
});
```

## Phase gates

Each phase in §14 is done when its evals pass:

| Phase | Must pass |
|---|---|
| P1 Foundation | SEC-01…03, SEC-10, AU-01 (for what exists), WP-11 spike (DuckDB on Vercel, R7) |
| P2 Import | PN-*, IS-01…15, WP-01…12, E2E-02…04, NFR-01, SEC-09, SEC-11 |
| P3 Contacts | CT-01…12, CE-*, NFR-02, NFR-03 |
| P4 Templates | TV-*, TP-01, TP-02 |
| P5 Campaigns (mock) | SP-*, ST-*, EC-*, OO-*, WS-*, WH-*, SW-*, CM-01…26, WB-01…09, CR-01…04, TP-03, E2E-01, E2E-05, SEC-04…08 |
| P6 Meta integration | TP-04…09, CM-23, LIVE-01…03, LIVE-05 |
| P7 Hardening | LIVE-04, NFR-04, WB-03, E2E-06, full re-run |
| P8 Email (mock) | EN-*, EP-*, ES-*, RS-*, UT-*, EM-01…36 (except live), SEC-12…18 |
| P9 Email live | LIVE-EM-01…04, EM-34, EM-35 re-run |

## Spec gaps found while writing the evals

Each golden that depends on one of these is tagged `SPEC GAP G-nn` and encodes the **assumed** answer. Resolve them in SPEC.md, then update the affected cases.

| Gap | Question | Assumed in evals | Cases |
|---|---|---|---|
| G-01 | Is a number with the country code but no `+` (`919876543210`) accepted? | Yes (libphonenumber default) | PN-08 |
| G-02 | Strip non-breaking and other Unicode spaces, not just ASCII spaces? | Yes | PN-30 |
| G-03 | Reject or flag fixed-line numbers (unlikely to be on WhatsApp)? | Accepted | PN-31 |
| G-04 | Phone with an extension (`ext 5`)? | Accepted, extension dropped | PN-32 |
| G-05 | Can `delivered`/`read` override `failed`? | No | ST-15 |
| G-06 | §7.7 retries network timeouts 3×, §8.3 forbids resending ambiguous sends. Which wins after the request was sent? | §8.3: becomes `unknown` | EC-20, EC-21 |
| G-07 | Default action for an error code not in the table? | `failed`, not retried | EC-22 |
| G-08 | STOP with trailing punctuation (`STOP!`, `Stop.`)? | Suppress | OO-12, OO-13 |
| G-09 | Opt-out keyword as a media caption? | Ignored | OO-15 |
| G-10 | Phones "exported as text", but a leading `+` triggers the injection prefix. | Prefix applies | CE-11 |
| G-11 | Is the send-window end (20:00) inclusive? | Exclusive | SW-06 |
| G-12 | Threshold for "too many variables for the text"? | Undefined; pick a ratio | TV-30 |
| G-13 | Response code for an invalid webhook signature (200 vs 401)? | Either; must not process | WS-* |
| G-14 | Sanitise params (newlines, tabs, runs of spaces) that Meta rejects? | Replace with a space | SP-06 |
| G-15 | Opt-in column: case-insensitive? Is `no` → `opted_out` or `unknown`? | Case-insensitive; `unknown` | IS-08 |
| G-16 | Are tags unioned under the **Skip** policy too? | Yes | IS-10 |
| G-17 | Does Overwrite with an empty cell blank the existing value? | No | IS-10 |
| G-18 | Does a header `Name` map to `first_name` or `display_name`? | `first_name` | IS-01 |
| G-19 | Invalid email: drop the value, keep with a warning, or reject the row? | Drop value, keep row | IS-04 |
| G-20 | If Meta re-categorises a MARKETING template to UTILITY, can it still be sent? | Not offered in the wizard | TP-07 |
| G-21 | Several addresses in one email cell: invalid, or take the first? | Invalid (value dropped) | EN-11 |
| G-22 | Hard bounce arriving after `opened`: status and suppression? | Status stays `opened`; address suppressed | ES-12 |
