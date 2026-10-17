begin;

-- Reuses the existing board/date, search_document GIN and tags GIN indexes.
-- Only the trusted API may call this function, after checking a board grant.
create function public.search_board_entries(
  p_board_id uuid, p_query text default '', p_kind text default 'all',
  p_tags text[] default '{}', p_from timestamptz default null, p_to timestamptz default null,
  p_sort text default 'newest', p_at timestamptz default null, p_id uuid default null,
  p_rank real default null, p_snapshot timestamptz default null
) returns table (
  id uuid, board_id uuid, kind text, title text, tags text[], created_at timestamptz,
  excerpt text, width integer, height integer, drawing_caption text,
  rank_key text, snapshot_at timestamptz
) language plpgsql stable security invoker set search_path = '' set extra_float_digits = 3 as $$
declare v_order text; v_cursor text;
begin
  -- Only these fixed SQL fragments are concatenated. Every user value is bound.
  -- Separate order clauses let PostgreSQL use the board/date index for date sorts.
  if p_sort='newest' then
    v_order:='m.created_at desc,m.id desc';
    v_cursor:='(m.created_at,m.id)<($8,$9)';
  elsif p_sort='oldest' then
    v_order:='m.created_at asc,m.id asc';
    v_cursor:='(m.created_at,m.id)>($8,$9)';
  elsif p_sort='relevance' and p_query<>'' then
    v_order:='m.score desc,m.created_at desc,m.id desc';
    v_cursor:='(m.score<$10 or (m.score=$10 and (m.created_at,m.id)<($8,$9)))';
  else
    raise exception 'Invalid search order' using errcode='22023';
  end if;
  return query execute '
  with settings as (
    select pg_catalog.plainto_tsquery(''pg_catalog.simple'',$2) as query,
      coalesce($11,pg_catalog.statement_timestamp()) as snapshot
  ), matches as not materialized (
    select e.*, s.snapshot,
      case when $7=''relevance'' then pg_catalog.ts_rank_cd(e.search_document,s.query) else null::real end as score
    from public.entries e cross join settings s
    where e.board_id=$1 and e.created_at<=s.snapshot
      and ($2='''' or e.search_document @@ s.query)
      and ($3=''all'' or e.kind=$3)
      and (pg_catalog.cardinality($4)=0 or e.tags @> $4)
      and ($5 is null or e.created_at>=$5)
      and ($6 is null or e.created_at<$6)
  )
  select m.id,m.board_id,m.kind,m.title,m.tags,m.created_at,m.excerpt,
    m.width,m.height,m.drawing_caption,m.score::text,m.snapshot
  from matches m
  where $8 is null or '||v_cursor||'
  order by '||v_order||' limit 21'
  using p_board_id,p_query,p_kind,p_tags,p_from,p_to,p_sort,p_at,p_id,p_rank,p_snapshot;
end;
$$;
revoke all on function public.search_board_entries(uuid,text,text,text[],timestamptz,timestamptz,text,timestamptz,uuid,real,timestamptz) from public,anon,authenticated;
grant execute on function public.search_board_entries(uuid,text,text,text[],timestamptz,timestamptz,text,timestamptz,uuid,real,timestamptz) to service_role;

comment on function public.search_board_entries(uuid,text,text,text[],timestamptz,timestamptz,text,timestamptz,uuid,real,timestamptz) is
  'Server-only board-scoped search, 20 + 1 summaries, exact float/timestamp cursor. No full bodies or storage keys.';
commit;
