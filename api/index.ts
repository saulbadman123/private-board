import { createApp, unavailable } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import { createStore } from '../server/store.ts';

let app: ReturnType<typeof createApp> | undefined;
export default {
  async fetch(request: Request): Promise<Response> {
    if (!app) {
      try { const config = readConfig(); app = createApp(createStore(config), config); }
      catch (error) {
  const safeMessages = new Set([
    'Missing server configuration',
    'Invalid URL',
    'APP_ORIGIN must be an exact origin',
    'Production requires HTTPS',
    'Rate limit secret is too short',
    'WRITES_DISABLED must be 0 or 1'
  ]);

  const message = error instanceof Error ? error.message : '';
  console.error(
    'Board startup:',
    safeMessages.has(message) ? message : 'Client initialization failed'
  );

  const required = [
    'SUPABASE_URL', 'SUPABASE_SECRET_KEY',
    'APP_ORIGIN', 'RATE_LIMIT_SECRET'
  ];
  console.error(
    'Missing or placeholder variables:',
    required.filter(name =>
      !process.env[name] ||
      /YOUR_|REPLACE_WITH/.test(process.env[name]!)
    )
  );

  return unavailable();
}
    }
    return app(request);
  }
};
