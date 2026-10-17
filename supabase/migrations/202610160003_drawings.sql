-- Stage 3: apply after the foundation and Markdown-note migrations.
begin;

create function public.post_drawing(
  p_board_id uuid,p_token_hash text,p_request_id uuid,p_request_hash text,
  p_title text,p_caption text,p_tags text[],p_object_key text,
  p_width integer,p_height integer,p_mime text,p_bytes integer,p_sha256 text
)
returns table(entry jsonb,replayed boolean)
language plpgsql security invoker set search_path='' as $$
declare v_entry public.entries;v_replayed boolean:=false;v_expected text;
begin
  perform 1 from public.board_sessions
    where token_hash=p_token_hash and board_id=p_board_id and expires_at>clock_timestamp()
    for share;
  if not found then raise exception 'Board locked' using errcode='42501';end if;
  v_expected:=p_board_id::text||'/'||p_request_id::text||'/'||p_sha256||case when p_mime='image/webp' then '.webp' else '.png' end;
  if p_object_key is distinct from v_expected then raise exception 'Invalid drawing path' using errcode='22023';end if;
  if not exists(select 1 from storage.objects where bucket_id='drawings' and name=p_object_key) then
    raise exception 'Drawing object is not stored' using errcode='22023';
  end if;
  insert into public.entries(board_id,kind,title,drawing_caption,tags,excerpt,object_key,width,height,image_mime,image_bytes,image_sha256,request_id,request_hash)
    values(p_board_id,'drawing',p_title,p_caption,p_tags,coalesce(p_caption,''),p_object_key,p_width,p_height,p_mime,p_bytes,p_sha256,p_request_id,p_request_hash)
    on conflict(board_id,request_id) do nothing returning * into v_entry;
  if not found then
    select * into strict v_entry from public.entries where board_id=p_board_id and request_id=p_request_id;
    if v_entry.kind<>'drawing' or v_entry.request_hash<>p_request_hash
      or v_entry.title is distinct from p_title or v_entry.drawing_caption is distinct from p_caption or v_entry.tags is distinct from p_tags then
      raise exception 'Submission conflict' using errcode='P0001';
    end if;
    v_replayed:=true;
  end if;
  return query select jsonb_build_object('id',v_entry.id,'board_id',v_entry.board_id,'kind',v_entry.kind,
    'title',v_entry.title,'drawing_caption',v_entry.drawing_caption,'tags',v_entry.tags,'created_at',v_entry.created_at,
    'width',v_entry.width,'height',v_entry.height,'image_mime',v_entry.image_mime,'image_bytes',v_entry.image_bytes),v_replayed;
end;
$$;

-- A separate function keeps the previous Stage 2 RPC backward-compatible.
create function public.list_board_entries(p_board_id uuid,p_before timestamptz default null,p_before_id uuid default null)
returns table(id uuid,board_id uuid,kind text,title text,excerpt text,tags text[],created_at timestamptz,width integer,height integer,drawing_caption text)
language sql stable security invoker set search_path='' as $$
  select e.id,e.board_id,e.kind,e.title,e.excerpt,e.tags,e.created_at,e.width,e.height,e.drawing_caption
  from public.entries e where e.board_id=p_board_id
    and (p_before is null or (e.created_at,e.id)<(p_before,p_before_id))
  order by e.created_at desc,e.id desc limit 21;
$$;

revoke all on function public.post_drawing(uuid,text,uuid,text,text,text,text[],text,integer,integer,text,integer,text),public.list_board_entries(uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.post_drawing(uuid,text,uuid,text,text,text,text[],text,integer,integer,text,integer,text),public.list_board_entries(uuid,timestamptz,uuid) to service_role;
-- Bucket remains private. No entry mutation or file overwrite permission added.
commit;
