# Private Board — v0.5.1 / tab-return stability

A small, mobile-first private Markdown and drawing board. Built with Vite, TypeScript, a Vercel Node.js API, and Supabase. No accounts and no browser-side database credentials. Start with `START-HERE.md` if you are upgrading an existing installation.

## Latest update — stable tab return

Switching tabs now conceals the board and checks access on return without rebuilding the page. Editor selection, preview mode, the drawing canvas, and feed pagination remain in place. Posts already being sent can finish in the background; their success is presented after access is confirmed. Offline access checks offer Retry without discarding the view.

Actual reloads or tab/process closure still lose in-memory drafts. This update does not change the drawing dimensions, note limit, database schema, or permanent-post model. See [Batch 1 status and device checks](docs/UX-BATCH-1-STATUS.md). Layout, larger canvases, and overflow assistance are later batches.

## What works in this release

- Create a board with a name and a shared password.
- Find a board by name from the home page (only boards whose creators chose "List in search"), or open any board from its link.
- Write and draw on a separate composer page (`/b/{id}/new`); the board page is for reading, search and filters.
- Unlock through server-side scrypt verification.
- Keep independent board access in one secure browser session.
- Copy a board link and lock a board on the current browser.
- Switch between system, light, and dark themes.
- Restrict database and private drawing storage access to the server.
- Apply shared database-backed limits across server instances.
- Write and preview Markdown, with formatting helpers and optional titles/tags.
- Publish permanent anonymous notes and read them in a paginated feed.
- Open and share individual note links protected by the same board password.
- Retry interrupted submissions without creating duplicate notes.
- Switch between Write and Draw while retaining both unsent drafts.
- Sketch on a responsive canvas with pen colors, brush sizes, an eraser, and clear-before-posting.
- Publish permanent drawings alongside notes, with optional titles, descriptions, and tags.
- Optimize drawings losslessly and store them in private Supabase Storage.
- Serve drawing bytes only through a board-authorized API route, with no public or signed URLs.
- Search note bodies, titles, drawing descriptions, and tags using existing PostgreSQL full-text indexes.
- Combine content-type, inclusive local-date, and exact tag filters, with one clear/reset action.
- Sort newest-first, oldest-first, or by search relevance with stable, filter-bound cursors.
- Keep browsing preferences when returning from an entry; clear them when explicitly locking.
- Cancel stale searches and retain current filters after posting, with a direct View entry link.

Notes and drawings cannot be edited or deleted after posting. Search matches all complete words, case-insensitively, using PostgreSQL's language-neutral `simple` configuration. It is not fuzzy search, substring matching, or drawing OCR. Tags match exactly (lowercase); selecting multiple tags requires all of them. Drafts and browsing preferences stay only in the current tab's memory. Reloading or closing the tab loses them; explicitly locking clears both drafts and browsing preferences. Only the theme preference uses localStorage.

## Start locally

Install Node.js 24 LTS. Extract the archive, then open a terminal inside this folder:

```sh
npm ci
```

Create a dedicated **development** Supabase project. In SQL Editor, run all five files in `supabase/migrations/` in filename order: foundation, Markdown notes, drawings, search/filters, then board directory. **If v0.4.0 is already installed, run only `202610160005_board_directory.sql`.** If upgrading from Stage 2, run migrations three and four. Do not rerun already-applied migrations on an existing installation. Alternatively, use the Supabase CLI migration workflow described in `docs/SETUP.md`.

Copy `.env.example` to `.env.local` (on Windows, `copy .env.example .env.local`; on macOS/Linux, `cp .env.example .env.local`). Fill in your development project URL and server secret key. Generate the independent rate-limit secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set `APP_ORIGIN=http://localhost:5173`, then run:

```sh
npm run dev
```

Visit **http://localhost:5173**. Use this exact origin; opening `127.0.0.1` instead requires changing `APP_ORIGIN` and restarting. The Vite development plugin handles the API locally; no second development server or Vercel CLI is necessary.

Without configuration the interface loads, but real board operations return an explicit service-not-configured error. There is no fake/localStorage board database and no demo password bypass.

Never put a Supabase secret in a `VITE_` variable, browser code, chat message, or committed file. Configuration files with real values are ignored by Git and excluded from this release.

## Verify

```sh
npm run verify
```

This builds and type-checks the frontend and API, checks compressed asset budgets and client/server separation, tests search/dates/pagination, Markdown/drawing security and interrupted uploads, and executes all migrations against embedded PostgreSQL using PGlite. The optional live Supabase test skips unless its environment variables are supplied. Details and measured release results are in `docs/STAGE-4-STATUS.md`.

For a real development Supabase project, add its publishable key as `TEST_SUPABASE_PUBLISHABLE_KEY` in `.env.local`, then run:

```sh
npm run test:database
```

Use a dedicated test/development project. This test verifies that unprivileged API clients cannot access the application tables, privileged RPCs, or private drawing bucket.

## Vercel

This source targets **Vercel**, with `vercel.json` and the API entry point already included. The `dist` folder is the compiled public shell; uploading that folder alone will not provide the API. Deploy the repository root.

Read `docs/SETUP.md` for environment setup, production-origin configuration, migration instructions, and the deployment smoke test. Production launch steps are in `docs/DEPLOYMENT.md`; backups and operations are in `docs/RUNBOOK.md`.

No live Vercel or Supabase project was connected or modified while producing this release. Browser/device QA and production API checks remain to be performed once the project is configured.

## Project map

| Path | Purpose |
| --- | --- |
| `src/` | Browser interface, native canvas, in-memory drafts, API client, theme, styles |
| `server/` | Authorization, validation, lossless image processing, private Storage adapter |
| `shared/` | Entry/search contracts, local calendar bounds, Markdown parsing, safe text helpers |
| `api/index.ts` | Vercel Web Standard Node.js entry point |
| `supabase/migrations/` | Reproducible schema and security setup |
| `tests/` | Access, crypto, PostgreSQL, and optional real-provider tests |
| `scripts/check-bundle.mjs` | Asset budget and secret-leak checks |
| `docs/` | Setup, design boundaries, acceptance status |

Published content is designed to be append-only, not administrator-proof or end-to-end encrypted. Database and file backups are both needed before a permanent public launch.

Sharp is a server dependency with platform-specific native components. Use normal `npm ci` installation with optional dependencies enabled; do not copy a `node_modules` folder between Windows and Linux. Vercel must install the dependencies for its own environment. Sharp and the Supabase SDK never enter the browser bundle.
"# private-board" 
"# private-board" 

