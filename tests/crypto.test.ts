import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, newToken, digestToken } from '../server/crypto.ts';

test('scrypt uses unique salts, preserves spaces/Unicode, and verifies only the exact password', async () => {
  const password='  palavras secretas 🌿  ';
  const a=await hashPassword(password); const b=await hashPassword(password);
  assert.notEqual(a,b);assert.match(a,/^scrypt\$1\$131072\$8\$1\$/);
  assert.equal(await verifyPassword(password,a),true);
  assert.equal(await verifyPassword(password.trim(),a),false);
  assert.equal(await verifyPassword('wrong password',a),false);
  assert.equal(await verifyPassword(password,null),false);
});
test('hash-record parameters cannot be changed to bypass the configured work factor', async () => {
  await assert.rejects(verifyPassword('password','scrypt$1$2$8$1$00$00'));
  const token=newToken();assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.equal(digestToken(token).length,64);
});
