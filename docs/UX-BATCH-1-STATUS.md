# UX Batch 1 — stable tab return (v0.5.1)

Implemented against main commit `778d80258b025addf5915ce408f6043fc7ff0bb3` on 22 October 2026.

## Problem

`visibilitychange` used to dispose the board, abort the route's requests, and empty the app root whenever the tab became hidden. Returning invoked the entire router again. This caused the loading flash, reset feed pagination and ephemeral editor state, and could interrupt a note or drawing upload.

## Delivered

- `src/board-session.ts` controls concealment, access revalidation, expiry, and disposal separately from route navigation. Ordinary backgrounding retains the existing DOM and its scroll geometry, while hiding it visually, making it inert, removing it from accessibility exposure, and replacing the private document title.
- Returning runs one deduplicated board-access check before revealing the same view. It does not reload the feed or entry. Caret selection and reader text selection are restored, while preview mode and pagination survive because their components never unmount.
- Failed/offline checks leave the content concealed and offer Retry. A stalled check times out after 15 seconds. A 401 or expired deadline invokes the unlock gate. The clock is checked on resume even if a background timer has not fired.
- Visibility checks use independent cancellation. Navigation/disposal invalidates late responses; rapid visibility changes cannot reveal a stale view.
- A note or drawing already being posted is not aborted solely because the tab becomes hidden. A successful acknowledgement retains a receipt and defers success navigation until the user returns and access is checked. Uncertain attempts retain their original request ID and payload; returning never automatically republishes.
- The drawing input controller flushes and ends an active stroke when hidden, releasing pointer capture without losing the canvas.
- Actual `pagehide` still disposes private UI. Back-forward-cache restoration re-enters the authorization flow. Explicit Lock clears drafts, browse preferences, and the pending receipt.
- README and security documentation describe the new behavior and its limits.

No database migration, server route change, new dependency, or environment variable is required. Drawing sizes, note limits, layout redesign, and overflow assistance remain later batches.

## Verification

`npm run verify` passed on Node 24.19.0:

- Type checking and Vite production build passed.
- Bundle limits passed: shell 13.8 KiB, all JavaScript 42.0 KiB, CSS 5.6 KiB compressed (budgets: 40 / 100 / 15 KiB).
- 86 tests: **85 passed, 0 failed, 1 skipped**. The skipped test requires live Supabase credentials; no live database test was performed.
- Eleven new lifecycle tests cover editor identity/selection/preview, page-two retention without refetching entries, background note and drawing publication, lost-response retry, stroke completion, offline retry, stale checks/disposal, invalid board responses, 401, hidden initialization, clock expiry, and actual `main.ts` pagehide/pageshow wiring.
- The app-entrypoint test executes the actual TypeScript router in JSDOM with CSS imports stubbed. Production CSS is built normally. These tests do not substitute for a real-device check of scrolling, browser snapshots, pointer handling, or mobile keyboard behavior.

## Device checks after deploying the branch

1. Open a board, go to page two, scroll to a recognizable entry, switch tabs and return. Expect the same entry and scroll position without “Opening your space…” or a feed reload. A small access-check cover is expected while the network responds.
2. In Write, enter several paragraphs, select some text, and switch tabs. The selection and draft should remain. Repeat with Preview selected.
3. In Draw, start a stroke, switch away, return, and draw again. The previous drawing should remain and the new stroke should not connect to the old pointer location.
4. With network throttling, post a note or drawing and immediately switch tabs. Return after completion. Expect one saved entry and a success receipt after access validation. A lost response should retain Retry for the same submission.
5. Switch tabs, enable offline mode, and return. Content should remain concealed with an access-check Retry action. Reconnect and retry; the original view should return.
6. Lock the board from another tab, then return to this tab. Expect the unlock gate instead of the old contents. After unlocking, an unsent draft should still be available. Explicitly locking this tab clears its drafts.
7. Navigate away and use browser Back. Expect authorization to be checked again. A true reload, tab close, or browser process discard can still lose in-memory drafts; this release does not add persistent draft storage.

## Remaining plan

| Batch | Scope |
| --- | --- |
| 2 | Browse/Write/Draw navigation, explicit compose-mode URLs, compact header, view-specific widths, return position across internal navigation. |
| 3 | Larger/expanded drawing workspace, zoom/pan, bounded undo/redo, 1600 × 1200 option with coordinated backend and database limits. |
| 4 | Character-overflow recovery and reviewed continuation drafts, inline validation, copy/download actions, accessibility and device pass. |

Private content remains in tab memory while concealed. This is best-effort privacy concealment, not screenshot prevention. Server-side authorization and private `no-store` responses remain unchanged.
