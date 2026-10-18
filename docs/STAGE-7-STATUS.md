# Stage 7 status — composer page and board search (v0.5.0)

Implemented and verified locally on 18 October 2026 (Node 24.20.0). Nothing was deployed and no Supabase or Vercel project was touched.

## Verification

`npm run verify` from a clean `dist/`: type check clean, build and bundle check passed (shell 12.8 KiB, all JS 41.0 KiB, CSS 5.5 KiB; budgets 40 / 100 / 15), and **75 tests: 74 passed, 0 failed, 1 skipped** (the live Supabase test, which needs a real test project). Stage 6 had 61 tests.

## Delivered

- **Composer page** `/b/{id}/new` with Write and Draw tabs. The board page `/b/{id}` now shows only Write a note / Draw buttons (labelled Continue note / Continue drawing when an unsent draft exists), search and filters, and the feed. A confirmed post returns to the board with the existing "Saved permanently" message; filters are kept. Leaving during a pending post asks for confirmation, and the draft keeps its Retry.
- **Board search** on the home page ("Find a board" is now the first tab; the link/ID form is gone, links still work). Only boards created with **List in search** appear. Listing is off by default, permanent, and requires a password of at least 16 characters.
- **Migration** `202610160005_board_directory.sql`: `boards.listed`, a generated search column with a partial GIN index, `search_listed_boards()` (server only), the new `create_board_with_session(..., p_listed)`, and a trigger that allows only an operator delisting.
- **API:** `GET /api/boards?q=` (public, rate limited, validated), `listed` accepted on `POST /api/boards` and returned on board responses.
- Docs: `SECURITY.md`, `RUNBOOK.md` (delisting), `DEPLOYMENT.md`, `SETUP.md`, `README.md`, `START-HERE.md`.

## Differences from the plan

- `src/board.ts` was kept as one file with a `view` option (`feed`, `compose`, or entry detail) instead of being split into three files. Behavior is the same and the `mountBoard` signature is backward compatible.
- `Board.listed` is optional in the TypeScript types so older fixtures keep compiling; the database always returns it.
- The create-board response and board responses now include `listed`, so one existing test's expected key list changed.

## You still need to

- Run all five migrations on any Supabase project (v0.4.0 installs: only the fifth). `DEPLOYMENT.md` is updated.
- Real-device checks of the composer page (canvas size, Back during a pending post) and home search with the on-screen keyboard.
- Everything still open from `STAGE-6-STATUS.md` (deployment, backups, restore rehearsal, live Supabase test).
- `E:\fs\Private-Board-Architecture-and-Development-Plan.md` is outside the project and was not edited; sections 1, 3, 4, 6 and 10 are now out of date.