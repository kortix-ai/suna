/**
 * 03 — "Kortix as a Backend": a minimal multi-tenant server wrapper.
 *
 * The problem `@kortix/sdk/server` solves: `createKortix()`/`configureKortix()`
 * store the platform config (crucially, the bearer token getter) in a single
 * process-wide module-global. That's fine for a browser tab or a CLI, but a
 * server handling CONCURRENT requests for different end users can't safely
 * call `configureKortix()` once per request — two in-flight requests with
 * different tokens race on the same global and the last write wins for both.
 *
 * `createScopedKortix(config)` fixes this with Node's `AsyncLocalStorage`:
 * the config passed to one call is visible only inside that call's own async
 * continuation, isolated from any other concurrent call in the same process.
 * This is the exact pattern a real wrapper backend uses — mint (or look up) a
 * per-end-user Kortix token, build a scoped client, use it for that request
 * only.
 *
 * Run (Bun only — this subpath statically imports node:async_hooks):
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *     bun run examples/03-server-wrapper.ts
 *   curl http://localhost:8787/projects -H 'x-end-user: alice'
 *   curl http://localhost:8787/projects -H 'x-end-user: bob'   # different token, same process, no cross-talk
 *
 * As an npm consumer:
 *   import { createScopedKortix } from '@kortix/sdk/server';
 */
import { createScopedKortix } from '../src/server';

const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
const upstreamApiKey = process.env.KORTIX_API_KEY;

if (!upstreamApiKey) {
  console.error('Set KORTIX_API_KEY (the wrapper backend\'s own upstream credential) and re-run.');
  process.exit(1);
}

/**
 * Stand-in for "look up this end user's own token/session" — a real wrapper
 * would resolve a per-tenant Kortix PAT (or scope a shared one) from its own
 * auth/session store, keyed off the incoming request, never a hardcoded env var.
 */
function tokenForEndUser(endUserId: string): string {
  console.log(`resolving token for end user "${endUserId}"`);
  // Every end user shares the same upstream credential in this toy example —
  // a real wrapper would mint/store one PAT per tenant instead.
  return upstreamApiKey!;
}

Bun.serve({
  port: 8787,
  async fetch(req) {
    const url = new URL(req.url);
    const endUserId = req.headers.get('x-end-user') ?? 'anonymous';

    // One scoped client PER REQUEST — never a module-global `createKortix()`
    // call reused across requests. This is what makes two concurrent
    // requests for two different end users safe in the same process.
    const kortix = createScopedKortix({
      backendUrl,
      getToken: async () => tokenForEndUser(endUserId),
    });

    if (url.pathname === '/projects' && req.method === 'GET') {
      const projects = await kortix.projects.list();
      return Response.json({ endUserId, projects });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log('Kortix-as-a-Backend demo server listening on http://localhost:8787');
