# Stage 2 acceptance status — v0.2.0

Historical record for the previous release. See `STAGE-3-STATUS.md` for the current build.

Prepared 16 October 2026. This release includes the Stage 1 foundation plus permanent Markdown notes.

## Implemented

- Write/Preview editor with keyboard-accessible tabs and basic formatting helpers.
- Optional note title and up to five normalized tags.
- Shared Markdown parser/sanitizer rules for preview and saved-note pages; raw HTML is inert, image syntax becomes a link, task checkboxes are disabled.
- Permanent note posting with server-side validation and an additive Supabase migration.
- Transactional request-ID deduplication, original-entry responses on retry, and conflicts for changed content.
- Draft preservation through network interruption, view changes, and expired access; no private localStorage drafts.
- Newest-first feed with 20 summaries per page, explicit previous/older navigation, and manual refresh.
- Password-protected direct note pages with link copying.
- Shared authorization and no-store headers on reads and writes; no editing or deleting API routes.

## Local verification

The production build and TypeScript checks pass. Browser assets are approximately **9.0 KiB for the initial JavaScript shell**, **33.9 KiB for all JavaScript including the lazy Markdown module**, and **4.1 KiB for CSS**, gzip compressed. `npm run build` prints the current measurements.

Tests use real password functions, the actual API handler, embedded PostgreSQL, and DOM-based editor/rendering checks. They cover board isolation, immutable entries, blocked direct-client roles, privileged RPC denial, malicious Markdown, inert checkboxes, lost-response retries, conflicting payloads, pagination ties, cursor precision, invalid note input, draft freezing, remounting, expired posting, and malformed success acknowledgments.

Release verification: **28 tests passed, 0 failed, 1 live-provider test skipped**. The skip is intentional because no Supabase test credentials are configured here.

The editor checks use JSDOM and are not a substitute for a real browser or phone test. PostgreSQL tests execute both migrations unchanged, with a minimal fixture standing in for Supabase-managed Storage tables. Their passing result does not claim that an unconfigured live Supabase project was tested.

## Integration checks still required

- Live Supabase API and Storage checks: skipped until test credentials are supplied.
- Real Vercel deployment, URL rewrites, cookies, and environment configuration.
- Android/iOS/desktop visual and interaction QA.

No live project, deployment, or real credentials were configured or changed in producing this release. Apply the new migration and run the documented smoke test against your project.

## Scope remaining

Drawing tools, image uploads, and private image delivery are Stage 3. Text search, type/date/tag filters, and additional sorting are Stage 4. Full production durability operations and restore rehearsals remain part of launch readiness.
