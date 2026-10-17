-- Stage 1. Apply to a dedicated Supabase project using migration credentials.
begin;

create table public.boards (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  password_hash text not null check (password_hash ~ '^scrypt\$1\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

create table public.board_sessions (
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  board_id uuid not null references public.boards(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (token_hash, board_id)
);
create index board_sessions_expiry_idx on public.board_sessions(expires_at);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete restrict,
  kind text not null check (kind in ('note', 'drawing')),
  title text check (char_length(title) <= 120),
  markdown text check (char_length(markdown) <= 20000 and octet_length(markdown) <= 81920),
  drawing_caption text check (char_length(drawing_caption) <= 280),
  object_key text unique,
  image_mime text check (image_mime in ('image/png', 'image/webp')),
  width integer check (width between 1 and 1024),
  height integer check (height between 1 and 768),
  image_bytes integer check (image_bytes between 1 and 3145728),
  image_sha256 text check (image_sha256 ~ '^[a-f0-9]{64}$'),
  tags text[] not null default '{}',
  excerpt text not null default '' check (char_length(excerpt) <= 800),
  search_document tsvector not null default ''::tsvector,
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (board_id, request_id),
  check (cardinality(tags) <= 5 and array_position(tags, null) is null),
  check (
    (kind = 'note' and markdown is not null and char_length(btrim(markdown)) > 0
      and drawing_caption is null and object_key is null and image_mime is null
      and width is null and height is null and image_bytes is null and image_sha256 is null)
    or
    (kind = 'drawing' and markdown is null and object_key is not null and image_mime is not null
      and width is not null and height is not null and image_bytes is not null and image_sha256 is not null)
  )
);
create index entries_board_created_idx on public.entries(board_id, created_at, id);
create index entries_search_idx on public.entries using gin(search_document);
create index entries_tags_idx on public.entries using gin(tags);

create table public.rate_limit_buckets (
  key text not null check (key ~ '^[a-f0-9]{64}$'),
  window_start timestamptz not null,
  expires_at timestamptz not null,
  count integer not null check (count > 0),
  primary key (key, window_start)
);
create index rate_limit_expiry_idx on public.rate_limit_buckets(expires_at);

-- No client role can access these tables, even with an ordinary Auth JWT.
alter table public.boards enable row level security;
alter table public.board_sessions enable row level security;
alter table public.entries enable row level security;
alter table public.rate_limit_buckets enable row level security;
revoke all on public.boards, public.board_sessions, public.entries, public.rate_limit_buckets from public, anon, authenticated, service_role;
grant select, insert on public.boards, public.entries to service_role;
grant select, insert, update, delete on public.board_sessions, public.rate_limit_buckets to service_role;

-- Deliberately no client-facing policies. The runtime's service role bypasses
-- RLS and therefore MUST apply board-session authorization in every API route.

create function public.prepare_entry() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists(select 1 from unnest(new.tags) as t where char_length(t) not between 1 and 24 or t <> lower(btrim(t))) then
    raise exception 'Invalid tags' using errcode = '23514';
  end if;
  if (select count(distinct t) from unnest(new.tags) as t) <> cardinality(new.tags) then
    raise exception 'Duplicate tags' using errcode = '23514';
  end if;
  new.created_at := now();
  new.search_document := to_tsvector('pg_catalog.simple', coalesce(new.title, '') || ' ' || coalesce(new.markdown, '') || ' ' || coalesce(new.drawing_caption, '') || ' ' || array_to_string(new.tags, ' '));
  return new;
end;
$$;
create trigger prepare_entry before insert on public.entries for each row execute function public.prepare_entry();

create function public.reject_entry_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Published entries are immutable' using errcode = '42501';
end;
$$;
create trigger immutable_entries before update or delete on public.entries for each row execute function public.reject_entry_mutation();
create trigger immutable_entries_truncate before truncate on public.entries for each statement execute function public.reject_entry_mutation();

-- One transaction: a returned board always has a session grant.
create function public.create_board_with_session(p_title text, p_password_hash text, p_token_hash text, p_expires_at timestamptz)
returns table(id uuid, title text, created_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare v_board public.boards;
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '7 days 1 minute' then
    raise exception 'Invalid session expiry' using errcode = '22023';
  end if;
  insert into public.boards(title, password_hash) values (p_title, p_password_hash) returning * into v_board;
  insert into public.board_sessions(token_hash, board_id, expires_at) values (p_token_hash, v_board.id, p_expires_at);
  return query select v_board.id, v_board.title, v_board.created_at;
end;
$$;

-- Atomic across server instances; no read-then-write race.
create function public.consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns table(allowed boolean, retry_after integer)
language plpgsql security invoker set search_path = '' as $$
declare v_start timestamptz; v_count integer; v_now timestamptz := clock_timestamp();
begin
  if p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400 then
    raise exception 'Invalid rate limit' using errcode = '22023';
  end if;
  v_start := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_buckets as bucket(key, window_start, expires_at, count)
    values(p_key, v_start, v_start + make_interval(secs => p_window_seconds), 1)
    on conflict(key, window_start) do update set count = least(bucket.count + 1, p_limit + 1)
    returning count into v_count;
  return query select v_count <= p_limit, greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - v_now)))::integer);
end;
$$;

-- Operator-only scheduled maintenance: temporary security state, never content.
create function public.cleanup_access_state() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.board_sessions where expires_at < now() - interval '1 day';
  delete from public.rate_limit_buckets where expires_at < now() - interval '1 day';
end;
$$;

revoke all on function public.prepare_entry(), public.reject_entry_mutation(), public.create_board_with_session(text,text,text,timestamptz), public.consume_rate_limit(text,integer,integer), public.cleanup_access_state() from public, anon, authenticated;
grant execute on function public.prepare_entry(), public.reject_entry_mutation(), public.create_board_with_session(text,text,text,timestamptz), public.consume_rate_limit(text,integer,integer), public.cleanup_access_state() to service_role;

-- Dedicated project: ensure future migrations cannot accidentally inherit the
-- usual broad public-schema defaults. Every future grant must be deliberate.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('drawings', 'drawings', false, 3145728, array['image/png', 'image/webp']);
-- Restrictive denial survives accidentally added permissive browser policies.
create policy drawings_deny_browser on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'drawings') with check (bucket_id <> 'drawings');
-- Never use a public bucket for this application.

commit;
