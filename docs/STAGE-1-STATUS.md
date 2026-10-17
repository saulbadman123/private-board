# Stage 1 acceptance status — v0.1.0

Historical record for the previous release. See `STAGE-2-STATUS.md` for the current build.

Prepared 16 October 2026.

## Implemented

- Responsive, dependency-free browser UI: home/create/open, neutral password gate, unlocked board shell, link sharing, lock, system/light/dark themes.
- Vercel Node.js Web Standard API entry point and a local Vite API adapter.
- Server-side scrypt hashing, opaque cookies, hashed seven-day board grants, multi-board isolation, lock/revocation.
- Exact-origin mutation protection, payload validation/size limits, generic password failures, bounded hash concurrency.
- Distributed atomic rate counters with IP HMACs and operation/board/deployment limits.
- Supabase migration for boards, entries, sessions, rate counters, RLS, least-privilege table grants, restricted RPC execution, and private Storage.
- Append-only entry protections, indexes, search-vector preparation, and idempotency constraints for subsequent stages.
- Setup, security, and deployment documentation.

## Verified locally

The test suite exercises the real password functions and API Request/Response handler using a test-only store. It verifies successful access, no private metadata without a session, cross-board denial, exact password matching, expiration, selective locking, cookie attributes, CSRF/origin handling, request bounds, unknown-token replacement, fail-closed limiting, and no entry mutation routes.

The actual migration is also executed against PGlite PostgreSQL. A small fixture supplies Supabase-owned roles and Storage tables, then the production SQL runs unchanged. Tests check RLS flags, client-role denial, RPC privileges, runtime entry immutability, constraints, atomic creation rollback, rate counter behavior, and restrictive drawing denial even under an intentionally permissive storage policy.

Build verification includes TypeScript checking, production bundling, compressed asset budgets, and a scan for server-only code/secret references in browser output. No browser screenshot, hosted-provider, or device result is inferred from these tests.

Measured initial production bundle: approximately **5.0 KiB JavaScript + 2.8 KiB CSS, gzip compressed**. Final measurements may differ slightly after changes; `npm run build` prints authoritative current sizes.

## Not verified in this environment

- Real Supabase REST, Storage HTTP, and deployed RPC behavior: optional live integration test is skipped until test credentials are configured.
- Vercel hosted routing, cookie behavior, and trusted proxy headers: deployment configuration is prepared but no deployment was made.
- Android/iOS/desktop browser visual and interaction QA: no supported browser QA surface was available in this run.

These are outstanding integration checks, not passed acceptance gates. The local source implementation is complete for Stage 1, while hosted acceptance awaits configuration.

## Next stages

Stage 2 adds immutable Markdown notes, safe preview, entry pages, the real feed, and retry-safe posting. Stage 3 adds the drawing composer, validated binary upload, lossless storage, and authenticated image delivery. Search/filter refinements and launch operations follow the original plan.
