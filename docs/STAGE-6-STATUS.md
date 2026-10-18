# Stage 6 status — production launch kit

Prepared 16 October 2026. This stage delivers the launch procedure and operating documents. **No Supabase project, Vercel project, domain, or secret was created or touched.**

Update, 18 October 2026: `npm ci` and `npm run verify` were run locally on Node 24.20.0 and passed. The result was 60 tests passed, 1 skipped (the live Supabase test), and 0 failed; the bundle check also passed. See `STAGE-5-STATUS.md` for details. This confirms the source, not the deployment.

## Delivered

- `docs/DEPLOYMENT.md`: ordered Supabase, GitHub, and Vercel steps that need no local Node, environment-variable table, secret generation, origin/region/preview guidance, live verification, and troubleshooting.
- `docs/RUNBOOK.md` (Stage 5): backups, restore, capacity switch, maintenance, monitoring, and the launch checklist.
- No application code changed in this stage.

## Phase 6 gate: what is and is not done

| Gate item | State |
| --- | --- |
| Production Supabase project, private bucket, reviewed migrations | You must do it (DEPLOYMENT §1) |
| Server-only Vercel secrets, preview isolation | You must do it (§3) |
| Preview deployed and verified | You must do it |
| Full create/unlock/note/draw/search/lock journey on the production domain | Not done |
| Restore rehearsal | Not done |
| Alerts, capacity thresholds, backup of database and Storage | Not done |
| Production bundle free of private keys | Local build check passed 18 Oct 2026; rerun on Vercel with production env |
| Android/iOS/keyboard checks | Not done |

The plan's gate is not met until every row is complete.
