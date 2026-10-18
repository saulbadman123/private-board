# Stage 7 plan — separate composer page and board search

Status: **implemented in v0.5.0** (see `STAGE-7-STATUS.md`). Planned 18 October 2026 on top of v0.4.0.

Two changes, both aimed at simpler navigation:

- **A. Composer page.** Writing and drawing move off the board view onto their own page. The board view becomes a calm reading surface: title, search/filters, feed.
- **B. Board search.** The home page's "Open a board (link or ID)" form is replaced by a search over boards whose creator chose to list them. Contents still require the password.

Because nothing is deployed yet, there are no existing boards or users to migrate. This is the cheapest moment to make the change.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Who appears in search | Only boards whose creator ticked **List in search** at creation (you chose this) | Unlisted boards keep today's privacy exactly |
| Can a board change listing later | No. It is fixed at creation, like everything else on a board | Matches "no editable board settings"; the runtime role already has no UPDATE on `boards` |
| Default | Unlisted | Nobody's board name becomes public by accident |
| What search reveals | Name, creation date and board ID. Never entries, counts or activity | The minimum needed to pick a board |
| Browse-all / "recent boards" list | **Not offered.** A search of at least 2 characters is required | A public front page of unmoderated, permanent titles is a spam magnet (see Risks) |
| Matching | Word-prefix, case-insensitive (`gar` finds "Garden notes") using Postgres `simple` full-text search | Same engine as entry search; no new extension or dependency |
| Results | Top 20 matches, best first then newest; "Refine your search" if more exist | No pagination needed for a name lookup |
| Unlisted boards | Still open by their link (`/b/{id}` in the address bar). The paste-a-link form is removed | You asked for search instead of links; links themselves keep working |
| Password for listed boards | Minimum **16** characters (unlisted stays 12) | Listing publishes a target for password guessing (see Risks) |
| Composer URL | `/b/{id}/new`, Write and Draw tabs inside | One page; the tab is remembered in the existing in-memory draft |

Tell me if you want any of these changed before implementation; the rest of the plan adapts.

## A. Separate composer page

### What the user sees

**Board view `/b/{id}`**: header (title, Copy link, Lock, theme), then **Write** and **Draw** buttons, then search/filters and the feed. No editor on this page. If an unsent draft exists, the buttons read **Continue note** or **Continue drawing**.

**Composer `/b/{id}/new`**: "← Back to board", the board title, Write | Draw tabs, the existing editor or canvas, and "Posts are permanent. Check before posting." The **Collapse** button is gone because it is no longer needed. On a phone the canvas gets the whole column instead of sharing it with the feed.

**After a confirmed post**: the draft is cleared, the app returns to `/b/{id}`, the feed reloads from the first page, and the existing "Saved permanently. View note ↗" message appears above it. Filters are kept, as today.

### Behavior that must carry over unchanged

- **Drafts survive moving between pages.** They already live in module memory per board (`src/drafts.ts`), so SPA navigation between the board and the composer keeps them. Reload or crash still loses them, and the `beforeunload` warning stays.
- **Leaving during a pending post.** Navigation aborts the request, which is today's behavior: the draft keeps its frozen submission and shows Retry, and the idempotent request ID prevents duplicates. The Back link will say "Posting… leave anyway? Your draft keeps a Retry button" only while a post is pending.
- **Session expiry while composing.** The gate appears; after unlocking, the route is still `/b/{id}/new`, so the user lands back in the composer with the draft intact.
- **Lock** works from both pages and still wipes drafts.
- **Hide on background or pagehide** and the expiry timer are unchanged.

### Code changes

