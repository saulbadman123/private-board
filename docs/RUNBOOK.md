# Operations runbook

Targets, not guarantees: at most 24 hours of data exposure between independent backups, and restoration within one working day. Test them before relying on them.

## 1. Environments

- Separate Supabase projects for development/preview and production. Preview deployments never receive production values.
- Set `APP_ORIGIN` per environment to the exact origin. Never widen it to make previews work.
- Keep `SUPABASE_SECRET_KEY` and `RATE_LIMIT_SECRET` in Vercel server-side variables or a secret manager, never in the repository. Migration credentials stay off Vercel.
- Apply migrations in filename order and only additively. Content cleanup stays disabled; no TTLs or lifecycle rules on the database or the `drawings` bucket.

## 2. Backups (database and Storage are separate)

Supabase database backups do not contain Storage object bytes.

1. **Database:** keep the provider's scheduled backups on, plus an independent export at least daily (schema, constraints, grants, functions, triggers, data), kept in a different account/location.
2. **Drawings:** copy new objects from the private `drawings` bucket to a separate, encrypted location with separately controlled credentials. Never mirror deletions into the copy; keep historical checkpoints so an accidental privileged delete does not reach every backup.
3. **Manifest:** after each copy, create a checksum manifest and verify it:

   ```bash
   npm run ops:integrity -- --out manifest-YYYY-MM-DD.json
   ```

   It is read-only, prints counts and any `PROBLEM` lines, exits non-zero on a missing object or size/checksum mismatch, and never prints note text. The manifest lists board IDs and object paths; protect it like the backup itself. Compare the copied files against its `sha256` values.
4. Record the entry counts (notes/drawings) with each backup so a restore can be compared.

## 3. Restore procedure

1. Restore into a new project first when possible; do not overwrite evidence.
2. Restore the database, then the drawing objects at their original paths.
3. Run `supabase/ops/after-restore.sql` in the SQL Editor. It ends every browser session (everyone must unlock again), clears limiter buckets, and shows entry counts plus the immutability triggers and grants for review.
4. Run `npm run ops:integrity`. Counts must match the recorded numbers and every drawing must verify.
5. Check direct denial with `npm run test:database` and confirm the bucket is still private.
6. Keep `WRITES_DISABLED=1` until all of the above pass, then set it to `0` and redeploy.

Rehearse this before launch and periodically afterward.

## 4. Capacity: preserve reads, stop writes

Watch database size, Storage size, egress, and function usage against your plan limits, with alerts well before the limit.

To pause writes: set `WRITES_DISABLED=1` in the Vercel environment and redeploy. Reading, unlocking, and viewing drawings keep working. Creating a board and posting return `503 READ_ONLY` with `Retry-After: 300`; the browser keeps the draft and the same submission ID, so a later retry cannot duplicate. Set `0` (or remove it) and redeploy to resume.

## 5. Routine maintenance

Expired sessions and old limiter buckets accumulate but are harmless. Remove them with the content-safe function, at least weekly:

```bash
npm run ops:cleanup
```

If `pg_cron` is enabled you can schedule `select public.cleanup_access_state();` instead. It deletes only `board_sessions` and `rate_limit_buckets`.

## 6. Monitoring (never record note text, cookies, or passwords)

- Rate of 5xx and `UNAVAILABLE` responses; failed posts; `READ_ONLY` responses.
- Image read errors (the API returns 503 on a checksum mismatch, which indicates corruption or tampering).
- Many `429`/`ACCESS_DENIED` for one board or IP, which suggests password guessing.
- Storage growth, backup freshness (last successful export and object copy), deployment errors.
- GET feed URLs contain search filters. Restrict access to and retention of hosting logs.

## 7. Incident notes

- **Password leaked:** there is no revoke-one-user feature. Create a new board and tell participants; the old board stays readable to anyone with its password.
- **Suspected data tampering:** run `ops:integrity` and compare with the last manifest and backup.
- **Secret exposure:** rotate `SUPABASE_SECRET_KEY` and `RATE_LIMIT_SECRET` and redeploy. Rotating the limiter secret only resets rate counters.

## 8. Pre-launch checklist

- [ ] Production Supabase project and private `drawings` bucket created; all four migrations applied in order.
- [ ] Vercel secrets set for production only; `APP_ORIGIN` is the exact HTTPS origin.
- [ ] Preview deployment tested against the development project (see `SETUP.md` smoke test).
- [ ] `npm run test:database` passes against the target project.
- [ ] Production bundle contains no private keys (`npm run build` runs the check).
- [ ] Backups configured; one full restore rehearsal passed; counts and checksums matched.
- [ ] Alerts configured; capacity thresholds chosen; `WRITES_DISABLED` procedure tried once.
- [ ] Android Chrome, iOS Safari, and desktop keyboard checks complete.
- [ ] Create → unlock → note → draw → search → lock journey completed on the production domain.
