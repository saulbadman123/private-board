# Private Board — layout, drawing, tab return, and comfort plan

Date: 22 October 2026. Planning revision 4. Revision 4 records a source verification of revision 3 against a local copy of the inspected code, applies the resulting corrections in place, and adds the gaps it found; section 11 lists every change. This follow-up is investigation and planning only; no repository or pull-request changes were made during this revision. All recommendations below are proposed work against main, not an instruction to implement them. The separate draft implementation is not the baseline for this plan.

## Baseline and recommendation

Inspected `saulbadman123/private-board`, default branch `main`, at commit [`778d80258b025addf5915ce408f6043fc7ff0bb3`](https://github.com/saulbadman123/private-board/commit/778d80258b025addf5915ce408f6043fc7ff0bb3), “Enhance query validation to include 'path' parameter,” dated 18 October 2026. Package version: 0.5.0.

Recommendation: evolve the existing lightweight application into three clearly identified workspaces—Browse, Write, and Draw—and fix the tab lifecycle before adding more editor state. Retain the existing anonymous, password-protected, permanent-post model. No framework rewrite, account system, or realtime service is needed.

This investigation inspected source, styles, validation, database constraints, relevant tests, and project documentation. It did not open a live authenticated board or reproduce the deployed app in a browser. The tab-return explanation below follows directly from the current event handlers; deployment parity and real-device behavior still require verification during implementation. The historical test results in Stage 7 documentation were not rerun for this planning task.

## 1. What the code currently does

| Area | Evidence | Implication |
| --- | --- | --- |
| Board/editor separation | `src/board.ts` already supports feed, composer, and individual-entry views; `src/main.ts` routes `/b/{id}`, `/b/{id}/new`, and `/b/{id}/e/{entryId}`. | Improve hierarchy and navigation rather than recreating the separation already delivered in Stage 7. |
| Shared width | `.board-main` in `src/styles.css` caps all board views at 944 px including padding. | Reading and drawing inherit the same constraints despite different needs. |
| Drawing surface | `src/drawing-editor.ts` creates a 1024 × 768 bitmap. `src/drawing.css` scales it to the column and adds margins. | Usable workspace is the immediate priority; a larger bitmap is a separate optional improvement. |
| Drawing limits | `server/images.ts` permits 1024 × 768 and 3 MiB images. Foundation SQL constrains width, height, and bytes; the private bucket has a 3 MiB cap. | A CSS-only change can enlarge the workspace, but higher-resolution drawings need coordinated validation and a migration. |
| Tab return | `src/main.ts` calls `hidePrivate()` on backgrounding, empties the root, disposes the board, aborts requests, and calls `route()` on return. | A tab switch causes a client-side teardown/rebuild and new reads. |
| Drafts | `src/drafts.ts` keeps note content and the drawing canvas in memory. | Internal navigation can preserve content; reload, process loss, or closing the tab can lose it. |
| Note length | `src/board.ts` displays a code-point counter and rejects over-limit submission; `server/notes.ts` enforces 20,000 Unicode code points and 81,920 UTF-8 bytes. | This is a character limit, not a word limit. There is no guided overflow recovery. |
| Existing comfort features | Search, filters, clickable tags, themes, preview, copy-entry-link, draft continuation, and idempotent retries already exist. | Preserve and polish these features rather than listing them as new work. |

## 2. Why returning to the tab looks like a reload

The exact source path is:

1. `visibilitychange` sees `document.hidden` while private content is visible.
2. `hidePrivate()` increments the route generation, aborts the route controller, disposes the board, removes all root children, and replaces the document title.
3. On becoming visible, the empty root and remembered board ID trigger `route()`.
4. `route()` mounts “Opening your space…”, fetches board access, then calls `showBoard()`.
5. The feed or entry view mounts again and fetches its contents. The composer remounts from its in-memory draft.

This explains the visible reload without requiring a full browser navigation. It is documented as a privacy measure in `docs/SECURITY.md`; Stage 7 explicitly retained it. Browser tab discarding can separately cause an actual reload, especially under memory pressure. That is a different event and must not be conflated with this handler.

Direct consequences visible in the code include resetting feed pagination to the initial page, losing ephemeral editor state such as selection or preview tab, and aborting a post in progress. Draft/request-ID preservation makes an interrupted post retryable, but the interruption is unnecessary for an ordinary tab switch. Search/filter values survive because they already live in a separate in-memory map.

Each remount also downloads every visible drawing again. Private API responses are `no-store`, and each image request counts against the same per-session, per-board `read` limit (120 per minute) as feed and board reads. One return to a feed page of 20 drawings costs about 22 reads, so frequent tab switching can reach the limit and turn images into retry errors. This strengthens the case for Batch 1.

### Proposed lifecycle

Separate ordinary backgrounding, actual page departure, authorization expiry, and explicit locking.

| Event | Proposed behavior |
| --- | --- |
| Ordinary tab hide | Finish any active drawing stroke; conceal the private surface and make it inert; keep its component state mounted. Keep the public shell stable. Do not cancel an already-started publication solely because the tab is hidden. |
| Return to tab | Recheck board access through a separate, deduplicated request. Keep the private surface concealed until the check succeeds, then restore it in place without a route remount. |
| Recheck succeeds | Update expiry handling, restore the same page/scroll/selection/zoom, and allow interaction. Do not refetch every entry merely because visibility changed. |
| Recheck returns 401 | Keep private content concealed, show the unlock gate, and retain unsent drafts in memory as today. |
| Recheck fails offline or with a server error | Say “Could not check access. Retry.” Keep the recoverable state and avoid presenting a network error as a wrong password. |
| Session expires | Conceal content immediately and show the gate. Also compare expiry with the current clock on resume, because background timers can be delayed. |
| Long hidden period | Bound how long private content is kept while hidden. Retain the mounted view for ordinary absences; after a hidden period longer than a fixed threshold (initial proposal: 30 minutes, measured on resume from a timestamp taken at hide), fully dispose the view as today, keep drafts in memory, and remount after the access check. |
| Explicit Lock | Keep the existing server revocation behavior and clear board drafts, retained remainders, any future continuation queues, retained views, and browse state. |
| `pagehide` / back-forward cache restoration | Retain conservative cleanup and access revalidation. Restore eligible in-memory navigation state after authorization; do not assume this is the same as a normal tab switch. |

This requires separating the public shell from the private surface first. Today `frame()` renders the site header, theme button, and footer inside the same `#app` root that `hidePrivate()` empties, so there is no private container to conceal on its own. Give the private content its own container and conceal that with `hidden` plus `inert`.

Retain the existing DOM while concealed rather than destroying it. Remove private content from interaction and accessibility exposure while concealed; do not rely on opacity alone. Hide the board title as appropriate. Browser snapshot concealment is best effort, as it is today, and should not be described as a screenshot-prevention guarantee.

A small neutral “Checking access…” cover may briefly remain while the network responds. The goal is to eliminate the blank page, full loading screen, remount, and lost position—not promise zero authorization latency. Update the security documentation to describe the new conceal-and-revalidate policy accurately. Keep private API responses `no-store` and keep private content out of persistent browser storage.

Use separate cancellation scopes for route navigation, access rechecks, feed reads, and publication attempts. Guard every asynchronous completion with board/route identity. A post completed in the background must update its attempt state without unexpectedly navigating the hidden page; present its success on return after access validation. A lost response must retain the exact frozen request ID and payload. Do not automatically create a new request or retry a mutation on focus.

## 3. Cleaner workspaces

### Shared navigation and visual hierarchy

Use a compact board header with its name, a small privacy indicator, and secondary Share/Lock controls. On Browse and entry-reading pages, replace the large Write/Draw row with a fixed circular **New post (+)** control that reveals **Write a note** and **Draw**. Inside the composer, keep a compact Write / Draw selector and a Back to board link; omit the floating control there. The text editor uses **Edit / Preview** tabs. This supersedes the earlier proposal for persistent Browse / Write / Draw navigation across every view. See section 8 for the full floating-control and starting-screen specification.

Keep the current feed and entry URLs. Use `/b/{id}/new?mode=write` and `/b/{id}/new?mode=draw` for explicit compose links, while `/new` remains backward-compatible and uses the remembered mode. Parse mode from the URL on initial navigation and browser history traversal. When the in-composer Write / Draw selector changes mode, update the query with `history.replaceState` so the address never says `mode=write` while Draw is showing. The existing `/b/:path*` rewrite in `vercel.json` already passes the query through. Currently both buttons share `/new` and only a normal click sets the in-memory mode; explicit destinations also make Ctrl-click and opening Draw in a new tab work predictably.

### Browse

- Place search, content type, and collapsed advanced filters in a compact browsing toolbar. Keep date/tag filters and sorting available without dominating the screen.
- Show entry cards with a clear title, Note/Drawing label, date, excerpt or thumbnail, and tags. Move repeated permanence wording out of every card into shared explanatory copy; keep the warning next to publication controls.
- Keep a chronological list as the default, with approximately 760–860 px of readable card width. Do not make every paragraph as wide as a drawing workspace.
- Let a drawing thumbnail open its full entry. In the drawing entry, add **Expand**, **Fit**, and **100%** controls with an accessible close/back action.
- Restore the last feed page, filters, and scroll anchor when returning from an entry or composer. A manual Refresh deliberately resets the pagination snapshot. Preserve the existing cursor semantics.
- After publication, retain filters and provide the existing direct link to the saved entry. Explicitly say when active filters may exclude it.

### Write

- Dedicated heading “Write a note”; a comfortable 720–860 px editor, with a taller textarea that can grow.
- Edit/Preview tabs, restrained formatting helpers, visible character feedback, and optional title/tags.
- Keep publication and validation near one another. A sticky action area is acceptable only if it does not cover text or the mobile keyboard.
- Show “Draft kept in this tab” and a **Copy draft** fallback. Do not call this saved or synced.
- Returning to Browse keeps the draft. Discard is explicit and asks for confirmation when content exists. Locking with drafts explains that locking discards them; this does not change expiry recovery.

### Draw

- A drawing-specific layout up to roughly 1440 px on large screens, using the available viewport height instead of the reading column's width.
- A compact toolbar, large paper surface, and collapsible title/description/tags. Keep the publishing action visible without competing with the drawing area.
- An **Expand workspace** control that works as an in-page expanded mode; browser Fullscreen API support is not required.
- On narrow screens, use nearly the full width, a compact tool strip, and collapsible secondary controls. Offer explicit Draw/Pan modes and zoom buttons so navigation never depends only on multitouch gestures.

## 4. Bigger canvases, with bounded cost

Deliver this in two increments:

1. **Larger workspace:** use the wider layout and expanded mode with the current 1024 × 768 bitmap. This immediately increases usable screen area without a backend change.
2. **Larger bitmap:** add a 1600 × 1200 option, with 1024 × 768 retained as Standard. Large has about 2.44 times the pixel area. Keep Standard as the initial default and offer Large explicitly. Reconsider the default only after low-end-device validation; existing drafts retain their dimensions.

Keep the first release at the existing 4:3 aspect ratio. Add Fit/100%/zoom controls and panning for detail work on phones and small displays. Zoom changes presentation, not the exported bitmap. Preserve the image coordinate system when scaling and panning, clamp pointer coordinates, and ensure pan gestures never draw accidentally.

Changing paper size is a new-drawing choice. Never reset `canvas.width` or `canvas.height` on window resize: doing so clears pixels. If a nonempty draft changes size, require an explicit confirmed reset in the first version rather than silently resampling or cropping it.

Implementation dependencies:

- Centralize supported dimensions and upload limits so client and server agree. Keep the shared module free of Sharp and of the literal `limitInputPixels`: `scripts/check-bundle.mjs` fails the build if that string appears in any browser asset. The client's own 3 MiB check in `src/drawing-editor.ts` is also hard-coded and should read the shared value.
- Remove hard-coded clear/fill rectangles in `DrawingDraft.saved()` and initialization; derive them from actual canvas dimensions.
- Raise Sharp's input-pixel bound and width/height checks together to 1600 × 1200.
- Add a new migration changing the existing width/height check constraints. Do not edit a migration already applied to production. Keep older drawings valid and do not rewrite stored images. The foundation migration declares them inline, so PostgreSQL names them `entries_width_check` and `entries_height_check`; the migration can drop and re-add them with the wider range, and every existing row already satisfies it. `post_drawing` does not check dimensions itself. The append-only triggers guard UPDATE/DELETE, not ALTER. Update README, START-HERE, SETUP, and DEPLOYMENT, which currently say "five migrations".
- Initially retain the 3 MiB image, 3.5 MiB request, and private bucket byte limits. Larger dimensions do not imply unlimited file size. Show encoded-size feedback and offer a reviewed smaller export if necessary; never silently degrade artwork.
- Keep any export alternative separate from the original editable canvas. Once a post attempt is frozen, retry its exact bytes.
- Size the viewer from each image's actual width and height. Today `.private-drawing` forces `aspect-ratio:4/3` with `object-fit:contain`, so a non-4:3 image is letterboxed, not stretched; this matters only if a non-4:3 paper size is ever added.

Before considering Large as a default, measure encoding time, image size, server processing, pointer responsiveness, and memory on the user's low-end laptop class and an Android phone. A raw 1600 × 1200 RGBA bitmap alone is about 7.3 MiB; multiple full-canvas undo snapshots would multiply that cost quickly.

## 5. Long-paste recovery without losing text

Keep the existing publication cap: **20,000 characters**, counted as Unicode code points, with server-compatible byte validation. Word count may be optional information, never the validation rule.

Allow an over-limit draft to remain intact. Do not add a textarea `maxlength` that silently truncates pasted text. Show the excess immediately, disable publication while invalid, and offer helpful actions instead of only showing an error after submission.

Example: “This note is 3,420 characters over the limit. Keep editing, copy the overflow, or prepare it as multiple posts.”

### Core workflow: one post and its remainder

The current textarea already accepts an oversized paste without truncating it. The first improvement should provide recovery guidance, not introduce a complex batch-publishing interface.

1. Preserve the entire pasted draft and immediately show its count and excess. Keep feedback visible in both Edit and Preview. Example: “23,420 / 20,000 characters — 3,420 over the limit.”
2. Offer **Review split**, **Copy remaining text**, and **Keep editing**. A suggested split prefers the last suitable paragraph boundary within the limit. The remainder may therefore be larger than the numerical excess; show its actual size rather than calling both numbers the same thing.
3. Reviewing the split shows the proposed first post and the complete remainder. **Copy remaining text** copies only; it does not change the draft or publish anything. Clipboard failure exposes selectable text.
4. An explicit **Use first part** action stores the remainder and original source in memory and replaces the editable post with the proposed first part. Display a “Remaining text” panel with Copy and Undo split. The user can review or edit before posting.
5. After the first part is confirmed saved, show its entry link and **Continue with remaining text**. That action creates the next editable draft with a fresh request ID when submitted. If it is still too long, repeat the same flow. Do not automatically publish or silently replace a different existing draft.
6. A failed or uncertain submission preserves the first part's exact attempt and the entire remainder. Do not advance until acknowledgement. Before any publication, Undo split restores the source. After publication, only unposted content can be changed.

This needs one remainder buffer, not a pre-generated queue of every post. A multi-part queue with previews and “Part 1 of 3” navigation is an optional later enhancement. The default single-note workflow stays simple.

Prefer paragraph boundaries, then line/word boundaries. Never split a Unicode surrogate pair; avoid splitting grapheme clusters. Inspect the whole resulting editor value, including paste-over-selection and text inserted in the middle. Count and measure as the server does; JavaScript string `.length` is not the current character rule. The binding rule is 20,000 code points: a code point is at most 4 UTF-8 bytes, so a valid note is at most 80,000 bytes and the 81,920-byte check cannot fail for well-formed text (lone surrogates are already rejected). Keep the byte check as a backstop, but split logic only needs code-point counts. Preserve order and whitespace in the retained source.

Markdown needs special handling. Prefer cuts outside fenced code, links, and tables. If there is no safe cut, ask the user to adjust a proposed boundary and preview both parts. Do not silently repair markup or summarize the remainder. Any optional formatting repair must be shown and revalidated because it adds characters. Tests should prove that the proposed first part plus remainder reconstruct the original before the user makes intentional edits.

Titles and tags can be offered as editable defaults on a continuation. Do not add part labels or continuation links to permanent text without review. A true series/thread relationship would need additional backend design and is outside this update.

Remainder state follows the existing in-memory policy: scoped per board, survives internal navigation, clears on explicit Lock, and is lost on a true reload. Explain this and offer **Copy all remaining text**. Include a retained remainder (and nonempty drawing history) in `hasDrafts()` so the existing `beforeunload` warning still fires before a reload or tab close would lose it. Persistent private drafts across restarts are a separate decision.

## 6. A small set of comfort improvements

| Priority | Feature | Scope |
| --- | --- | --- |
| High | Drawing Undo/Redo | Stroke-level history; Clear becomes undoable within the history budget. History belongs to the draft and survives mode changes. Freeze it while publication is uncertain. |
| High | Return to reading position | Remember pagination snapshot, scroll anchor, and focus for the current board; invalidate on filter change or explicit Refresh. Bound retained pages rather than retaining an unlimited feed. Because images are `no-store`, refetching a retained page downloads every drawing again and spends read-limit budget; prefer retaining the rendered page (or in-memory blob URLs, revoked on Lock and disposal) over re-requesting it. |
| High | Better draft feedback | Distinguish editable draft, posting, uncertain/retryable submission, and confirmed publication. Say when data exists only in this tab. |
| High | Inline validation | Body overflow plus title/tag/description errors before sending; leave server validation authoritative. Avoid disruptive screen-reader announcements on every keystroke. |
| Medium | Copy note source | Add “Copy Markdown” beside the existing entry-link action. Copy from the authorized full entry; provide fallback selection. |
| Medium | Drawing download | Download the authorized displayed image or current draft through an explicit action; keep image access private. No public storage links. |
| Medium | Keyboard comfort | Ctrl/Cmd+Z and redo apply to a focused drawing workspace; do not steal text-input undo. Escape exits expansion. Keep post publication an explicit action. |

For drawing history, use bounded stroke data with occasional checkpoints, not a full bitmap for every pointer sample. Enforce a byte and operation budget; folding older strokes into a baseline must never remove visible artwork. Include clear/reset operations and stop drawing before snapshotting. Do not add layers, image uploads, collaboration cursors, or an advanced paint engine in this scope.

## 7. Follow-up findings and refined design decisions

### Reading and creating should have visibly different priorities

The existing separation is functional, but the composition actions, large board header, search hints, filter controls, and entry cards all compete for attention. Use this screen hierarchy:

| View | First visible controls | Main content | Secondary controls |
| --- | --- | --- | --- |
| Browse | Compact board title; fixed New post control | Search and readable entry list | Advanced filters, Share, Lock |
| Read note | Back to results; title and date; fixed New post control | Formatted note with comfortable line length | Copy text, Copy Markdown, Copy entry link |
| View drawing | Back to results; title; fixed New post control | Large image with Fit / 100% / Expand | Description, tags, Download, Copy entry link |
| Write | Board identity; compact Write / Draw selector; Edit / Preview | Text editor and overflow feedback | Formatting, title, tags; publication at the end |
| Draw | Compact tools and Expand | Viewport-fitted paper with zoom/pan | Collapsible metadata; publication action |

Keep the existing quiet visual style. Reduce decorative header height and repeated messages before adding new panels. Metadata and helper text should remain legible on phones; several current hints are only 9–11 px. Prefer a single ordered feed over masonry for mixed notes and drawings. Maintain logical keyboard order and allow text selection rather than making every part of a card a click target.

Untitled notes currently all display “Untitled note.” A useful small improvement is a short first-line display label, without changing the stored title. Preserve the actual entry content and avoid presenting a generated label as author-provided text.

### Canvas size is constrained by height as well as width

At the desktop CSS cap, the paper is approximately 828 CSS pixels wide after the board padding, composer borders, and canvas margins. At a 390 px viewport, it is approximately 322 × 242 CSS pixels. These are calculations from the styles, not measured browser screenshots. The large page header, Back link, mode selector, editor heading, and toolbar also push the paper downward.

An expanded workspace should collapse that surrounding chrome and fit the paper within both available width and height. Simply making it 1400 px wide could create a canvas taller than the screen. Provide Fit as the initial view and deliberate zoom for detail work. On mobile, keep Pan available so a larger touch-sensitive canvas does not trap page scrolling. Enlarging the on-screen workspace remains worthwhile even with the original bitmap resolution.

Changing from 1024 to 1600 pixels also makes an unchanged 6-pixel brush relatively thinner. Fine/Medium/Broad should have consistent meaning across paper sizes, and zoom should change their apparent screen size predictably. This belongs in the larger-bitmap specification.

The drawing feed currently requests the same authorized image endpoint used by the full entry. A grid with more large drawings would also increase image-transfer and decoding work. Keep lazy loading and the existing page limit. Do not introduce server thumbnails unless measurement justifies their additional storage and processing work.

### Small inconsistencies worth addressing

| Finding in main | Planned resolution |
| --- | --- |
| Write and Draw both link to `/new`; only an ordinary click sets the remembered mode. | Explicit mode destinations so opening Draw in a new tab works. |
| There are two different “Write” controls in the composer hierarchy. | The floating action offers Write a note / Draw; inside the composer, the mode selector uses Write / Draw and the editor uses Edit / Preview. |
| Filter values persist, but feed cursors and page number are local to each mount. | Retain the navigation snapshot and scroll anchor when returning from a reader; reset intentionally on Refresh or changed filters. |
| Drawing “Clear draft” erases ink but leaves title, description, and tags. | Rename it **Clear canvas**. A separate Discard drawing action, if offered, must explain that it clears everything. |
| A drawing entry initially says “Opening note…”. | Neutral “Opening entry…” loading copy. |
| Lock clears both unsent drafts immediately. | Warn when unsent content exists; ordinary navigation remains non-destructive. |
| There is a character counter but no over-limit recovery panel. | Inline excess feedback plus the reviewed first-part/remainder workflow. |

### Evidence still needed before any implementation is accepted

The source establishes the tab-return teardown; it does not prove which commit the live deployment serves or exclude browser process discard. A future read-only reproduction can use the browser Network panel: the current SPA handler should issue board/entry API reads without a new document navigation. A real browser reload also requests a document and loses in-memory drafts. Reproduce on Browse, Preview, and Draw, with short and long tab absences. Do not log note bodies, passwords, or drawing content.

For layout, inspect 390 px mobile and 1366 × 768 desktop views with realistic notes/drawings. Judge visible paper area, comfortable text width, and toolbar reachability before finalizing pixel targets. The 1600 × 1200 option and desktop width numbers are proposed design values, not confirmed performance results.

### Scope priority

The core proposal is: clear workspaces, a usable expanded drawing area, stable return behavior, reviewed overflow recovery, drawing undo/redo, and return-to-results position. Copy/download conveniences are small follow-ons. A full multi-post queue, drawing layers, persistent private drafts, realtime refresh, and a new visual theme are deferred.

## 8. Fixed compose control and stable starting screen

Added at the user's request on 22 October 2026. The floating compose control replaces the earlier global three-link navigation proposal on reading pages. This is the general floating-action pattern; no claim is made about Tumblr's current implementation.

### A single compact compose control

Recommend a circular **+** button in the bottom-right corner of an unlocked board. Clicking it opens a small panel immediately above it with two stacked, labelled choices: **Write a note** and **Draw**. Give each choice a simple pencil/brush icon. Labels are necessary; icon-only choices would make the compact control harder to understand.

The large `.compose-actions` row currently takes two equal columns, at least 48 px in height, plus its bottom margin. Replacing it frees space above the feed and keeps creation available while scrolling. Search and reading can then lead the page.

| Detail | Proposed behavior |
| --- | --- |
| Closed control | 56 px circle in the existing accent color, simple plus glyph, accessible name “New post.” Add a desktop hover/focus tooltip, not a permanent wide label. |
| Placement | Fixed to the viewport's bottom-right, about 24 px inset on desktop and 16 px on phones, plus device safe-area clearance. Keep its location stable as the user scrolls. |
| Open choices | Approximately 180–220 px wide, constrained to the viewport, opening upward; two rows of at least 48 px. Use the existing surface, border, radius, and theme colors. |
| Draft continuation | If unsent content exists, show “Continue note” or “Continue drawing” for that choice. Opening the control itself does not create, erase, or publish a draft. |
| Navigation | Choices are real links to the explicit Write/Draw destinations. Browser Back, Ctrl-click, and new-tab opening must retain the intended mode. |
| Closing | Trigger click, Escape, or outside click; also close on navigation, authorization loss, and tab concealment. Reopening the tab should not reopen the popover automatically. |
| Motion | Optional short opacity/position transition; honor reduced-motion settings. No bouncing attention animation. |

Use a non-modal disclosure with a real button (`aria-expanded` and `aria-controls`) and ordinary labelled links. Enter/Space opens it, Tab reaches its choices, and Escape returns focus to the trigger. Outside-click dismissal should not steal focus from the clicked control. Closed choices must be absent from the tab order and accessibility tree. A full-screen modal or a custom ARIA menu is unnecessary for two navigation choices.

### Where it belongs

| Screen/state | Floating compose control |
| --- | --- |
| Board feed, including empty/search-filtered views | Show it. On an empty board, explanatory copy may say “Use + to write or draw.” |
| Individual note or drawing reader | Show it at the same position, so reading and adding remain separate but accessible. |
| Write or Draw composer | Hide it. Use the small composer mode selector and Back to board link; no redundant creation menu over editing tools. |
| Expanded drawing viewer | Hide it while expanded; restore it on exit. |
| Home, unlock gate, expired access, or concealed private view | Do not show an active compose control. |

On wide desktops the fixed circle should sit naturally in the reader's outer gutter. On phones it occupies the lower-right corner, so reserve approximately a button-plus-inset of bottom clearance in the reading layout (initial target 88–104 px including adjustment for safe areas). This lets final entry controls and pagination scroll fully clear of it. Padding alone does not prevent overlap with every intermediate line: verify real scrolling and avoid positioning fixed navigation or another control beneath the circle.

The existing toast is also fixed near the bottom and can nearly fill a phone's width. Define a deliberate collision rule: on narrow reading screens place toasts above the closed compose zone; while the choices are open, place feedback above that panel or use a top feedback location if space is insufficient. Do not let a toast block either option. The menu should close on route changes, and privacy concealment must include both the trigger and popover even if they are rendered outside the main content container.

When an on-screen keyboard covers the lower viewport, hide or reposition the floating control rather than letting it obstruct search editing. The recommended default is to suppress it during mobile text entry and restore it on exit. Detect actual reduced visible space/focus rather than hiding it merely because a desktop search field has focus. On very short screens, constrain and reposition the option panel inside the visible viewport.

Do not add a second persistent Write/Draw row to the feed. That would restore the clutter the circle is meant to remove. Keep publication buttons inside the composer; the floating control only opens a draft.

### Why the starting screen shifts

The current source provides a direct structural explanation:

- In `src/main.ts`, `home().select()` replaces the contents of `#access-content`. Find contains a search input and results; Create contains board name, password, listing choice, explanatory notice, submission, and additional copy. Their intrinsic heights differ substantially.
- In `src/styles.css`, `.home-main` has vertical auto margins inside the flex-column app shell. When its height changes, the free space and its vertical position are recalculated.
- The desktop home grid also uses `align-items:center`. When the access panel changes height, the introduction is recentered relative to that changing grid row.
- Search results dynamically expand the Find form. Therefore movement can occur while searching as well as while switching modes.
- A scrollbar appearing or disappearing can additionally change usable width on some browsers. This is a possible secondary contributor, not a verified cause in the user's browser.

These findings explain the reported behavior from source. Exact movement in pixels has not been measured in the live deployment.

### Proposed starting-screen layout

Anchor the home section below the header with consistent top spacing and horizontal centering, instead of recentering it vertically whenever a panel grows. Top-align the introduction and access card. Keep the mode tabs, card width, and card top edge in the same place in both modes. The active form may extend downward without relocating the introduction.

On a roomy desktop, give the form area a shared **minimum** height based on the normal Create form at that breakpoint. This absorbs most of the switch between short Find and taller Create. Determine the value with the actual fonts, copy, and responsive width; it must be allowed to grow for validation errors and browser zoom. Do not fix the entire page to a pixel height or hide content with overflow clipping.

On phones and short windows, prefer natural-height forms with a stable top edge. Reserving a desktop-sized empty area below Find would be wasteful. Keep the introduction compact and stable above the card, let the page scroll normally, and avoid forcing the full screen to fit without scrolling. The footer moving downward when content grows is expected; the tabs or introduction jumping under the user's pointer is not.

For long Find results, keep the search field and tabs anchored and let results extend below them. If later measurements justify a bounded result list on desktop, make its scroll behavior obvious and keyboard-accessible; do not impose nested scrolling on mobile by default. Reserve a modest status/error area so normal “Searching…” and short feedback messages do not repeatedly move nearby controls. Use a stable scrollbar gutter where supported to reduce horizontal movement, with a normal fallback.

Avoid animating the whole form's height as a substitute for fixing its anchors. A subtle content fade is optional, but the controls should not travel during the transition. Preserve search query and non-secret form values during a mode switch where practical, without persistent storage. Focus should stay on the selected tab; entering a field is a separate user action and should not automatically summon the mobile keyboard.

The current Create request also outlives an ordinary mode switch because switching home tabs does not change the route generation. During any future refactor, explicitly handle a creation already in progress: for the minimal design, temporarily disable the mode switch while creation is pending and clearly show progress, rather than abandoning a potentially completed creation and inviting a duplicate request. This is a related interaction edge case, not the cause of the layout movement.

### Acceptance checks for both ideas

- At 360/390 px mobile and 1366 × 768 desktop sizes, New post remains reachable and does not block the final card, pagination, an image retry action, or toast feedback.
- Both choices can be selected using keyboard, touch, and a screen reader. New-tab Draw opens the drawing mode. Escape and outside click close the panel predictably.
- The trigger and open panel disappear on locking/concealment; neither can remain interactive over the unlock screen.
- Write/Draw editors and expanded viewers have no floating menu competing with their tools. Returning to reading restores it in its usual position.
- Switching Find/Create keeps the card top, tab row, and introduction anchored at a fixed viewport and scroll position. Test empty search, long results, validation errors, listing on/off, and a pending creation.
- Test short windows, 200% browser zoom, dark mode, reduced motion, mobile keyboard open/closed, and device rotation. No field, message, or submission control is clipped.
- Home switching does not issue a create request; opening the compose popover does not issue a post request. Only explicit submission creates permanent content.

## 9. Proposed implementation sequence — not authorized for execution

| Batch | Work | Main files | Completion criteria |
| --- | --- | --- | --- |
| 1 — Stable tab return | Separate the public shell from the private container; separate access checks from routing; conceal/resume; bound long hidden periods; isolate request lifetimes; protect pending posts; retain necessary view state. | `src/main.ts`, `src/board.ts`, `src/drafts.ts`, `src/board-session.ts` (required: `main.ts` imports CSS and starts routing at load, so Node's test runner cannot import it), lifecycle tests, `docs/SECURITY.md` | A healthy tab return does not recreate the board or abort a post. Expired/revoked access stays concealed. |
| 2 — Clear workspaces (may ship as 2a: home layout, New post control, mode URLs; then 2b: reading hierarchy, widths, return position) | Fixed New post disclosure, explicit mode URLs, compact composer navigation, stable home-screen layout, view-specific widths, improved reading hierarchy and return position. | `src/main.ts`, `src/board.ts`, `src/directory.ts`, `src/browse.ts`, `src/styles.css`, `src/browse.css`, `src/notes.css`, `src/drawing.css` | Browse contains no editor; New post works with touch and keyboard; direct Draw links open Draw; switching home modes keeps the tabs and introduction anchored; navigation preserves drafts and reading state. |
| 3 — Drawing room | Expanded workspace, zoom/pan, bounded undo/redo, dimension-aware draft handling, Standard/Large, backend limits and additive migration. | `src/canvas.ts`, `src/drawing-editor.ts`, `src/drafts.ts`, `server/images.ts`, shared limit module, new SQL migration | Old and large drawings round-trip; zoom aligns pointer input; resizing never erases a draft; oversized uploads fail safely. |
| 4 — Overflow and finishing | Shared length validation, overflow preview, one retained remainder, copy/download controls, accessibility and device regression pass. | Extract note composer from `src/board.ts`; proposed `src/note-limits.ts` or shared equivalent and `src/note-overflow.ts`; `src/drafts.ts`; tests/docs | No pasted text disappears; each part is explicitly published once; remaining drafts survive failed submissions. |

Extract the growing composer/feed/entry responsibilities from `src/board.ts` as those areas are touched. The Stage 7 plan proposed this split, but delivery kept one file with a `view` option (see `STAGE-7-STATUS.md`, "Differences from the plan"). Keep a small controller with the existing external mounting contract where practical; avoid a broad rewrite unrelated to the requested improvements.

## 10. Future verification and release criteria

- Lifecycle integration: hide/show on feed page 2, an entry, text selection, Preview, and a zoomed drawing. Confirm DOM/state preservation and no full route reload on healthy resume.
- Races: rapid hide/show, navigation during access validation, expiry while hidden, failed checks, explicit lock, and back-forward restoration. A stale response cannot reveal another board or revive a locked view.
- Publication: background a delayed note/drawing request; cover confirmed success, lost response, 401, rate limiting, and network loss. Confirm unchanged IDs/bytes on retry and no duplicate entry, dropped remainder, or skipped continuation part.
- Text boundaries: 19,999/20,000/20,001 code points, emoji and combining characters, CRLF, paste-over-selection, long unbroken text, code fences, titles/tags, and clipboard denial. Validate byte accounting and lossless source retention.
- Drawing: coordinate mapping at multiple zoom levels, pan versus ink, pointer cancellation, undo/redo/clear, canvas resizing, export limits, older 1024 × 768 drawings, and 1600 × 1200 acceptance across client/server/database.
- Layout/accessibility: 360 px phone, landscape phone, tablet, 1366 × 768 laptop, large desktop, dark mode, browser zoom, keyboard-only navigation, screen-reader focus, and mobile keyboard visibility.
- Preserve the existing `npm run verify` build, type check, bundle budgets, and regression tests. Add focused lifecycle tests around the actual visibility controller; mounting `mountBoard` alone does not exercise `main.ts` visibility behavior.
- Check the additive SQL constraint change against the database tests and a dedicated integration environment. Apply migration before enabling larger uploads in the application. Retain old image support if Large is disabled again; do not narrow constraints while larger stored rows exist.
- Confirm the deployed commit during implementation. Source review alone does not establish that Vercel currently serves this exact revision.

## 11. Revision 4 — source verification and changes

Verified 22 October 2026 against a local copy of the project (`E:\projetos\atuais\private-board-main`, package 0.5.0). The copy has no Git metadata, so the commit hash cannot be confirmed; it does contain the `path` query-parameter change named in the inspected commit's message (`server/directory.ts`, `server/search.ts`). This was a reading review only: Node.js was not available, so `npm run verify` was not run.

### Confirmed

Sections 1, 2, 7, and 8 match the source. In particular: the hide/return path in `src/main.ts`; posts using the route abort signal, so a tab switch aborts a pending post; Write and Draw both linking to `/new`; the 1024 × 768 and 3 MiB limits in Sharp, SQL, and the bucket; the hard-coded fill rectangles; the canvas-width arithmetic (828 px desktop, 322 × 242 at 390 px, including the 1 px composer border); 2.44× pixel area and 7.3 MiB for a raw Large bitmap; 9–11 px hints; the "Opening note…" copy; the home-layout causes; and the home Create request surviving a tab switch, which can lead to a duplicate board.

### Corrections applied in this revision

| Section | Revision 3 said | Correction |
| --- | --- | --- |
| 4 | The viewer stretches incoming images into a CSS ratio. | It letterboxes them (`object-fit:contain`). Low impact while only 4:3 is supported. |
| 5 | Validate with server-compatible byte accounting. | The 81,920-byte check cannot fail for valid text under the 20,000-code-point limit. Split logic only needs code points. |
| 9 | Stage 7 explicitly postponed the `board.ts` split. | The Stage 7 plan proposed the split; delivery kept one file. |

### Gaps added in this revision

| Section | Addition |
| --- | --- |
| 2 | Remounts download every drawing again (`no-store`) and spend the shared 120-per-minute read limit. |
| 2 | New lifecycle row: fully dispose the view after a long hidden period, so concealed private content is not kept indefinitely. |
| 2, 9 | The public shell must be separated from a private container before conceal-in-place is possible. `src/board-session.ts` is required for testability, not optional. |
| 3 | Keep the URL's `mode` in sync with `replaceState` when the composer selector changes. |
| 4 | The shared limits module must avoid the `limitInputPixels` token that the bundle check rejects. Use the shared value for the client's 3 MiB check. The constraint names are `entries_width_check` / `entries_height_check`. Update docs that say "five migrations". |
| 5 | `hasDrafts()` must include retained remainders and drawing history so the `beforeunload` warning still protects them. |
| 6 | Return-to-position should retain rendered pages or in-memory blob URLs rather than refetching images. |
| 9 | Batch 2 may ship in two parts. |

### Feasibility notes

No new dependencies or backend services are needed. Compressed asset budgets have ample room (CSS 5.5 of 15 KiB, shell JS 12.8 of 40 KiB, as measured in Stage 7). `canvasPoint()` already maps through `getBoundingClientRect()`, so CSS-transform zoom keeps pointer input aligned without changes. The eraser paints white rather than clearing pixels, so stroke replay for undo is straightforward. `Intl.Segmenter` covers grapheme-safe splitting. The CSP already allows `blob:`, so drawing download and blob-URL retention need no policy change. The batch order stands: tab return first, and the migration applied before larger uploads are enabled.

## Source map

All links point to the inspected commit, so later repository changes do not silently change the evidence.

- [Routing, app teardown, visibility and expiry](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/src/main.ts)
- [Board, composer, length feedback and feed pagination](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/src/board.ts)
- [Drawing editor](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/src/drawing-editor.ts) and [pointer handling](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/src/canvas.ts)
- [Draft model](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/src/drafts.ts)
- [Server note validation](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/server/notes.ts) and [image validation](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/server/images.ts)
- [Database and storage limits](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/supabase/migrations/202610160001_foundation.sql)
- [Security policy](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/docs/SECURITY.md) and [Stage 7 status](https://github.com/saulbadman123/private-board/blob/778d80258b025addf5915ce408f6043fc7ff0bb3/docs/STAGE-7-STATUS.md)
