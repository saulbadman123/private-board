# Private Board v0.4.0 — Start here

## Already using Stage 3?

1. Extract this release into a new folder. Keep the old project until the upgrade works.
2. Copy your existing `.env.local` into the new project root. No variable names or values need to change.
3. In Supabase SQL Editor, run **only** `supabase/migrations/202610160004_search_filters.sql`.
4. Stop the old development server. Open a terminal in the new project folder and run `npm ci`, then `npm run dev`.
5. Open `http://localhost:5173` with your existing board link and password. The search box and **Filters & sort** controls are below the composer.

Existing notes, drawings, links, passwords, and storage objects are preserved. The new migration adds one server-only function and reuses the existing indexes; it does not rewrite published entries. No public bucket or new account is required.

For Vercel, apply the new migration, update the source, and redeploy the complete project root while preserving your existing server environment variables. Do not upload only `dist`.

## Starting from scratch or an older stage?

Follow `README.md`. A fresh database needs all four migrations in filename order. A Stage 1 database needs migrations two, three, and four. A Stage 2 database needs migrations three and four. Never rerun migrations already applied successfully.

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

Run `npm run verify`. Release results and remaining real-device/provider checks are in `docs/STAGE-4-STATUS.md`; setup and deployment checks are in `docs/SETUP.md`.

This archive is source code, not a live deployment. Your Vercel/Supabase projects were not changed while producing it.

## Stage 5 addendum

Stage 5 adds a read-only capacity switch (`WRITES_DISABLED`), extra response headers, operator scripts (`npm run ops:integrity`, `npm run ops:cleanup`), `supabase/ops/after-restore.sql`, and `docs/RUNBOOK.md`. No migration is needed; upgrade by replacing the source. **This stage was written without Node.js available and is untested: run `npm ci` and `npm run verify` first.** See `docs/STAGE-5-STATUS.md`.

## Going live (Stage 6)

Follow `docs/DEPLOYMENT.md` for the Supabase and Vercel steps, and `docs/RUNBOOK.md` for backups and operations. See `docs/STAGE-6-STATUS.md` for what is still untested.
