-- Run manually in the SQL Editor of a RESTORED database before reopening writes.
-- This is an operations script, not a migration: never put it in supabase/migrations.
-- It ends every browser session so old cookies must unlock again. Content is untouched.
delete from public.board_sessions;
delete from public.rate_limit_buckets;

-- Sanity checks (read-only). Compare with the pre-incident counts you recorded.
select (count(*) filter (where kind = 'note'))::int as notes,
       (count(*) filter (where kind = 'drawing'))::int as drawings,
       min(created_at) as oldest, max(created_at) as newest
from public.entries;

-- Confirm the immutability guards and grants survived the restore (expect prepare_entry, immutable_entries and immutable_entries_truncate; only SELECT and INSERT for service_role).
select tgname from pg_trigger where tgrelid = 'public.entries'::regclass and not tgisinternal order by tgname;
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'entries' order by grantee, privilege_type;
