import type { AppConfig } from './types.ts';

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'APP_ORIGIN', 'RATE_LIMIT_SECRET'] as const;
  if (required.some(name => !env[name] || /YOUR_|REPLACE_WITH/.test(env[name]!))) {
    throw new Error('Missing server configuration');
  }
  const origin = new URL(env.APP_ORIGIN!);
  const database = new URL(env.SUPABASE_URL!);
  const production = env.VERCEL === '1' || env.NODE_ENV === 'production';
  if (origin.origin !== env.APP_ORIGIN || origin.username || origin.password) throw new Error('APP_ORIGIN must be an exact origin');
  if (production && (origin.protocol !== 'https:' || database.protocol !== 'https:')) throw new Error('Production requires HTTPS');
  if (!production && !['https:', 'http:'].includes(origin.protocol)) throw new Error('Invalid origin');
  if (Buffer.byteLength(env.RATE_LIMIT_SECRET!, 'utf8') < 32) throw new Error('Rate limit secret is too short');
  // Capacity switch: reads and unlocks keep working; board creation and posting stop.
  if (env.WRITES_DISABLED && !['0', '1'].includes(env.WRITES_DISABLED)) throw new Error('WRITES_DISABLED must be 0 or 1');
  return { supabaseUrl: database.origin, secretKey: env.SUPABASE_SECRET_KEY!, origin: origin.origin, rateSecret: env.RATE_LIMIT_SECRET!, production, writesDisabled: env.WRITES_DISABLED === '1' };
}
