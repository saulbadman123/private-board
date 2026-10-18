# Stage 5 status — reliability and security review

Prepared 16 October 2026. Source changes on top of v0.4.0. No hosted database or Vercel deployment was modified.

## Local verification — 18 October 2026

Run on Windows 11 with Node.js 24.20.0 and npm 11.19.0. No source changes were needed.

- `npm ci`: 73 packages added, 0 vulnerabilities.
- `npm run verify`: passed (exit 0).
  - `tsc --noEmit` clean; `vite build` succeeded.
  - Bundle check passed with no server-only references. Compressed size: shell 12.0 KiB (budget 40), all JS 40.1 KiB (budget 100), CSS 5.3 KiB (budget 15).
  - `npm test`: **61 tests, 60 passed, 0 failed, 1 skipped**. The skipped test is the live Supabase denial test, which needs `.env.local` and a test project (`npm run test:database`). That is up from 49 passed in v0.4.0, and every new test in `reliability.test.ts` and `operations.test.ts` passes.
  - The "Private Board: backend operation failed" lines in the test output are expected. They come from the failure-injection tests, which check that only this generic message is logged.

`scripts/ops.mjs` was not run, because it needs a real Supabase project. The behavior of the database function and restore script it relies on is covered by `operations.test.ts` against PGlite.

## Review of the Phase 5 list

| Area | Finding |
| --- | --- |
| Concurrent submissions | Same submission ID plus identical content already returns the original entry; new test fires 8 simultaneous requests and expects exactly one stored entry. |
| Same key, different content | Already 409; new test sends 3 different bodies at once and expects one winner, two 409s. |
| Upload success, database failure | Covered by existing drawing tests (object reused on retry). |
| Insert success, response lost | Existing tests for notes and drawings; note replay re-asserted in the new tests. |
| Session expiry during posting | Existing drawing revocation test; new test posts after the grant is gone and expects 401 with nothing stored. |
| Cross-origin writes | Existing tests; no change. |
| Malicious Markdown | Existing sanitizer tests; no change. |
| Unauthorized RPC | Existing schema tests; new test also checks that `cleanup_access_state` is denied to `anon`/`authenticated`. |
| Caching leaks | New test checks no-store, CDN no-store, nosniff, no-referrer, `Vary: Cookie` and CORP on 200/201/401/404/405 responses. |
| Logging | New test makes the store throw an error containing a secret and asserts neither the response nor the log output contains it. |
| Limiter outage | New test confirms posts, unlocks, and board creation all fail closed (503) with no content written. |

## Changes

- **Read-only capacity mode.** `WRITES_DISABLED=1` makes board creation and posting return `503 READ_ONLY` (`Retry-After: 300`, draft preserved by the existing client retry behavior). Reads, unlock, lock, and image reads are unaffected. Unauthenticated callers still receive 401 first. Config accepts only `0` or `1`.
- **Headers.** `Cross-Origin-Resource-Policy: same-origin` on all API responses; the same plus `Cross-Origin-Opener-Policy: same-origin` on static responses in `vercel.json`.
- **Operator tooling.** `npm run ops:integrity` (read-only entry/drawing audit and checksum manifest), `npm run ops:cleanup` (expired sessions/buckets only), and `supabase/ops/after-restore.sql` (invalidate all sessions and review counts and guards after a restore).
- **Docs.** `docs/RUNBOOK.md` (backups, restore, capacity, maintenance, monitoring, incidents, launch checklist) and a Stage 5 section in `SECURITY.md`.

No migration, dependency, table, or endpoint was added.

## Still open (cannot be done from source)

- ~~Run the new tests and `npm run verify`.~~ Done 18 October 2026 (see above).
- `npm run test:database` and `npm run ops:integrity` / `ops:cleanup` against a real test project.
- Live Supabase denial tests, Vercel runtime behavior, native Sharp packaging, cookie/proxy headers.
- Measured request sizes, scrypt concurrency/latency, and query plans on representative data.
- Real device checks (Android Chrome, iOS Safari, keyboard, screen reader, 320px).
- Backups configured and a restore rehearsal executed using `RUNBOOK.md`.

## Observations not changed

- Sessions and limiter rows are never cleaned automatically; schedule `ops:cleanup` or `pg_cron`.
- Fixed-window limits permit a burst across a window boundary.
- Read endpoints also fail closed when the limiter is down, which is stricter than the plan requires.
- The 18 October build started with no `dist/`, so the bundle sizes above come from a clean build.
