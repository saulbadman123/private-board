# Security boundaries

## Board sessions

Passwords are verified only by the Node.js server with asynchronous scrypt (N=131072, r=8, p=1, maxmem=256 MiB), random 16-byte salts, and constant-time derived-key comparison. Password input is neither normalized nor trimmed. Creation requires 12 Unicode code points and no more than 256 UTF-8 bytes. There is no password reset or privileged creator identity.

Random 32-byte session secrets live in HttpOnly cookies, never in URLs or localStorage. Only SHA-256 digests of those high-entropy secrets are stored. One browser secret can have separate, expiring board grants. Only recognized active browser tokens are reused, so a caller cannot choose a new session secret. Expiration is checked server-side on every protected operation.

The frontend conceals private board content whenever the tab is hidden, and rechecks access before showing it again. While concealed, the board stays mounted but is invisible, inert, and out of the accessibility tree, the page title is neutral, and a "Checking access…" cover replaces it; it is never merely faded. On return one `GET /api/boards/{id}` request (separate from routing and from any publication) decides the outcome: success restores the same view in place, 401 shows the unlock gate with unsent drafts kept in memory, a network or server error leaves the content concealed with a Retry button, and an expired grant is detected against the clock without a request. A tab hidden for more than 30 minutes is rebuilt from scratch instead of restored. Leaving the page (`pagehide`) and back-forward cache restoration still tear the board down and rebuild it after an access check. A post confirmed while the tab is hidden does not navigate the hidden page; its result is shown after access is revalidated. Concealment limits stale data and browser snapshots on a best-effort basis; it is not a screenshot guarantee and cannot revoke content someone has already read or copied. Hidden content remains in the tab's memory until the tab is rebuilt or closed. The feed also keeps its reading position for the current board in tab memory only: page cursors, one entry ID, and a scroll offset, never entry content. Returning from an entry or the composer uses it to land in the same place; posting, Refresh, a filter change, or an unusable cursor starts the feed over, and Lock clears it along with drafts and browsing preferences. The only localStorage item is the theme preference.

A note over the 20,000-character limit is never truncated or sent: the editor keeps the whole text, publication is disabled, and the person can review a suggested split. Text that is set aside for a later post (the "remaining text"), the original text kept for Undo split, and the saved-entry link shown beside it live in tab memory only, per board. They are not stored, synced, or sent anywhere, are cleared by Lock and by Discard draft, are lost on reload, and count as an unsent draft for the leave-page and Lock warnings. Nothing from the remainder is posted until the person chooses Continue and then posts it as an ordinary new submission with its own request ID; a failed or uncertain submission keeps the first part's frozen attempt and the entire remainder. Copy Markdown, Copy draft, Copy remaining text, and the drawing downloads are explicit local actions. A drawing is downloaded by fetching its stored bytes through the same board-authorized image route the page uses (never a public or signed link), and saved from a temporary object URL that is revoked afterwards.

## Server boundary

Mutation routes require the exact configured Origin, an application-specific header, and same-origin Fetch Metadata when present. No cross-origin credential access is enabled. Payloads are bounded before JSON parsing. All database operations use structured SDK parameters. Board titles are escaped when inserted into HTML and never revealed before access is verified.

An IP-wide API bucket, operation-specific buckets, board limits, and deployment-wide create/unlock limits are persisted and atomically updated in Postgres. IP subjects are keyed HMACs, not raw IPs. Fixed windows can allow a burst on either side of a boundary. Board/global limits are temporary and deliberately conservative; tune for real usage, shared networks, and possible abuse. Per-instance scrypt concurrency is limited to two. Public hostile traffic can still consume resources; deployment monitoring remains necessary.

## Database and Storage boundary

Application tables have RLS and no browser role grants/policies. RPC execution is revoked from PUBLIC, anon, and authenticated. A restrictive policy denies client-role access to the drawings bucket even if an unrelated permissive policy is later added.

The server secret uses a role that bypasses RLS. The API—not RLS—checks our opaque board-session cookie. Future note/drawing routes must reuse the same board-authorization boundary and scope every lookup by board ID as well as entry ID. Never expose a generic server-side query proxy.

Runtime entries permissions are SELECT and INSERT only. UPDATE/DELETE/TRUNCATE are denied, with triggers providing an additional guard against accidental privileged mutations. Session and limiter records are intentionally mutable and expirable. Administrators can disable protections; this is application-level permanence, not immutable hardware storage.

## Privacy and operational limits

No author identity or IP is attached to entries. Hosts can retain access logs, and the operator can read database content. This is not end-to-end encryption. The API logs only a generic backend failure message. There is no telemetry SDK, analytics script, third-party font, or automatically fetched external image.

