/**
 * 11 — "Sign in with Kortix": gate your own app behind Kortix identity.
 *
 * Your app never sees a Kortix token. `createKortixAuth` owns the whole
 * OAuth 2.1 flow (PKCE, the callback, an encrypted HttpOnly session cookie,
 * silent refresh, sign-out with revocation) and gives you three things:
 *
 *   auth.handler(request)  — ONE catch-all route: /signin /callback /refresh
 *                            /signout /me /proxy/*
 *   auth.viewer(request)   — who is signed in (user id, email, accounts, scopes)
 *   auth.kortix(request)   — a request-scoped SDK client acting AS that viewer
 *
 * Register the app once (Account → Tokens → OAuth apps, or
 * `kortix.iam.oauthClients.create`) with redirect URI
 * `http://localhost:8792/api/kortix/auth/callback`, then:
 *
 *   KORTIX_API_URL=http://localhost:8008/v1 \
 *   KORTIX_OAUTH_CLIENT_ID=... KORTIX_OAUTH_CLIENT_SECRET=... \
 *   KORTIX_AUTH_COOKIE_SECRET=$(openssl rand -hex 32) \
 *     bun run examples/11-sign-in-with-kortix.ts
 *
 * Open http://localhost:8792 → "Sign in with Kortix" → consent → back here,
 * signed in, with your projects listed as you. Bun only (`@kortix/sdk/server`
 * imports node:async_hooks).
 *
 * As an npm consumer:
 *   import { createKortixAuth } from '@kortix/sdk/server';
 *   // Next.js: export const GET = POST = (req) => auth.handler(req)
 *   //          in app/api/kortix/auth/[...kortix]/route.ts
 */
import { createKortixAuth } from '../src/node/server';

const port = Number(process.env.PORT ?? 8792);
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;

const auth = createKortixAuth({
  backendUrl: process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1',
  clientId: process.env.KORTIX_OAUTH_CLIENT_ID ?? '',
  clientSecret: process.env.KORTIX_OAUTH_CLIENT_SECRET, // omit for a public client
  redirectUri: `${origin}/api/kortix/auth/callback`,
  cookieSecret: process.env.KORTIX_AUTH_COOKIE_SECRET ?? '',
});

const html = (body: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;margin:3rem">${body}</body>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    // 1. The auth routes — one line.
    if (url.pathname.startsWith(auth.basePath)) return auth.handler(request);

    // 2. Everything else is gated: no viewer → redirect into sign-in.
    const gate = await auth.requireViewer(request);
    if (gate.response) return gate.response;

    // 3. Act as the viewer.
    const kortix = await auth.kortix(request);
    const projects = await kortix.projects.list();
    return html(
      `<h1>Hi ${gate.viewer.email}</h1>
       <p>Kortix user <code>${gate.viewer.userId}</code>, scopes <code>${gate.viewer.scopes.join(' ')}</code></p>
       <h2>Your projects</h2><ul>${projects.map((p) => `<li>${p.name}</li>`).join('')}</ul>
       <p><a href="${auth.signOutUrl('/')}">Sign out</a></p>`,
    );
  },
});

console.log(`Sign in with Kortix demo → ${origin}`);
