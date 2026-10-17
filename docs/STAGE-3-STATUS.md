# Stage 3 acceptance status — v0.3.0

Historical release record. Current acceptance results are in `STAGE-4-STATUS.md`.

Prepared 16 October 2026 (America/Sao_Paulo). This release includes the previous foundation and Markdown features plus permanent drawings.

## Implemented

- Write/Draw switching with independent, in-memory drafts.
- Native Canvas 2D with mouse/touch/pen events, pointer capture and cancellation, coalesced-event handling, and frame-batched painting.
- Fixed 1024 × 768 white paper, responsive sizing, six color swatches, custom colors, three brush sizes, eraser, and clear-before-posting confirmation.
- Optional drawing title, plain-text description, and tags.
- Bounded binary multipart upload with server-side session/CSRF/rate checks.
- Strict PNG/WebP validation, animation rejection, pixel bounds, metadata removal, and lossless PNG/WebP size comparison using server-only Sharp.
- Private Supabase Storage with non-overwriting content paths and checksum verification.
- Transactional drawing entry publication, canonical request deduplication, and recovery across upload/insert/acknowledgment failures.
- Mixed chronological feed and individual drawing pages, with lazy, authenticated image loading and retry controls.
- Additive migration `202610160003_drawings.sql`; no new environment variable, account system, edit route, or delete route.

## Verification

Production build and TypeScript checks pass. The current compressed assets are approximately **10.0 KiB for the initial JavaScript shell**, **38.2 KiB for all JavaScript including lazy Markdown/drawing tools**, and **4.9 KiB for CSS**. Sharp and the Supabase SDK remain on the server.

Release checks: **38 tests passed, 0 failed, 1 live-provider test skipped**. Local tests cover:

- Mouse/touch coordinate conversion after CSS resizing, pointer cancellation/lost capture, ignored secondary pointers, and frozen-submission input.
- Draft retention between Write/Draw and remounting, exact retry bytes/IDs, and clearing only an acknowledged drawing draft.
- Real PNG/WebP decoding, byte/pixel limits, corrupt/SVG/animated rejection, lossless flattened pixel comparison, and metadata stripping.
- Private image authorization, cross-board denial, no-store serving, checksum failure, and absent mutation methods.
- Upload-success/database-failure, uncertain upload acknowledgment, lost database acknowledgment, and session revocation before publication.
- All previous Markdown/access protections, plus both kinds in the feed and database-level drawing RPC restrictions.

Canvas control/editor checks use test contexts and JSDOM. Encoding/validation tests use real Sharp, and all three migrations run unchanged in embedded PostgreSQL with fixture Supabase-managed Storage tables. These checks do not replace real browser or Supabase Storage HTTP testing.

## Remaining integration checks

- Real Supabase Storage/API/RPC checks after project configuration.
- Vercel native Sharp packaging, deployed routes, cookies, and proxy behavior.
- Actual Android/iOS/desktop visual checks, drawing feel, rotation, and touch scrolling.

No live provider credentials or deployment were configured in producing this release. These checks remain pending, and the optional live-provider test is explicitly skipped. Stage 4 will add search, filtering, and sorting refinements.

## Operational boundaries

Storage and Postgres do not share an atomic commit. Rare unpublished image objects are retained for safe retries rather than deleted automatically. Published drawings never expire or get replaced through the app. Back up actual image objects as well as the database before a long-term production launch.
