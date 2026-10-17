# Production deployment (Stage 6)

This is the step-by-step launch path for Supabase and Vercel. You do not need Node.js on your own computer: Vercel builds the project, and Supabase is configured in its web dashboard. Use a **separate production Supabase project**; never reuse a development project's data or secrets.

Before you start, read `RUNBOOK.md` (backups, restore, capacity). A launch is not complete until the final checklist at the bottom is done.

## 1. Supabase (production project)

1. Create a project at supabase.com. Choose a region near your users and write down the **database password** somewhere safe (a password manager).
2. Open **SQL Editor → New query**. Paste the full contents of each file below, one at a time, in this order, and press **Run**. Wait for "Success" before the next. Run each exactly once.
   1. `supabase/migrations/202610160001_foundation.sql`
   2. `supabase/migrations/202610160002_markdown_notes.sql`
   3. `supabase/migrations/202610160003_drawings.sql`
   4. `supabase/migrations/202610160004_search_filters.sql`

   If a file fails, stop and read the error. Do not delete security statements to make it pass.
3. **Storage:** confirm a bucket named `drawings` exists and is **Private** (migration 1 creates it). Do not add any storage policies.
4. **API keys** (Project Settings → API Keys): copy the **Project URL** and the **secret key** (starts with `sb_secret_`; the legacy `service_role` key also works). Never copy the publishable/anon key into Vercel for this app, and never put the secret key in the browser, in GitHub, or in chat.
5. **Backups:** Project Settings → Database → Backups. Note what your plan includes. Remember these do not contain drawing files; see `RUNBOOK.md` §2.

## 2. Get the code to GitHub

Vercel imports from a Git host. Without Node or Git installed you can use GitHub's web upload:

1. Create a **private** repository on github.com (empty, no template).
2. Unzip `private-board-stage-6.zip` on your computer. Do not include `.env.local` or `node_modules` (the zip has neither).
3. In the repository choose **Add file → Upload files**, drag in the *contents* of the unzipped folder (`api`, `docs`, `scripts`, `server`, `shared`, `src`, `supabase`, `tests`, `package.json`, `package-lock.json`, `vercel.json`, `index.html`, `.gitignore`, and the rest), and commit. Check that `package.json` is at the repository root, not inside an extra folder, and that hidden files (`.gitignore`, `.env.example`) arrived. If the browser skips folders, upload them in a few batches.

(Alternative: install Node 24 and Git, then use the Vercel CLI from the project folder.)

## 3. Vercel

1. At vercel.com choose **Add New → Project** and import the repository.
2. Settings to confirm: Framework **Vite**, Build command `npm run build`, Output directory `dist`, Node.js version **24.x**. Do **not** deploy only `dist`; the `api` folder is the server.
3. Before the first deploy, open **Environment Variables** and add these for **Production only** (not Preview):

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | the Project URL, e.g. `https://abcd.supabase.co` |
   | `SUPABASE_SECRET_KEY` | the `sb_secret_...` key |
   | `APP_ORIGIN` | your exact final address, e.g. `https://board.example.com` (no trailing slash, no path) |
   | `RATE_LIMIT_SECRET` | a new random value of at least 32 bytes (below) |

   Generate the random value in PowerShell and paste the output:

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
   ```

4. **Region:** in Project Settings → Functions, choose the region closest to your Supabase project, if your plan allows it.
5. **Domain:** if you use the free `*.vercel.app` address, deploy once, note the exact production domain, set `APP_ORIGIN` to it, then **Redeploy**. If you use your own domain, add it under Settings → Domains first and set `APP_ORIGIN` to it. The origin must match exactly, including `https://` and any `www.`. A wrong value makes every create/unlock/post return 403, and a missing value makes the API answer 503 "not configured".
6. **Preview deployments:** give them a separate development Supabase project's values, or no values at all. Never copy the production secrets into Preview.
7. Redeploy after any variable change; they are read at deploy time.

## 4. Verify the live site

Work through the smoke test in `SETUP.md` §4 on the production address, on a phone and a desktop. At minimum:

- Create a board, reload, post a note, post a drawing, search, lock, and reopen with the password.
- A private/incognito window must show only a neutral password gate.
- Browser dev tools show `__Host-board_session` as `Secure; HttpOnly; SameSite=Strict`, and API responses show `Cache-Control: private, no-store`.
- Copying a drawing's image URL into an incognito window returns nothing.
- Supabase **Table Editor** shows the app tables with RLS enabled; the `drawings` bucket is still private.
- In the Supabase SQL Editor, check that service_role has only SELECT and INSERT on `entries` (the "Sanity checks" at the end of `supabase/ops/after-restore.sql`; run only the two final `select` statements, **not** the deletes at the top).

From a machine with Node, also run `npm ci` then `npm run verify` and `npm run test:database` (needs `TEST_SUPABASE_PUBLISHABLE_KEY` and the project env in `.env.local`). Use a **test** project for this, not production data.

## 5. Operate

- Set up backups, the weekly `ops:cleanup`, alerts, and capacity thresholds as described in `RUNBOOK.md`.
- Do a restore rehearsal into a scratch project before you rely on the board for anything important.
- Save the board link and password somewhere safe. There is no recovery.

## Final checklist

See `RUNBOOK.md` §8. Items that only you can do (accounts, secrets, domains, backups, device tests) are not marked complete by the code.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| 503 "not configured" | A required variable is missing, still a placeholder, or `RATE_LIMIT_SECRET` is under 32 bytes; fix and redeploy |
| 403 on create/unlock/post | `APP_ORIGIN` differs from the address in the browser |
| 503 "temporarily unavailable" | Wrong `SUPABASE_URL`/secret key, or a migration was not run |
| 503 "paused" on posting | `WRITES_DISABLED=1` is set |
| Drawing upload fails | The `drawings` bucket is missing, or Sharp failed to install; check the Vercel build log |
| Build fails at bundle check | A secret or server-only name leaked into the browser build; read the message |
