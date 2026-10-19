import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';

/**
 * Deployed as a Kortix App, the Apps gate serves two paths on the App's own
 * origin: `/_kortix/viewer` (who is looking, plus a 1-hour viewer token) and
 * `/_kortix/api/v1/*` (the Kortix API, called as that viewer). The browser
 * code talks to those two paths only.
 *
 * In `vite dev` and `vite preview` this file stands in for the gate, so the same browser code
 * runs unchanged:
 * - `/_kortix/api/v1/*` proxies to `KORTIX_API_URL` and sets
 *   `Authorization: Bearer $KORTIX_API_KEY`. The key stays in this Node
 *   process; the browser never sees it. Same-origin, so no CORS.
 * - `/_kortix/viewer` answers a local viewer whose `access_token` is a
 *   placeholder. The proxy replaces it with the key.
 *
 * Put the two values in `.env.local` (gitignored) or the shell environment.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiUrl = new URL(env.KORTIX_API_URL || 'http://localhost:8008/v1');
  const apiKey = env.KORTIX_API_KEY;
  const apiPath = apiUrl.pathname.replace(/\/$/, '');
  const port = Number(env.PORT || 3032);
  const proxy = apiKey
    ? {
        '/_kortix/api/v1': {
          target: apiUrl.origin,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/_kortix\/api\/v1/, apiPath),
          headers: { authorization: `Bearer ${apiKey}` },
        },
      }
    : undefined;

  return {
    plugins: [localGate(apiKey)],
    define: { 'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development') },
    // @kortix/ui marks client modules with "use client" for Next hosts; a SPA ignores it.
    build: {
      rollupOptions: {
        onwarn: (warning, warn) => warning.code !== 'MODULE_LEVEL_DIRECTIVE' && warn(warning),
      },
    },
    server: { port, strictPort: true, proxy },
    preview: { port, strictPort: true, proxy },
  };
});

function localGate(apiKey: string | undefined): Plugin {
  const viewer: Connect.NextHandleFunction = (_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!apiKey) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'set KORTIX_API_KEY for local dev' }));
      return;
    }
    res.end(
      JSON.stringify({
        app_id: 'local-dev',
        access_mode: 'project',
        account_id: '',
        user_id: 'local-dev',
        email: null,
        name: 'Local dev (API key)',
        group_ids: [],
        scopes: ['profile', 'kortix'],
        access_token: 'local-dev-proxy',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
  };
  // `vite dev` and `vite preview` (the built dist/) both get the stand-in gate.
  return {
    name: 'local-kortix-apps-gate',
    configureServer: (server) => void server.middlewares.use('/_kortix/viewer', viewer),
    configurePreviewServer: (server) => void server.middlewares.use('/_kortix/viewer', viewer),
  };
}
