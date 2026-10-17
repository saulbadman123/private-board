# Stage 5 status — reliability and security review

Prepared 16 October 2026. Source changes on top of v0.4.0. No hosted database or Vercel deployment was modified.

## NOT YET VERIFIED — read this first

Node.js was not installed in the environment where this stage was written, so **nothing in this stage has been compiled, type-checked, built, or run**. The new tests (`tests/reliability.test.ts`, `tests/operations.test.ts`) and the `scripts/ops.mjs` operator tool are unexecuted. Before relying on any of it, run:

```bash
npm ci
npm run verify
```

Fix anything that fails and update this file with the real test count (v0.4.0 reported 49 passed, 1 skipped). No claim below should be read as a measured result.

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

- Run the new tests and `npm run verify`.
- Live Supabase denial tests, Vercel runtime behavior, native Sharp packaging, cookie/proxy headers.
- Measured request sizes, scrypt concurrency/latency, and query plans on representative data.
- Real device checks (Android Chrome, iOS Safari, keyboard, screen reader, 320px).
- Backups configured and a restore rehearsal executed using `RUNBOOK.md`.

## Observations not changed

- Sessions and limiter rows are never cleaned automatically; schedule `ops:cleanup` or `pg_cron`.
- Fixed-window limits permit a burst across a window boundary.
- Read endpoints also fail closed when the limiter is down, which is stricter than the plan requires.
- `dist/` contains stale hashed assets from earlier builds; a clean build is recommended before measuring bundle size.