| File | Change |
| --- | --- |
| `src/main.ts` | `boardPattern` also accepts `/new`. `showBoard` passes the view (`feed`, `compose` or `entry`). Header Write/Draw buttons set `draft.mode` and navigate. A one-shot in-memory "just posted" result is handed to the feed view (never put in the URL) |
| `src/board.ts` | Split along existing seams into `src/feed.ts` (browse, feed, pagination, cards), `src/composer.ts` (note form plus the lazy drawing mode, lifted from today's `mountBoard`) and the existing entry-detail branch. `mountBoard` stays as a thin dispatcher with a new `view` option, so its signature and the tests' imports keep working |
| `src/drawing-editor.ts` | No logic change. Its `posted` callback now navigates back instead of reloading the feed in place |
| `src/notes.css`, `src/drawing.css`, `src/styles.css` | Remove the collapse styles, add the composer page header and the two board-view buttons, and let the canvas use the full column on mobile |
| `vercel.json` | None. `/b/:path*` already rewrites to the SPA |

There is no server or database change for Part A.

## B. Board search (opt-in listing)

### Database: `supabase/migrations/202610160005_board_directory.sql`

- `alter table public.boards add column listed boolean not null default false;`
- A generated column `title_search tsvector generated always as (to_tsvector('pg_catalog.simple', title)) stored`, with a **partial** GIN index `where listed`.
- `create_board_with_session` gains a `p_listed boolean` parameter. Create the new 5-argument version and drop the old 4-argument one in the same transaction; this removes no content. Grants: execute for `service_role` only.
- New `search_listed_boards(p_words text[])`, which returns `id, title, created_at`, at most 21 rows, and only where `listed`. The function builds the prefix query from **bound array elements** (each word quoted, then `:*`); user text is never concatenated into SQL. It is `security invoker` with a fixed `search_path`, and execution is revoked from `public`, `anon` and `authenticated`.
- Add defense in depth: a trigger rejecting UPDATE and DELETE on `boards` (the grant is already absent), mirroring `immutable_entries`.
- Existing boards (none in production) become unlisted.

### API

| Route | Change |
| --- | --- |
| `GET /api/boards?q=…` | **New, public, no session.** Validates `q`: 2–80 characters, no control characters, split into 1–5 words of letters and numbers, with anything else ignored. Returns `{ boards: [{ id, title, created_at }], more: boolean }`. Rate limits: 30/min per IP and 3,000/min per deployment, failing closed like the others. Uses the same no-store, nosniff and CORP headers. Because it is a GET, it needs no origin or CSRF header, and it changes nothing |
| `POST /api/boards` | Accepts an optional `listed: boolean`; anything else is rejected, as today. A listed board requires a password of at least 16 characters |
| `GET /api/boards/{id}` | Response also carries `listed`, used for a small "Listed" or "Unlisted" badge in the board header |
| Unlock, lock, entries, images | Unchanged |

`server/store.ts`, `server/types.ts` and `tests/memory-store.ts` gain `searchBoards(words)` and the `listed` field. Router change in `server/app.ts`: `/api/boards` allows `GET, POST`.

### Home page (`src/main.ts`, plus a small new `src/directory.ts`)

- The tabs become **Find a board** (default) and **Create a board**.
- **Find a board** has one search field. It waits 250 ms after typing, cancels stale requests (same pattern as `browse.ts`) and shows a results list of name and date, each item a link to `/b/{id}`. It covers empty, "no matches", loading, error and rate-limited states, and adds the line "Only boards their creators chose to list appear here."
- The gate shows the board's name when the user arrived from a search result (passed through in-memory navigation state, not fetched). A direct link still shows the neutral gate, so unlisted boards reveal nothing.
- **Create a board** adds a checkbox, **List in search**, off by default. Its hint: "Anyone can find this board's name. What's inside stays private. This can't be changed later." When ticked, the password hint switches to 16 characters.

### Risks you are accepting with listing (documented in SECURITY.md)

1. **Names become public, permanent content.** Anyone can create a listed board with any name, and the app has no moderation or deletion. Mitigations: no browse-all list (you only see names you searched for) and an **operator-only delisting** procedure, which is a one-line SQL statement run in the Supabase SQL Editor as the project owner and documented in `RUNBOOK.md`. The app itself never gains that power.
2. **Listed boards are discoverable guessing targets.** Existing limits (10 attempts per IP per board per 10 minutes, 200 per board) still allow about 29,000 guesses a day per board from many IPs. The 16-character minimum and a "use 4+ random words" hint make that impractical. The per-board ceiling also means a determined attacker could keep a listed board's unlock throttled for a while; the plan already accepts this for any board whose link leaks.
3. **Search queries are visible to the operator** in platform request logs (they are in the URL). Query text is never written to application logs.

Unlisted boards are unaffected by all three.

## Tests to add or update

- **`tests/access.test.ts`**: listed creation; the 16-character rule; field allowlist; `GET /api/boards` validation (too short, control characters, too many words); rate limiting; unlisted boards never returned; no `password_hash` in results; failing closed when the limiter is down.
- **`tests/schema.test.ts`** (PGlite): `listed` defaults to false; the runtime cannot UPDATE `listed`; browser roles cannot call `search_listed_boards`; prefix matching; quotes, `&`, `:*`, `!` and backslashes in input stay inert; only listed rows are returned; 21-row cap.
- **`tests/reliability.test.ts`**: add `GET /api/boards` to the header and no-store matrix.
- **`tests/editor.test.ts`**: mount with `view: 'compose'` and `view: 'feed'`. Check that the draft survives switching views, that a confirmed post calls `navigate('/b/{id}')`, and that a pending post aborted by navigation keeps Retry.
- **New `tests/directory.test.ts`** (jsdom): debounce, stale cancellation, no request under 2 characters, and that results render as text (never HTML).
- The bundle check must stay within budget (expected growth: about 1–2 KiB).

## Documentation to update

- `Private-Board-Architecture-and-Development-Plan.md`:
  - §1 (public discovery is now opt-in)
  - §3 (`boards.listed`)
  - §4 (titles of listed boards are public)
  - §6 (screens and composer placement)
  - §10 (API table)
- `SECURITY.md` (risks above), `RUNBOOK.md` (delisting procedure), `DEPLOYMENT.md` (run **five** migrations), `SETUP.md` smoke test, `README.md`, and a new `STAGE-7-STATUS.md`.
- Bump `package.json` to 0.5.0.

## Build order

1. Part A (front end only), then `npm run verify`.
2. Migration 5, then store and API, plus their tests.
3. Home search and the create checkbox, plus jsdom tests.
4. Documentation, then a final `npm run verify` and the bundle check.

Each step leaves the project working on its own.

## What you need to do

**Now:**
- Confirm or change the decisions table, especially the 16-character rule for listed boards and the absence of a browse-all list.
- Decide who acts as operator for delisting abusive board names. Only someone with Supabase project owner access can.

**Nothing else is needed from you to implement.** There are no new dependencies, environment variables, Supabase extensions or Vercel settings.

**At deployment (Stage 6 steps, slightly changed):**
- In the Supabase SQL Editor, run all **five** migrations in order. `DEPLOYMENT.md` will be updated to say so.
- Add to your device checks: the composer page on a phone (canvas size, Back during a pending post) and home search with the on-screen keyboard.
- Treat listing as a public-content feature. Search for your own boards' names after launch to check that what appears is what you expect.
