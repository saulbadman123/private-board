# Stage 8 status — layout, drawing, tab return, and comfort (batches 1–4)

Implemented and verified locally on 22 October 2026 (Node 24.22.1). Nothing was deployed and no Supabase or Vercel project was touched. The plan this follows is `Private-Board-UX-and-Reliability-Plan-v1.0.md`.

## Verification

`npm run verify`: type check clean, build and bundle check passed (shell JS 22.4 KiB, all JS 52.6 KiB, CSS 7.1 KiB; budgets 40 / 100 / 15), and **139 tests: 138 passed, 0 failed, 1 skipped** (the live Supabase test). Stage 7 had 75.

Also exercised by hand in the in-app browser against a mocked API (the real service needs a configured Supabase project): home layout, board feed and reader, New post menu, composer (write and draw), Undo/Redo, zoom/Pan/Expand, Large paper, the long-note split flow, and restoring the feed position.

## What changed

- **Batch 1, tab return.** Hiding the tab conceals the mounted board (invisible, inert) and rechecks access on return instead of rebuilding it. A long absence (30 minutes) or leaving the page still rebuilds. A post confirmed while hidden shows its result after the recheck. See `SECURITY.md`.
- **Batch 2, workspaces.** Stable home layout, a floating New post button, `?mode=write|draw` URLs, view-specific widths, a compact header, calmer cards, and returning to the same feed page and scroll position.
- **Batch 3, drawing room.** Wider drawing page with pinned tools, Expand, zoom/Pan, stroke-level Undo/Redo, Standard and Large (1600 × 1200) paper, and a Fit/100%/Expand viewer for posted drawings. **Migration `202610220001_large_drawings.sql` must be applied before deploying.**
- **Batch 4, long notes and finishing.**
  - Shared limits (`shared/note-limits.ts`) used by the browser and the server, with tests that the two always agree.
  - An over-limit note is kept whole; Post is disabled and the excess is shown in both Edit and Preview.
  - **Review split** with Cut earlier/later, **Use first part**, **Undo split**, one in-memory remainder, and **Continue with remaining text** as a fresh submission.
  - Title and tag problems are explained next to the field.
  - Draft feedback ("kept in this tab only"), Copy draft, Discard draft, and a warning before Lock discards unsent text.
  - Copy Markdown on notes, drawing download on entries, and Download PNG of the current drawing.

## Accessibility pass

- Automated audit with axe-core 4.10 in the browser, light and dark themes: feed, note and drawing readers, New post menu, composer (empty, over the limit, split review, remainder, title error), draw composer, expanded drawing, drawing viewer, home (both tabs), and the unlock gate. **0 violations.** A few contrast checks were reported as "incomplete" by axe (scrollable textareas it considers partly obscured, and a "−" button symbol); none is a failure. This is an automated check, not a screen-reader or keyboard walkthrough on real devices.
- Muted text on the light tint was 4.37:1; `--muted` is now `#5f6962` (5.07:1 there, 5.31:1 on the page background). Placeholder text no longer uses reduced opacity.
- Text links and Back links are 44 px tall targets; moving to a new page moves focus to the main region (not on first load); the skip link target is focusable.
- Length changes are announced only when a note crosses the limit, never per keystroke; fields use `aria-invalid` with `aria-describedby`; new panels move focus to their heading.

## Still to do (not verified)

- Real-device checks: phone and tablet touch drawing, Pan and the on-screen keyboard with the New post button, the Large paper on a low-end laptop and Android phone (encoding time, memory, pointer latency), and screen-reader walkthroughs.
- A reviewed smaller export for a PNG over 3 MiB (today the person is told the size and nothing is sent).
- Two-finger pinch zoom on touch screens (buttons and Ctrl/Cmd + wheel exist).
- Everything still open from `STAGE-6-STATUS.md` (deployment, backups, restore rehearsal, live Supabase test).
