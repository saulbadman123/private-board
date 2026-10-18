-- Stage 7. Optional listing of board names for the home-page search.
-- Boards are unlisted by default. The choice is made at creation and cannot be
-- changed by the application (the runtime role has no UPDATE on boards).
begin;

alter table public.boards add column listed boolean not null default false;
alter table public.boards add column title_search tsvector
  generated always as (to_tsvector('pg_catalog.simple', title)) stored;
-- Partial index: unlisted boards never enter the directory index.
create index boards_listed_title_idx on public.boards using gin(title_search) where listed;

-- Boards are never edited or removed. The single permitted change is an operator
-- delisting a board (listed true -> false) from the SQL Editor. Relisting is rejected.
create function public.guard_board_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and old.listed and not new.listed
     and (new.id, new.title, new.password_hash, new.created_at) is not distinct from (old.id, old.title, old.password_hash, old.created_at) then
    return new;
  end if;
  raise exception 'Boards are immutable except for delisting' using errcode = '42501';
end;
$$;
create trigger guard_board_change before update or delete on public.boards for each row execute function public.guard_board_change();
create trigger guard_board_truncate before truncate on public.boards for each statement execute function public.guard_board_change();

-- Replaces the Stage 1 four-argument version. No content is touched.
drop function public.create_board_with_session(text, text, text, timestamptz);
create function public.create_board_with_session(p_title text, p_password_hash text, p_token_hash text, p_expires_at timestamptz, p_listed boolean default false)
returns table(id uuid, title text, created_at timestamptz, listed boolean)
language plpgsql security invoker set search_path = '' as $$
declare v_board public.boards;
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '7 days 1 minute' then
    raise exception 'Invalid session expiry' using errcode = '22023';
  end if;
  insert into public.boards(title, password_hash, listed) values (p_title, p_password_hash, coalesce(p_listed, false)) returning * into v_board;
  insert into public.board_sessions(token_hash, board_id, expires_at) values (p_token_hash, v_board.id, p_expires_at);
  return query select v_board.id, v_board.title, v_board.created_at, v_board.listed;
end;
$$;
revoke all on function public.create_board_with_session(text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.create_board_with_session(text, text, text, timestamptz, boolean) to service_role;

-- Name lookup for listed boards only. Every word is a bound array element, quoted
-- and prefix-matched; user text is never concatenated into SQL. Returns at most 21
-- rows (20 + 1 to detect more). Never returns hashes, entries or counts.
create function public.search_listed_boards(p_words text[])
returns table(id uuid, title text, created_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
declare v_query tsquery;
begin
  if p_words is null or pg_catalog.cardinality(p_words) not between 1 and 5 then
    raise exception 'Invalid search' using errcode = '22023';
  end if;
  select pg_catalog.to_tsquery('pg_catalog.simple', pg_catalog.string_agg(
           '''' || pg_catalog.replace(pg_catalog.replace(w, '\', '\\'), '''', '''''') || ''':*', ' & '))
    into v_query from pg_catalog.unnest(p_words) as w;
  return query
    select b.id, b.title, b.created_at from public.boards b
    where b.listed and b.title_search @@ v_query
    order by pg_catalog.ts_rank(b.title_search, v_query) desc, b.created_at desc, b.id desc
    limit 21;
end;
$$;
revoke all on function public.search_listed_boards(text[]) from public, anon, authenticated;
grant execute on function public.search_listed_boards(text[]) to service_role;

commit;
