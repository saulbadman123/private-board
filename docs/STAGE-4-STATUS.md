# Stage 4 acceptance status — v0.4.0

Prepared 16 October 2026 (America/Sao_Paulo). Includes all earlier features plus indexed browsing and mobile refinements. This is a source release; no hosted database or Vercel deployment was modified.

## Implemented

- Language-neutral, all-word PostgreSQL full-text search across titles, note bodies, drawing descriptions, and tags.
- Combined note/drawing, inclusive local-calendar date, and exact all-selected-tags filters.
- Newest-first, oldest-first, and relevance ordering with deterministic UUID tie-breaks.
- Board/filter-bound cursor pagination: 20 summaries plus one lookahead, exact microsecond/rank round-trips, and a database creation-time cutoff.
- Debounced search, request cancellation/generation checks, manual refresh, empty/no-match/error/loading states, and a single Clear filters action.
- In-memory filter retention on entry navigation/session rechecks, cleared on explicit lock; drafts remain independent.
- Filter-preserving posting with a View entry link, and tag buttons on feed cards.
- Collapsible labeled filter controls, narrow-screen single-column fields, touch targets of at least 44px for primary controls, and existing system/light/dark themes.
- Additive `202610160004_search_filters.sql`; no new dependency, table, environment variable, account, edit, or delete action.

## Verified locally

`npm run verify` passes: **49 tests passed, 0 failed, 1 optional live-provider test skipped**. TypeScript and the production build pass. Compressed assets are approximately **12.0 KiB initial JavaScript**, **40.1 KiB all JavaScript including lazy tools**, and **5.3 KiB CSS**. Supabase and Sharp remain server-only.

Tests cover:

- Real PostgreSQL execution of all four migrations, runtime/client grants, append-only guards, and server-only search invocation.
- Word matching, drawing-description/tag search, case-insensitivity, empty/punctuation/no-match queries, literal hostile input, and exact all-tag filtering.
- Inclusive start/exclusive end predicates and local calendar boundaries across New York's 23/25-hour days and São Paulo's historical skipped midnight.
- Multi-page traversal of 63 entries with tied timestamps and varied/tied ranks under every sort, exact cursor serialization, and concurrent-insert cutoff/refresh behavior.
- Rejected cross-board/filter-changed/malformed cursors, authorization before search, expired grants, and safe summary-only responses.
- JSDOM interactions: stale reads cannot replace new results, filters survive remount/post, tag filtering, no-results/empty-board distinction, accessible validation, explicit-lock cleanup, stable Previous navigation, and a new cutoff on Refresh.
- Previous password/session, CSRF, Markdown sanitization, drawing validation/integrity, and interrupted-post retry protections.

PGlite exercises actual PostgreSQL with stand-in Supabase-managed Storage tables. JSDOM checks event/DOM behavior without a layout engine. The test fixture's text search is deliberately approximate; SQL matching/ranking is tested separately against PostgreSQL.

## Still pending on the configured project

- Live Supabase REST/RPC/Storage denial tests (`npm run test:database`).
- Vercel build/runtime, native Sharp packaging, cookies/proxy headers, and hosted routes.
- Visual/layout and touch/date-input checks at 320px on actual browsers, Android/iOS, keyboard/screen reader behavior, and low-end-device performance.
- Production-scale query plans/latency on representative data, backups of both database and Storage, and a restore rehearsal before launch.

No browser layout or real-device result is claimed. No managed browser/preview capability or live project credentials were available for this release. Responsive CSS and DOM tests do not replace those integration checks.

## Deliberate limits

Search is case-insensitive all-word matching, not fuzzy, substring, accent-insensitive, stemming, or OCR. Ranking may scan/score matches server-side, but the browser never downloads the whole board. The cutoff is timestamp-based, not a long-running MVCC snapshot; an already-in-flight write can become visible between pages. Refresh resets it. Content remains application-level append-only, not administrator-proof or an indefinite hosting/backup guarantee.
