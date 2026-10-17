import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url=process.env.SUPABASE_URL;
const key=process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
test('live Supabase REST/RPC/Storage reject unprivileged clients', {skip:!url||!key}, async () => {
  const db=createClient(url!,key!,{auth:{persistSession:false,autoRefreshToken:false}});
  for (const table of ['boards','entries','board_sessions','rate_limit_buckets']) {
    const {data,error}=await db.from(table).select('*').limit(1);
    assert(error?.code==='42501',`${table} did not deny access through table privileges`);
    const write=await db.from(table).insert({});
    assert(write.error?.code==='42501',`${table} did not deny inserts through table privileges`);
  }
  assert((await db.rpc('consume_rate_limit',{p_key:'a'.repeat(64),p_limit:1,p_window_seconds:60})).error);
  assert((await db.rpc('create_board_with_session',{p_title:'Denied',p_password_hash:'invalid',p_token_hash:'a'.repeat(64),p_expires_at:new Date(Date.now()+60000).toISOString()})).error);
  for(const rpc of ['list_board_entries','search_board_entries']){
    const result=await db.rpc(rpc,{p_board_id:randomUUID()});
    assert(result.error?.code==='42501',`${rpc} did not deny direct search/feed access`);
  }
  const list=await db.storage.from('drawings').list();
  assert(list.error || list.data?.length===0,'Storage exposed its directory');
  const upload=await db.storage.from('drawings').upload(`unauthorized-${randomUUID()}.png`,Buffer.from('invalid'),{contentType:'image/png'});
  assert(upload.error,'Storage accepted unprivileged upload');
});
