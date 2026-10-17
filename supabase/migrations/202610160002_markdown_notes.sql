-- Additive Stage 2 migration. Apply after 202610160001_foundation.sql.
begin;

create function public.post_note(
  p_board_id uuid, p_token_hash text, p_request_id uuid, p_request_hash text,
  p_title text, p_markdown text, p_tags text[], p_excerpt text
)
returns table(entry jsonb, replayed boolean)
language plpgsql security invoker set search_path = '' as $$
declare v_entry public.entries; v_replayed boolean := false;
begin
  -- Share-lock the grant so revocation cannot race an authorized transaction.
  perform 1 from public.board_sessions
    where token_hash=p_token_hash and board_id=p_board_id and expires_at>clock_timestamp()
    for share;
  if not found then raise exception 'Board locked' using errcode='42501'; end if;

  insert into public.entries(board_id,kind,title,markdown,tags,excerpt,request_id,request_hash)
    values(p_board_id,'note',p_title,p_markdown,p_tags,p_excerpt,p_request_id,p_request_hash)
    on conflict(board_id,request_id) do nothing returning * into v_entry;
  if not found then
    select * into strict v_entry from public.entries where board_id=p_board_id and request_id=p_request_id;
    if v_entry.kind<>'note' or v_entry.request_hash<>p_request_hash
      or v_entry.title is distinct from p_title or v_entry.markdown is distinct from p_markdown
      or v_entry.tags is distinct from p_tags then
      raise exception 'Submission conflict' using errcode='P0001';
    end if;
    v_replayed := true;
  end if;
  return query select jsonb_build_object(
    'id',v_entry.id,'board_id',v_entry.board_id,'kind',v_entry.kind,'title',v_entry.title,
    'markdown',v_entry.markdown,'tags',v_entry.tags,'created_at',v_entry.created_at
  ),v_replayed;
end;
$$;

create function public.list_entry_summaries(p_board_id uuid,p_before timestamptz default null,p_before_id uuid default null)
returns table(id uuid,board_id uuid,kind text,title text,excerpt text,tags text[],created_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select e.id,e.board_id,e.kind,e.title,e.excerpt,e.tags,e.created_at
  from public.entries e
  where e.board_id=p_board_id and e.kind='note'
    and (p_before is null or (e.created_at,e.id)<(p_before,p_before_id))
  order by e.created_at desc,e.id desc limit 21;
$$;

revoke all on function public.post_note(uuid,text,uuid,text,text,text,text[],text),public.list_entry_summaries(uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.post_note(uuid,text,uuid,text,text,text,text[],text),public.list_entry_summaries(uuid,timestamptz,uuid) to service_role;
-- No UPDATE, DELETE or Storage permission is added by this migration.
commit;
