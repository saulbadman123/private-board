# Stage 4 setup and Vercel preparation

## 1. Development database

Create a dedicated Supabase development project, preferably near the Vercel function region you intend to use. Do not apply this initial migration to a shared application database: it creates named tables and deliberately hardens future public-schema defaults for the `postgres` migration role.

Run `supabase/migrations/202610160001_foundation.sql` in SQL Editor. The entire script runs inside a transaction. It creates four RLS-protected tables, narrow server RPCs, entry immutability triggers, a private `drawings` bucket, and a restrictive storage policy. If it fails, correct the reported setup issue rather than removing security checks. Do not rerun a successful initial migration; use a new migration for subsequent changes.

Then run `supabase/migrations/202610160002_markdown_notes.sql`, `202610160003_drawings.sql`, and `202610160004_search_filters.sql`, in that order. These add server-only posting, feed, and indexed search functions without rewriting published entries. **If Stage 3 is installed, run only the fourth migration.** A Stage 2 installation needs migrations three and four; a Stage 1 installation needs two, three, and four. Existing environment variables stay the same.

CLI alternative, with a current Supabase CLI installed and authenticated:

```sh
supabase link --project-ref YOUR_DEVELOPMENT_PROJECT_REF
supabase db push
```

For a fully local Supabase installation, use `supabase start` and `supabase db reset`. This requires Docker and more RAM; a hosted development project is lighter on a small laptop. The project config disables Supabase Auth because shared-password sessions are implemented by the application.

## 2. Server configuration

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Development project URL, later the separate production project URL |
| `SUPABASE_SECRET_KEY` | Server secret key; the legacy service-role key can be used where necessary |
| `APP_ORIGIN` | Exact application origin without a trailing slash or URL path |
| `RATE_LIMIT_SECRET` | Independently generated random secret of at least 32 bytes |
| `TEST_SUPABASE_PUBLISHABLE_KEY` | Optional; needed only for live direct-API denial tests |

Keep `SUPABASE_SECRET_KEY` and `RATE_LIMIT_SECRET` server-side. The frontend has no Supabase SDK imports or public configuration variables. The SDK's server client never persists an Auth session or accepts a caller-supplied Authorization header.

Local configuration is read from `.env.local` by Vite. Unit/PostgreSQL tests use injected fixtures and need no secret. `npm run test:database` explicitly loads `.env.local`.

## 3. Prepare Vercel

Deploy from the complete repository root using Git import or an authenticated Vercel CLI. Select Vite, Node.js 24, build command `npm run build`, and output directory `dist`. `vercel.json` defines the shared API function and board-route rewrites. Do not deploy only `dist`; it contains no server code.

For a first preview, provision a development/staging Supabase project and set its server environment values. Set `APP_ORIGIN` to the exact stable preview alias you will open. If the first deployment URL is not yet known, create the deployment, obtain its domain, set the exact origin, and redeploy. The unconfigured API returns 503 until configuration is complete. Never accept arbitrary origins or point preview deployments at production data to avoid this step.

Vercel automatically identifies production execution to the application. The server then requires HTTPS, uses a host-only `__Host-` secure cookie, and derives rate-limit subjects from Vercel's forwarded client IP header. Local HTTP uses an explicitly different development cookie name. Do not serve the production build behind an unrelated server without adapting the trusted-proxy configuration.

Choose a function region near Supabase if the Vercel plan supports it; no arbitrary region has been hard-coded. Keep separate Vercel environment values for preview and production. Redeploy after changing environment variables. Confirm that the Web Standard `fetch` API handler is supported by the current Vercel Node.js runtime used by the project.

Drawing processing uses Sharp on the Node.js server. Install dependencies on the target platform with normal `npm ci` (optional dependencies enabled). Do not copy Windows native modules into a Linux deployment. The Vercel function has a 30-second ceiling; image processing itself has smaller bounds, and only two drawing encodes run concurrently per instance.

## 4. Deployment smoke test

1. Open the deployment on a phone-width viewport and create board A. Save its link and password.
2. Reload: A should stay unlocked in that browser. The URL must survive a direct navigation.
3. Open A in an incognito/private browser. It should show only a neutral password gate, not its title.
4. Enter a wrong password and then the correct password. Only the latter should reveal A.
5. Create B separately. A's cookie/password must not unlock B.
6. Unlock A and B in one browser. Lock A. B should remain available, while A returns to its gate after reload.
7. Copy A's link. It must contain only its random board ID, never its password or session token.
8. Try malformed and repeated requests; confirm bounded errors and 429 behavior.
9. Verify secure cookie attributes and no-store headers in browser developer tools.
10. Run the optional direct Supabase API tests against this environment.

