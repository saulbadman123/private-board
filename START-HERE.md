# Private Board v0.6.0 — Start here

## Upgrading from v0.5.0 (drawing room)

Run **only** `supabase/migrations/202610220001_large_drawings.sql` in the Supabase SQL Editor, then deploy the new source. The migration widens two size checks and touches no published entry. Deploy the migration first: until it is applied, posting a Large-paper drawing fails. Standard-paper drawings work either way.

## Already using Stage 3?

1. Extract this release into a new folder. Keep the old project until the upgrade works.
2. Copy your existing `.env.local` into the new project root. No variable names or values need to change.
3. In Supabase SQL Editor, run **only** `supabase/migrations/202610160005_board_directory.sql` (v0.4.0 installations). Older installations first need the missing earlier migrations, in order.
4. Stop the old development server. Open a terminal in the new project folder and run `npm ci`, then `npm run dev`.
5. Open `http://localhost:5173` with your existing board link and password. The search box and **Filters & sort** controls are below the composer.

Existing notes, drawings, links, passwords, and storage objects are preserved. The new migration adds one server-only function and reuses the existing indexes; it does not rewrite published entries. No public bucket or new account is required.

For Vercel, apply the new migration, update the source, and redeploy the complete project root while preserving your existing server environment variables. Do not upload only `dist`.

## Starting from scratch or an older stage?

Follow `README.md`. A fresh database needs all six migrations in filename order. A Stage 1 database needs migrations two, three, and four. A Stage 2 database needs migrations three and four. Never rerun migrations already applied successfully.

Use Node.js 24 LTS, create `.env.local` from `.env.example`, and run `npm ci` then `npm run dev`. Open the Vite address, not the source `index.html` by double-clicking it.

## What changed?

- Search matches all words in note bodies, titles, drawing descriptions, and tags. Matching is case-insensitive, not fuzzy, substring-based, accent-insensitive, or OCR. Search is limited to 200 characters.
- Content filters show notes, drawings, or both. Tags are comma-separated; matching requires every selected tag. Tap a tag on a feed card to add it to your filters.
- From/Through dates include the whole selected calendar day in your local time zone, including daylight-saving changes.
- Choose Newest first, Oldest first, or Most relevant. Relevance becomes available when a search has text.
- Clear filters restores all entries, newest-first. Refresh reruns the current filters from the first page and picks up newly posted content.
- Pages show up to 20 summaries, not the whole board. Later-created posts stay out of an ongoing page sequence; use Refresh to start a new sequence.
- Opening an entry and coming back retains the filters in this tab. Posting keeps filters unchanged and shows a View entry link even if the post is excluded by those filters.

The existing system/light/dark theme, Markdown editor, drawing tools, password protection, and permanent-content rules remain. Drafts and browsing preferences live only in memory. Locking clears them; a reload or closed tab loses them. No published content can be edited, cleared, or deleted through the app.

## Verification and deployment

Run `npm run verify`. Release results and remaining real-device/provider checks are in `docs/STAGE-8-STATUS.md`; setup and deployment checks are in `docs/SETUP.md`.

This archive is source code, not a live deployment. Your Vercel/Supabase projects were not changed while producing it.

## Stage 5 addendum

Stage 5 adds a read-only capacity switch (`WRITES_DISABLED`), extra response headers, operator scripts (`npm run ops:integrity`, `npm run ops:cleanup`), `supabase/ops/after-restore.sql`, and `docs/RUNBOOK.md`. No migration is needed; upgrade by replacing the source. **This stage was written without Node.js available and is untested: run `npm ci` and `npm run verify` first.** See `docs/STAGE-5-STATUS.md`.

## Stage 8 addendum (v0.6.0)

Stage 8 is the layout, drawing, and comfort update: switching tabs no longer reloads the board, a floating **New post** button, a stable home screen, the feed returns to your place, a wider drawing room (Expand, zoom, Pan, Undo/Redo, Standard or Large paper), a drawing viewer, and a recovery flow for notes over 20,000 characters (review a split, keep the rest in this tab, continue when you choose). Entries can be copied as Markdown and drawings downloaded. **The only database change is `202610220001_large_drawings.sql`; run it before deploying.** `npm run verify` passed on Node 24.22.1; real-device and screen-reader checks are listed in `docs/STAGE-8-STATUS.md`.

## Going live (Stage 6)

Follow `docs/DEPLOYMENT.md` for the Supabase and Vercel steps, and `docs/RUNBOOK.md` for backups and operations. See `docs/STAGE-6-STATUS.md` for what is still untested.