Private responses use browser/CDN no-store headers. The public static shell is safely cacheable because it contains no board data. Avoid adding private-content service-worker caching later.

Lost create responses can leave a board the creator does not know how to reach. Board creation and its session grant are atomic, but there is intentionally no account listing or recovery flow. The user should keep the returned link and password.

## Stage 2 note posting and rendering

Note JSON requests are bounded to 128 KiB before parsing; the body itself is limited to 20,000 Unicode code points and 80 KiB UTF-8. Titles and tags have separate length limits. The API rejects unknown fields, null bytes, malformed Unicode, unsupported content types, and client-selected board/timestamp/author fields.

The server normalizes newline style and metadata before hashing the canonical submitted content. The random request ID plus board ID has a unique database constraint. The note RPC does INSERT ON CONFLICT DO NOTHING, never an upsert or update, then verifies that a repeated ID matches the canonical original. It also rechecks and share-locks the board session inside the transaction so a concurrent lock cannot race a successful insert. An acknowledged retry returns the original note; mismatched content returns 409.

The client freezes an attempted draft until the server confirms it or returns a definitive validation/conflict error. Network failures, interrupted responses, expired authorization, and unknown outcomes preserve the request ID. Draft data lives only in memory and is cleared explicitly on lock or confirmed publication. The application reports success only after a valid note acknowledgment.

Preview and entry views use the same Marked + DOMPurify pipeline. Raw HTML is displayed as escaped text. A narrow tag/attribute allowlist excludes active content, external image loads, embeds, SVG, and styles. Only absolute HTTP/HTTPS links survive, with no-referrer and safe new-tab attributes. Generated task checkboxes are disabled. Markdown, not rendered HTML, is the database source of truth.

Feed and entry lookups are board-scoped after session authorization. Page cursors retain database timestamp precision and validate the board ID, timestamp format, and entry UUID; a cursor is never authorization. Summary responses exclude full Markdown and internal request hashes. Real-provider testing remains required after deployment.

## Stage 3 drawing uploads and delivery

Drawing multipart requests use the same origin, session, and posting-rate checks as notes. The total body is bounded to 3.5 MiB before multipart parsing; the image is bounded to 3 MiB and metadata fields are individually limited. Duplicate and unknown fields, client-selected storage keys, and invalid metadata are rejected.

Only PNG and WebP byte signatures are accepted. The decoder enforces strict errors and a 1600 × 1200 pixel limit (Standard 1024 × 768 and Large 1600 × 1200 paper; the same constants, in `shared/drawing-limits.ts`, drive the browser, the server, and migration `202610220001_large_drawings.sql`). The 3 MiB image, 3.5 MiB request, and bucket limits are unchanged, so a larger bitmap never means a larger file allowance. Width/height checks, explicit animation-container checks, and frame-count checks reject oversized or animated input. SVG and other formats never reach the decoder. Server processing strips metadata, flattens transparency onto white, and chooses the smaller of lossless PNG and WebP. A SHA-256 checksum covers the exact stored bytes.

The canonical submission digest covers kind, normalized title/description/tags, and the original image bytes. Already-published retries return the original entry before re-encoding. New objects use server-generated board/request/checksum paths and `upsert:false`. If an upload result is uncertain or an object already exists, the server downloads and checks those bytes instead of overwriting them.

The drawing RPC rechecks and share-locks the board grant, requires a matching private Storage object, and uses the existing board/request unique constraint without modifying entries. Upload success followed by database failure leaves an unpublished object; retries reuse it. There is no automatic object deletion and no deletion endpoint.

Entry/feed responses exclude Storage keys and internal digests. The image endpoint verifies board access, queries a drawing scoped to that board, downloads the stored object, checks its size/checksum, and serves image bytes with private/no-store and nosniff headers. It never redirects to a signed or public URL. The Supabase server credential remains privileged, so administrative access is outside the application-level immutability guarantee.

The browser freezes an attempted bitmap and metadata on uncertain outcomes, preserving the original Blob and request ID. Pen input is stopped before encoding, cancellation releases pointer capture, and Clear only affects an editable unsaved draft. Each draft's canvas has fixed bitmap dimensions (Standard or Large, chosen per new drawing; changing paper with ink on it asks first and starts a blank drawing). Zoom, Fit, Pan, and the expanded workspace only change how the bitmap is shown, and pointer positions are clamped to the paper. Undo/Redo keeps strokes as points in tab memory (bounded: older steps are painted into a baseline so artwork is never lost), is cleared on Lock and after a post, and is disabled while a post is unconfirmed. If the encoded PNG exceeds 3 MiB the browser says so and nothing is degraded or sent. There is no high-DPI multiplier or third-party drawing framework.

