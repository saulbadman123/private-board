import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { createApp, unavailable } from './server/app.ts';
import { readConfig } from './server/config.ts';
import { createStore } from './server/store.ts';

// Development-only API adapter. Server modules never enter the client graph.
function apiPlugin(env: NodeJS.ProcessEnv): Plugin {
  let app: ReturnType<typeof createApp> | undefined;
  try { const config = readConfig(env); app = createApp(createStore(config), config); } catch { /* explicit 503 until configured */ }
  return { name: 'private-board-local-api', configureServer(server) {
    server.middlewares.use('/api', async (req, res) => {
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > 3.5*1024*1024) { res.statusCode = 413; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:{code:'TOO_LARGE',message:'This request is too large.'}})); return; }
          chunks.push(buffer);
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const method = req.method ?? 'GET';
        const request = new Request(`${env.APP_ORIGIN ?? 'http://localhost:5173'}/api${req.url}`, {
          method, headers, ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(chunks) } : {})
        });
        const response = app ? await app(request) : unavailable();
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.statusCode = 503; res.end(); }
    });
  } };
}
export default defineConfig(({ mode }) => ({
  plugins: [apiPlugin({ ...process.env, ...loadEnv(mode, process.cwd(), '') })],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0, emptyOutDir:true }
}));
