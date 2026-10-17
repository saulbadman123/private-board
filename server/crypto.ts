import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 131072;
let inFlight = 0;
const MAX_HASHES = 2;
export class HashBusyError extends Error {}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (inFlight >= MAX_HASHES) throw new HashBusyError('Password verification busy');
  inFlight++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally { inFlight--; }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$1$${N}$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

// A valid, fixed work-factor record. Its value is not a usable password credential.
const DUMMY = `scrypt$1$${N}$8$1$${'73'.repeat(16)}$${'00'.repeat(32)}`;

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const parts = (encoded ?? DUMMY).split('$');
  if (parts.length !== 7 || parts.slice(0, 5).join('$') !== `scrypt$1$${N}$8$1` || !/^[a-f0-9]{32}$/.test(parts[5]) || !/^[a-f0-9]{64}$/.test(parts[6])) {
    throw new Error('Unsupported password hash');
  }
  const derived = await derive(password, Buffer.from(parts[5], 'hex'));
  return timingSafeEqual(derived, Buffer.from(parts[6], 'hex')) && encoded !== null;
}

export function newToken(): string { return randomBytes(32).toString('base64url'); }
export function digestToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function rateKey(secret: string, purpose: string, subject: string, day: string): string {
  return createHmac('sha256', secret).update(JSON.stringify([purpose, subject, day])).digest('hex');
}
