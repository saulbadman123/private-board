import { createApp, unavailable } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import { createStore } from '../server/store.ts';

let app: ReturnType<typeof createApp> | undefined;
export default {
  async fetch(request: Request): Promise<Response> {
    if (!app) {
      try { const config = readConfig(); app = createApp(createStore(config), config); }
      catch { return unavailable(); }
    }
    return app(request);
  }
};