11. Write a note with a heading, list, code block, and task checkbox. Compare Preview with the individual saved-note view.
12. Add a title and tags, post, refresh, and open the note's direct `/b/{boardId}/e/{entryId}` link in an incognito browser. It must require the board password before displaying the note.
13. Test retry behavior in a development project: interrupt a post, reconnect, then use Retry. There must be only one matching entry. Do not repeatedly create new submissions when the previous one is uncertain.
14. Confirm that published checkboxes cannot be toggled and there are no edit/delete actions.

15. Select Draw. Test taps, strokes, color changes, brush sizes, erasing, and clearing an unsaved sketch on mouse and touchscreen.
16. Rotate or resize the viewport. Strokes must stay aligned and the drawing must remain intact. Confirm that swiping outside the canvas still scrolls the page.
17. Switch between Write and Draw, then open an entry and return. Both unsent drafts should remain in the same tab.
18. Post a drawing with an optional title, description, and tags. Confirm it appears beside notes and opens through its entry link.
19. Copy its `/api/boards/{boardId}/entries/{entryId}/image` URL to an unauthorized/incognito browser. It must not return image bytes. Lock the board and retry: access must be denied.
20. Interrupt a drawing upload in development, reconnect, and Retry. Confirm there is one published entry and the original saved image is not overwritten.
21. Check the Supabase bucket remains private, and verify a corrupt/oversized image cannot be posted through the API.

22. Search complete words from a note, a drawing description, and a tag. No results from a different board may appear. Prefixes, fuzzy spelling, and drawing OCR are intentionally unsupported.
23. Combine type/date/tag filters. Verify that Through date includes that whole local day and multiple tags require all selected tags. Clear filters should restore all entries, newest-first.
24. Paginate newest, oldest, and relevance results with more than 20 matches, including posts sharing timestamps/scores. Confirm no duplicates. Switch filters mid-request and confirm stale results never replace the new ones.
25. Post with a filter that excludes the new content. Filters should remain selected; View entry must open the saved post. Opening a post and coming back retains filters within this tab.
26. Check a 320px viewport, Android/iOS drawing and date controls, keyboard-only navigation, screen-reader labels/statuses, dark mode, reduced motion, and zoom. Confirm no page-wide horizontal scrolling.
27. Refresh after another browser posts; the new entry should appear if it matches. There is no realtime subscription. Lock and reopen the board; private browsing preferences should be reset.

The unified feed loads at most 20 summaries plus a pagination lookahead and lazy-loads drawing bytes through authorized endpoints. Search uses `plainto_tsquery('simple', ...)` and existing GIN indexes; date sorts can use the existing board/date index. No count query or entire-board client search is added.

## 5. Temporary-state maintenance

The server-only `cleanup_access_state()` function removes only old sessions and expired rate counters; it never touches entries, boards, or storage. Schedule it once daily through an operator-owned Supabase Cron job if available, or call it from SQL Editor. Keep its execution restricted. Uncleaned counters cannot bypass rate limits, but they will consume database space.

Storage uploads and entry insertion are separate operations. Rare failures can leave an uploaded object without a published entry. The application retains these unpublished objects and reuses matching bytes on retry; it does not run automated object deletion. Operational reconciliation may report them, but any future cleanup must first prove an object is unpublished and has no in-flight retry. Never remove a referenced drawing.

## 6. Before the Stage 6 production launch

Create a separate production Supabase project, apply migrations in order, configure the final approved origin, verify API isolation and mobile behavior, and establish database plus drawing-object backups with a restore rehearsal. Prevent preview environments from receiving production keys. Preserve existing content during later migrations.

No project credentials or deployment were supplied during development of this archive, so hosted integration and real-device checks are not reported as passed.

## Official technical references

- [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel request headers](https://vercel.com/docs/headers/request-headers)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Storage buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Sharp constructor and input limits](https://sharp.pixelplumbing.com/api-constructor/)
- [Sharp output options](https://sharp.pixelplumbing.com/api-output/)
- [PostgreSQL full-text query controls and ranking](https://www.postgresql.org/docs/current/textsearch-controls.html)
- [PostgreSQL text-search functions](https://www.postgresql.org/docs/current/functions-textsearch.html)
