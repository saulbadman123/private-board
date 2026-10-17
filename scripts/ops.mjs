// Operator tool. Run from a trusted machine with server credentials in .env.local:
//   node --env-file=.env.local scripts/ops.mjs integrity [--out manifest.json]
//   node --env-file=.env.local scripts/ops.mjs cleanup
// `integrity` is read-only. `cleanup` only removes expired sessions and rate-limit
// buckets (the database function cannot touch entries). Neither prints note text.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const [command, ...args] = process.argv.slice(2);
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key || !['integrity', 'cleanup'].includes(command)) {
  console.error('Usage: node --env-file=.env.local scripts/ops.mjs <integrity [--out file]|cleanup>');
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function cleanup() {
  const { error } = await db.rpc('cleanup_access_state');
  if (error) throw new Error(`cleanup failed (${error.code ?? 'unknown'})`);
  console.log('Expired sessions and rate-limit buckets removed.');
}

async function integrity() {
  const out = args[0] === '--out' ? args[1] : null;
  if (args.length && (args[0] !== '--out' || !out)) throw new Error('Use: integrity [--out file]');
  const columns = 'id,board_id,kind,created_at,object_key,image_bytes,image_sha256';
  const entries = [];
  // Entries are append-only, so oldest-first offset paging is stable: new posts only land after the end.
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from('entries').select(columns).order('created_at').order('id').range(from, from + 499);
    if (error) throw new Error(`entry read failed (${error.code ?? 'unknown'})`);
    entries.push(...data);
    if (data.length < 500) break;
  }
  const drawings = entries.filter(entry => entry.kind === 'drawing');
  const problems = [];
  const manifest = [];
  let next = 0;
  async function worker() {
    while (next < drawings.length) {
      const entry = drawings[next++];
      const download = await db.storage.from('drawings').download(entry.object_key);
      if (download.error || !download.data) { problems.push({ id: entry.id, problem: 'object missing or unreadable' }); continue; }
      const bytes = new Uint8Array(await download.data.arrayBuffer());
      const actual = sha256(bytes);
      if (bytes.length !== entry.image_bytes) problems.push({ id: entry.id, problem: 'size mismatch' });
      if (actual !== entry.image_sha256) problems.push({ id: entry.id, problem: 'checksum mismatch' });
      manifest.push({ id: entry.id, board_id: entry.board_id, object_key: entry.object_key, bytes: bytes.length, sha256: actual });
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  manifest.sort((a, b) => a.object_key.localeCompare(b.object_key));
  console.log(`Entries: ${entries.length} (${entries.length - drawings.length} notes, ${drawings.length} drawings)`);
  console.log(`Drawings verified: ${manifest.length - problems.filter(p => p.problem !== 'object missing or unreadable').length}/${drawings.length}`);
  for (const problem of problems) console.log(`PROBLEM ${problem.id}: ${problem.problem}`);
  if (out) {
    // The manifest lists board IDs and object paths. Store it with the same care as a backup.
    await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), entries: entries.length, drawings: manifest }, null, 2), { encoding: 'utf8', flag: 'wx' });
    console.log(`Manifest written to ${out}`);
  }
  if (problems.length) process.exitCode = 1;
}

try { await (command === 'cleanup' ? cleanup() : integrity()); }
catch (error) { console.error(error instanceof Error ? error.message : 'Operation failed'); process.exitCode = 1; }