## Stage 4 search and pagination

The collection endpoint verifies the cookie and current board grant before parsing or querying search filters. It always supplies the authorized route's board UUID to `search_board_entries`; neither text nor a cursor can select another board. Direct browser-role execution of the RPC is denied, just like table access. No authorization or immutability permission is relaxed by the additive migration.

Queries are limited to 200 characters, five normalized exact tags of at most 24 characters, two validated UTC boundaries, a content-kind enum, and a sort enum. Duplicate/unknown fields and invalid ranges fail with 400. The UI converts inclusive local calendar days to a UTC lower bound and exclusive next-day upper bound using calendar arithmetic. Full-text search uses the existing `simple` search vector and `plainto_tsquery`, not executable SQL or advanced query syntax.

The SQL function chooses order/cursor fragments from three fixed constants; all request values use bound parameters. It returns at most 21 summaries and no Markdown bodies, object keys, request hashes, or credentials. The API sends 20 and strips internal rank/cutoff fields. Relevance necessarily scores matching rows on the server, not on a mobile device. Ordinary date sorts can use the board/date index.

Cursors carry a version, board ID, canonical-filter fingerprint, creation timestamp, entry UUID, optional exact rank text, and database timestamp cutoff. They are untrusted navigation state, not signed capabilities. Every request still checks authorization and reapplies all filters. Changed filters reject an old cursor. Timestamps retain microseconds; rank text round-trips to PostgreSQL `real` without JS rounding. Tie-breaks use immutable timestamps and UUIDs. The cutoff excludes subsequently created posts until Refresh; it is not a cross-request MVCC transaction snapshot, so a write transaction already in flight can still become visible.

Search waits 250ms while typing; superseded reads are aborted and generation-checked. Only 20 cards are rendered at once. Browsing preferences are in memory, not page URLs/localStorage, and clear on explicit lock. GET API request URLs do contain filters; hosting/access logs may retain them, so configure provider log access/retention accordingly. Private API results remain no-store. No analytics, search service, or realtime dependency was added.

## Stage 5 reliability review

Board creation and note/drawing posting can be paused with `WRITES_DISABLED=1`. The gate runs after the session and grant check, so unauthenticated callers learn nothing about capacity, and before any rate-limit consumption, upload, or database write. Reads, unlock, lock, and image delivery stay available. A paused submission keeps its request ID in the browser, so a later retry is idempotent.

API responses add `Cross-Origin-Resource-Policy: same-origin`; static responses add that header and `Cross-Origin-Opener-Policy: same-origin`. Tests pin the private-response header set across success, auth failure, not-found, and method-error responses, assert that backend failures log only a generic message, and confirm that concurrent identical or conflicting submissions yield one stored entry.

`scripts/ops.mjs` uses the server credential from a trusted operator machine only. `integrity` reads entries and Storage objects without modifying them; `cleanup` calls `cleanup_access_state()`, which can delete only expired sessions and limiter buckets. `supabase/ops/after-restore.sql` is deliberately outside the migrations folder. The tools are not deployed with the Vercel function. See `RUNBOOK.md`.

## Stage 7 board directory and composer page

- **Listing is opt-in and permanent.** `boards.listed` defaults to false and is set only at creation. The runtime role has no UPDATE on `boards`, and a trigger additionally rejects every change except an operator delisting (true to false), plus deletes and truncates. Unlisted boards are never indexed (partial GIN index) and never returned.
- **What search reveals:** board name, creation date and ID of listed boards, nothing more. No entries, counts, activity or hashes. There is deliberately no browse-all list; a query of at least 2 characters is required.
- **Public endpoint.** `GET /api/boards?q=` needs no session. It is rate limited (30/min per IP, 3,000/min deployment-wide), fails closed if the limiter is down, only accepts a single `q`, reduces it to at most 5 letter/digit words, and passes them to the database as a bound array that is quoted again in SQL. Browser roles cannot call `search_listed_boards`.
- **Accepted risks of listing.** Names are public and permanent content, with no in-app moderation (use the operator delisting in `RUNBOOK.md`). Listed boards are discoverable password-guessing targets, so they require a password of at least 16 characters; existing unlock limits still apply. Search text appears in hosting request logs but is never written to application logs.
- **Composer page.** Drafts remain in memory only and survive moving between the board and composer pages. The hand-off of a just-posted entry to the board page is in memory, never in the URL.