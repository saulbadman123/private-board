# Stage 6 status — production launch kit

Prepared 16 October 2026. This stage delivers the launch procedure and operating documents. **No Supabase project, Vercel project, domain, or secret was created or touched**, and **nothing has been built or run**: Node.js was unavailable, so Stages 5 and 6 are untested. Run `npm ci` and `npm run verify` (see `STAGE-5-STATUS.md`) before relying on them.

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
| Production bundle free of private keys | Enforced by `npm run build`, not yet run |
| Android/iOS/keyboard checks | Not done |

The plan's gate is not met until every row is complete.
