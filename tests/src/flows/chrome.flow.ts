/**
 * Kortix in Chrome (apps/api/src/chrome): a person's own Chrome, connected to
 * Kortix through the extension's control socket and driven from a session
 * sandbox. Maps to spec CHR-*. Protocol:
 * .agents/skills/kortix-chrome/references/protocol.md
 *
 * The flows play the extension: they sign in with OAuth (public client, PKCE,
 * scope `kortix`, as the extension does), open `/v1/chrome/ws`, send the
 * first-frame `auth`, and answer `attach` frames.
 */
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { Client } from '../core/client';
import type { FlowContext, Principal } from '../core/types';
import { setFeatureAsOperator } from '../fixtures/feature-flags';
import { openFlowDb, seedTurnSession } from '../fixtures/turn-end';

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** What the extension does: register a public client, authorize with PKCE, redeem the code. */
async function oauthToken(
  ctx: FlowContext,
  who: Principal,
  scope = 'kortix',
  redirectUri = 'http://127.0.0.1:33417/callback',
): Promise<string> {
  const reg = await ctx.client.as(ctx.P.ANON).post('/v1/oauth/register', {
    client_name: 'Kortix in Chrome',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    scope,
  });
  reg.status(201);
  const clientId = reg.json<{ client_id: string }>().client_id;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  const authz = await ctx.client.as(ctx.P.ANON).get('/v1/oauth/authorize', {
    query: { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, code_challenge: challenge, code_challenge_method: 'S256' },
  });
  authz.status(302);
  const requestId = new URL(authz.header('location')!).searchParams.get('request_id')!;
  const ok = await ctx.client.as(who).post('/v1/oauth/authorize/consent', { request_id: requestId, approved: true });
  ok.status(200);
  const code = new URL(ok.json<{ redirect_uri: string }>().redirect_uri).searchParams.get('code')!;
  const tok = await ctx.client.as(ctx.P.ANON).post(
    '/v1/oauth/token',
    form({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier }),
  );
  tok.status(200);
  return tok.json<{ access_token: string }>().access_token;
}

type Frame = Record<string, any>;

/** A control socket played from the extension's side. */
class Control {
  private frames: Frame[] = [];
  private listeners: Array<() => void> = [];
  closed: { code: number; reason: string } | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      this.frames.push(JSON.parse(String(event.data)));
      this.listeners.forEach((l) => l());
    };
    ws.onclose = (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.listeners.forEach((l) => l());
    };
  }

  static open(ctx: FlowContext): Promise<Control> {
    const url = `${ctx.env.apiUrl.replace(/^http/, 'ws')}/chrome/ws`;
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(new Control(ws));
      ws.onerror = () => reject(new Error(`control socket did not open: ${url}`));
    });
  }

  /** Open, send `auth`, and wait for `auth_ok`. */
  static async connect(ctx: FlowContext, token: string, chromeId: string | null = null): Promise<{ control: Control; chrome: Frame }> {
    const control = await Control.open(ctx);
    control.send({
      type: 'auth',
      token,
      chromeId,
      info: { brand: 'Chrome', os: 'macOS', profileLabel: 'Flow', extensionVersion: '1.0.0' },
    });
    const ok = await control.take((f) => f.type === 'auth_ok');
    return { control, chrome: ok.chrome };
  }

  send(frame: Frame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait for the first frame that matches; remove and return it. */
  async take(match: (f: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.frames.findIndex(match);
      if (at >= 0) return this.frames.splice(at, 1)[0];
      if (this.closed) throw new Error(`socket closed ${this.closed.code} ${this.closed.reason} while waiting for a frame`);
      if (Date.now() >= deadline) throw new Error(`no matching frame in ${timeoutMs} ms; got ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 200);
        this.listeners.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Wait for the socket to close; returns the close code. */
  async closedWith(timeoutMs = 10_000): Promise<number> {
    await waitFor(() => this.closed, { until: (c) => c !== null, timeoutMs, intervalMs: 100, description: 'socket close' });
    return this.closed!.code;
  }

  dispose(): void {
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

/** A socket that closes on its own is a refusal; resolve with its code. */
async function refusedWith(ctx: FlowContext, frame: Frame): Promise<number> {
  const control = await Control.open(ctx);
  try {
    control.send(frame);
    return await control.closedWith();
  } finally {
    control.dispose();
  }
}

async function freshUser(ctx: FlowContext): Promise<Principal> {
  const team = await ctx.fixtures.team();
  return team.addMember('member');
}

function listOf(client: Client) {
  return client.get('/v1/chrome/connections').then((r) => {
    r.status(200);
    return r.json<Frame[]>();
  });
}

// ── CHR-1: list, auth boundary ───────────────────────────────────────────────
flow(
  'CHR-1',
  {
    domain: 'chrome',
    tags: ['smoke'],
    routes: ['GET /v1/chrome/connections'],
  },
  async (ctx) => {
    await ctx.step('ANON cannot list browsers → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).get('/v1/chrome/connections')).status(401);
    });

    await ctx.step('a user with no browser gets an empty list → 200 []', async () => {
      const a = await freshUser(ctx);
      const r = await ctx.client.as(a).get('/v1/chrome/connections');
      r.status(200);
      if (r.json<unknown[]>().length !== 0) throw new Error(`expected []: ${JSON.stringify(r.json())}`);
    });
  },
);

// ── CHR-2: the control socket authenticates and the browser appears online ───
flow(
  'CHR-2',
  {
    domain: 'chrome',
    routes: ['GET /v1/chrome/connections', 'POST /v1/oauth/register', 'POST /v1/oauth/token', 'POST /v1/accounts/tokens'],
  },
  async (ctx) => {
    const a = await freshUser(ctx);
    let chromeId = '';
    const sockets: Control[] = [];
    try {
      await ctx.step('a bad token → close 4001', async () => {
        const code = await refusedWith(ctx, { type: 'auth', token: 'kortix_oat_not-a-real-token', chromeId: null, info: {} });
        if (code !== 4001) throw new Error(`close code ${code}`);
      });

      await ctx.step('an OAuth token without the kortix scope → close 4001', async () => {
        const profileOnly = await oauthToken(ctx, a, 'profile');
        const code = await refusedWith(ctx, { type: 'auth', token: profileOnly, chromeId: null, info: {} });
        if (code !== 4001) throw new Error(`close code ${code}`);
      });

      await ctx.step('a frame other than auth first → close 4001', async () => {
        const code = await refusedWith(ctx, { type: 'ping' });
        if (code !== 4001) throw new Error(`close code ${code}`);
      });

      let token = '';
      await ctx.step('a kortix-scoped OAuth token → auth_ok with a new ChromeConnection and the web URL', async () => {
        token = await oauthToken(ctx, a);
        const { control, chrome } = await Control.connect(ctx, token);
        sockets.push(control);
        chromeId = chrome.id;
        if (!/^[0-9a-f-]{36}$/.test(chromeId)) throw new Error(`browser id: ${chromeId}`);
        if (chrome.brand !== 'Chrome' || chrome.os !== 'macOS') throw new Error(`chrome: ${JSON.stringify(chrome)}`);
        if (chrome.accessMode !== 'always' || chrome.tabScope !== 'all') throw new Error(`defaults: ${JSON.stringify(chrome)}`);
        if (!Array.isArray(chrome.activeSessions)) throw new Error('activeSessions missing');
      });

      await ctx.step('ping → pong, and GET /v1/chrome/connections lists the browser online', async () => {
        sockets[0].send({ type: 'ping' });
        await sockets[0].take((f) => f.type === 'pong');
        const list = await listOf(ctx.client.as(a));
        const mine = list.find((b) => b.id === chromeId);
        if (!mine) throw new Error(`browser missing from list: ${JSON.stringify(list)}`);
        if (mine.online !== true) throw new Error(`not online: ${JSON.stringify(mine)}`);
        if (!mine.lastSeenAt) throw new Error('lastSeenAt not set');
      });

      await ctx.step('the same OAuth token as a REST credential lists the same browser', async () => {
        const list = await listOf(ctx.client.withBearer(token, 'OAUTH_EXTENSION'));
        if (!list.some((b) => b.id === chromeId)) throw new Error('OAuth REST list lacks the browser');
      });

      await ctx.step('reconnect with the stored chromeId reuses the row; the old socket closes', async () => {
        const again = await Control.connect(ctx, token, chromeId);
        sockets.push(again.control);
        if (again.chrome.id !== chromeId) throw new Error(`new id ${again.chrome.id}`);
        await sockets[0].closedWith();
        const list = await listOf(ctx.client.as(a));
        if (list.filter((b) => b.id === chromeId).length !== 1) throw new Error('duplicate rows');
      });

      await ctx.step('a user PAT that is not session-scoped authenticates too', async () => {
        const minted = await ctx.client.as(a).post('/v1/accounts/tokens', { name: ctx.fixtures.name('chr-pat') });
        minted.status(201);
        const { control, chrome } = await Control.connect(ctx, minted.json<{ secret_key: string }>().secret_key);
        sockets.push(control);
        if (!chrome.id) throw new Error('PAT connect returned no browser');
        if (chrome.id === chromeId) throw new Error('a null chromeId must create a new row');
      });
    } finally {
      sockets.forEach((s) => s.dispose());
    }
  },
);

// ── CHR-3: rename and access mode ────────────────────────────────────────────
flow(
  'CHR-3',
  {
    domain: 'chrome',
    routes: ['GET /v1/chrome/connections', 'PATCH /v1/chrome/connections/:id', 'POST /v1/oauth/register', 'POST /v1/oauth/token'],
  },
  async (ctx) => {
    const a = await freshUser(ctx);
    const { control, chrome } = await Control.connect(ctx, await oauthToken(ctx, a));
    const params = { id: chrome.id as string };
    try {
      await ctx.step('PATCH renames and sets accessMode and tabScope → 200 ChromeConnection; the extension gets a chrome frame', async () => {
        const r = await ctx.client.as(a).patch('/v1/chrome/connections/:id', { name: 'Work laptop', accessMode: 'ask', tabScope: 'all' }, { params });
        r.status(200).body().has('$.name', 'Work laptop').has('$.accessMode', 'ask').has('$.tabScope', 'all');
        const pushed = await control.take((f) => f.type === 'chrome');
        if (pushed.chrome.name !== 'Work laptop' || pushed.chrome.accessMode !== 'ask') {
          throw new Error(`pushed: ${JSON.stringify(pushed)}`);
        }
      });

      await ctx.step('GET reads the change back', async () => {
        const mine = (await listOf(ctx.client.as(a))).find((b) => b.id === chrome.id);
        if (mine?.name !== 'Work laptop' || mine.accessMode !== 'ask') throw new Error(JSON.stringify(mine));
      });

      await ctx.step('invalid values → 400', async () => {
        for (const body of [{ accessMode: 'sometimes' }, { tabScope: 'everything' }, { name: '' }, { unknown: 1 }]) {
          (await ctx.client.as(a).patch('/v1/chrome/connections/:id', body, { params })).status(400);
        }
      });

      await ctx.step('ANON → 401; a non-uuid id → 404', async () => {
        (await ctx.client.as(ctx.P.ANON).patch('/v1/chrome/connections/:id', { name: 'x' }, { params })).status(401);
        const r = await ctx.client.as(a).patch('/v1/chrome/connections/:id', { name: 'x' }, { params: { id: 'not-a-uuid' } });
        r.status(404).body().has('$.code', 'chrome_not_found');
      });
    } finally {
      control.dispose();
    }
  },
);

// ── CHR-4: disconnecting a browser revokes it ────────────────────────────────
flow(
  'CHR-4',
  {
    domain: 'chrome',
    routes: ['GET /v1/chrome/connections', 'DELETE /v1/chrome/connections/:id', 'POST /v1/oauth/register', 'POST /v1/oauth/token'],
  },
  async (ctx) => {
    const a = await freshUser(ctx);
    const token = await oauthToken(ctx, a);
    const { control, chrome } = await Control.connect(ctx, token);
    const params = { id: chrome.id as string };
    try {
      await ctx.step('DELETE → 204 and the control socket closes 4003', async () => {
        (await ctx.client.as(a).del('/v1/chrome/connections/:id', { params })).status(204);
        const code = await control.closedWith();
        if (code !== 4003) throw new Error(`close code ${code}`);
      });

      await ctx.step('the row is gone from the list; a second DELETE → 404', async () => {
        if ((await listOf(ctx.client.as(a))).some((b) => b.id === chrome.id)) throw new Error('revoked browser still listed');
        (await ctx.client.as(a).del('/v1/chrome/connections/:id', { params })).status(404);
      });

      await ctx.step('connecting with the revoked chromeId creates a new row', async () => {
        const again = await Control.connect(ctx, token, chrome.id);
        try {
          if (again.chrome.id === chrome.id) throw new Error('revoked id was reused');
        } finally {
          again.control.dispose();
        }
      });
    } finally {
      control.dispose();
    }
  },
);

// ── CHR-5: attach is a sandbox route ─────────────────────────────────────────
flow(
  'CHR-5',
  {
    domain: 'chrome',
    routes: ['POST /v1/chrome/attach', 'POST /v1/chrome/release'],
  },
  async (ctx) => {
    const a = await freshUser(ctx);
    const body = { ticket: 'dGlja2V0LWZvci10ZXN0cw', ask: false };

    await ctx.step('ANON → 401 on attach and release', async () => {
      (await ctx.client.as(ctx.P.ANON).post('/v1/chrome/attach', body)).status(401);
      (await ctx.client.as(ctx.P.ANON).post('/v1/chrome/release', { attachmentId: crypto.randomUUID() })).status(401);
    });

    await ctx.step('a signed-in user (not a sandbox credential) → 403 on attach and release', async () => {
      (await ctx.client.as(a).post('/v1/chrome/attach', body)).status(403);
      (await ctx.client.as(a).post('/v1/chrome/release', { attachmentId: crypto.randomUUID() })).status(403);
    });

    await ctx.step('an OAuth token (not a sandbox credential) → 403', async () => {
      const oat = ctx.client.withBearer(await oauthToken(ctx, a), 'OAUTH_EXTENSION');
      (await oat.post('/v1/chrome/attach', body)).status(403);
    });
  },
);

// ── CHR-8: the side panel signs in with the extension's own token ────────────
const EXTENSION_REDIRECT_URI = 'chrome-extension://gefbbnjgoiljpbnalgafbhbfdhikgjek/welcome.html';

flow(
  'CHR-8',
  {
    domain: 'chrome',
    routes: ['POST /v1/chrome/panel-session', 'POST /v1/oauth/register', 'POST /v1/oauth/token'],
  },
  async (ctx) => {
    const a = await freshUser(ctx);

    await ctx.step('ANON → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).post('/v1/chrome/panel-session', {})).status(401);
    });

    await ctx.step('a signed-in user (Supabase JWT) → 403 chrome_panel_forbidden', async () => {
      const r = await ctx.client.as(a).post('/v1/chrome/panel-session', {});
      r.status(403);
      if (r.json<{ code: string }>().code !== 'chrome_panel_forbidden') throw new Error(r.text());
    });

    await ctx.step('an OAuth token of another client → 403 chrome_panel_forbidden', async () => {
      const other = ctx.client.withBearer(await oauthToken(ctx, a), 'OAUTH_OTHER_CLIENT');
      const r = await other.post('/v1/chrome/panel-session', {});
      r.status(403);
      if (r.json<{ code: string }>().code !== 'chrome_panel_forbidden') throw new Error(r.text());
    });

    await ctx.step('an OAuth token of the extension client → 200 with a tokenHash, never cached', async () => {
      const oat = ctx.client.withBearer(await oauthToken(ctx, a, 'kortix', EXTENSION_REDIRECT_URI), 'OAUTH_EXTENSION');
      const r = await oat.post('/v1/chrome/panel-session', {});
      r.status(200);
      const { tokenHash } = r.json<{ tokenHash: string }>();
      if (!tokenHash || tokenHash.length < 20) throw new Error(`tokenHash: ${tokenHash}`);
      // Every credentialed response is `private, no-store` (middleware/cache-control.ts).
      if (r.header('cache-control') !== 'private, no-store') throw new Error(`cache-control: ${r.header('cache-control')}`);
    });
  },
);

// ── CHR-6: a browser belongs to one person ───────────────────────────────────
flow(
  'CHR-6',
  {
    domain: 'chrome',
    routes: ['GET /v1/chrome/connections', 'PATCH /v1/chrome/connections/:id', 'DELETE /v1/chrome/connections/:id', 'POST /v1/oauth/register', 'POST /v1/oauth/token'],
  },
  async (ctx) => {
    const a = await freshUser(ctx);
    const b = await freshUser(ctx);
    const { control, chrome } = await Control.connect(ctx, await oauthToken(ctx, a));
    const params = { id: chrome.id as string };
    try {
      await ctx.step("another user's list does not contain the browser", async () => {
        if ((await listOf(ctx.client.as(b))).length !== 0) throw new Error('B sees a browser');
      });

      await ctx.step("another user cannot patch or delete it → 404; it is untouched", async () => {
        (await ctx.client.as(b).patch('/v1/chrome/connections/:id', { name: 'stolen' }, { params })).status(404);
        (await ctx.client.as(b).del('/v1/chrome/connections/:id', { params })).status(404);
        const mine = (await listOf(ctx.client.as(a))).find((x) => x.id === chrome.id);
        if (!mine || mine.name === 'stolen' || !mine.online) throw new Error(`browser changed: ${JSON.stringify(mine)}`);
      });

      await ctx.step("B's control socket with the same chromeId gets its own new row", async () => {
        const theirs = await Control.connect(ctx, await oauthToken(ctx, b), chrome.id);
        try {
          if (theirs.chrome.id === chrome.id) throw new Error("B took A's browser id");
        } finally {
          theirs.control.dispose();
        }
      });
    } finally {
      control.dispose();
    }
  },
);

// ── CHR-7: a session attaches, with consent, and Stop denies it ──────────────
flow(
  'CHR-7',
  {
    domain: 'chrome',
    requires: ['database'],
    timeoutMs: 120_000,
    routes: [
      'GET /v1/chrome/connections',
      'PATCH /v1/chrome/connections/:id',
      'DELETE /v1/chrome/connections/:id',
      'POST /v1/chrome/attach',
      'POST /v1/chrome/release',
      'POST /v1/oauth/register',
      'POST /v1/oauth/token',
      'PUT /v1/admin/api/projects/:id/features',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const owner = await team.addMember('member');
    await team.grantProjectRole(project.id, owner.userId!, 'member');
    const db = await openFlowDb(ctx.env);
    const session = await seedTurnSession(ctx, db, { projectId: project.id, accountId: team.id, creator: owner }).catch(async (error) => {
      await db.end();
      throw error;
    });
    const { control, chrome } = await Control.connect(ctx, await oauthToken(ctx, owner));
    const ticket = 'dGlja2V0LWZvci10ZXN0cw';
    const attach = (extra: Record<string, unknown> = {}) => session.sandbox.post('/v1/chrome/attach', { ticket, ...extra });
    let attachmentId = '';
    try {
      await ctx.step("the project's chrome flag off → attach 403 feature_disabled; cleared, it is on by default", async () => {
        await setFeatureAsOperator(ctx, project.id, 'chrome', false);
        (await attach()).status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'chrome');
        await setFeatureAsOperator(ctx, project.id, 'chrome', null);
      });

      await ctx.step('mode always: attach → 200; the extension gets an attach frame without a prompt', async () => {
        const r = await attach();
        r.status(200).body().has('$.chrome.id', chrome.id).exists('$.attachmentId');
        attachmentId = r.json<{ attachmentId: string }>().attachmentId;
        const frame = await control.take((f) => f.type === 'attach');
        if (frame.attachmentId !== attachmentId) throw new Error(`attach frame: ${JSON.stringify(frame)}`);
        if (frame.consent !== false) throw new Error('consent must be false in mode always');
        if (frame.sessionId !== session.sessionId || frame.projectId !== project.id) throw new Error(JSON.stringify(frame));
        if (frame.sessionTitle !== 'Refactor the billing page') throw new Error(`title: ${frame.sessionTitle}`);
        if (!String(frame.bridgePath).endsWith(`/8000/kortix/chrome/bridge?ticket=${ticket}`)) throw new Error(frame.bridgePath);
        if (!String(frame.bridgePath).startsWith('/v1/p/')) throw new Error(frame.bridgePath);
      });

      await ctx.step('attached → the browser lists the session under activeSessions with its title', async () => {
        control.send({ type: 'attached', attachmentId });
        const mine = await waitFor(async () => (await listOf(ctx.client.as(owner))).find((b) => b.id === chrome.id), {
          until: (b) => (b?.activeSessions?.length ?? 0) > 0,
          timeoutMs: 10_000,
          intervalMs: 200,
          description: 'activeSessions',
        });
        const s = mine!.activeSessions[0];
        if (s.sessionId !== session.sessionId || s.title !== 'Refactor the billing page') throw new Error(JSON.stringify(s));
      });

      await ctx.step('release → 204 with the flag off too; the extension gets detach; activeSessions empties', async () => {
        // A session can always let go: release is not behind the flag.
        await setFeatureAsOperator(ctx, project.id, 'chrome', false);
        (await session.sandbox.post('/v1/chrome/release', { attachmentId })).status(204);
        await setFeatureAsOperator(ctx, project.id, 'chrome', null);
        const frame = await control.take((f) => f.type === 'detach');
        if (frame.attachmentId !== attachmentId) throw new Error(JSON.stringify(frame));
        const mine = (await listOf(ctx.client.as(owner))).find((b) => b.id === chrome.id);
        if (mine?.activeSessions.length !== 0) throw new Error('session still active');
      });

      await ctx.step('mode ask: attach waits for the prompt; consent "session" → 200', async () => {
        (await ctx.client.as(owner).patch('/v1/chrome/connections/:id', { accessMode: 'ask' }, { params: { id: chrome.id } })).status(200);
        const pending = attach();
        const frame = await control.take((f) => f.type === 'attach');
        if (frame.consent !== true) throw new Error('consent must be true in mode ask');
        control.send({ type: 'consent', attachmentId: frame.attachmentId, decision: 'session' });
        (await pending).status(200).body().has('$.attachmentId', frame.attachmentId);
        attachmentId = frame.attachmentId;
        control.send({ type: 'attached', attachmentId });
      });

      await ctx.step('the session allow is remembered: the next attach needs no prompt', async () => {
        const r = await attach();
        r.status(200);
        const frame = await control.take((f) => f.type === 'attach');
        if (frame.consent !== false) throw new Error('a remembered allow must not prompt again');
        attachmentId = frame.attachmentId;
      });

      await ctx.step('Stop in Chrome → detached "stopped"; the next attach → 403 chrome_denied with connectUrl', async () => {
        control.send({ type: 'detached', attachmentId, reason: 'stopped' });
        await waitFor(() => attach(), {
          until: (r) => r.statusCode === 403,
          timeoutMs: 10_000,
          intervalMs: 300,
          description: 'deny after Stop',
        });
        const r = await attach();
        r.status(403).body().has('$.code', 'chrome_denied').exists('$.error').exists('$.connectUrl');
        if (!String(r.json<{ connectUrl: string }>().connectUrl).endsWith('/settings/chrome')) throw new Error('connectUrl');
      });

      await ctx.step('ask=true shows a new prompt; deny in Chrome → 403 chrome_denied', async () => {
        const pending = attach({ ask: true });
        const frame = await control.take((f) => f.type === 'attach' && f.consent === true);
        control.send({ type: 'consent', attachmentId: frame.attachmentId, decision: 'deny' });
        (await pending).status(403).body().has('$.code', 'chrome_denied');
      });

      await ctx.step('mode off → 403 chrome_access_off', async () => {
        (await ctx.client.as(owner).patch('/v1/chrome/connections/:id', { accessMode: 'off' }, { params: { id: chrome.id } })).status(200);
        (await attach({ ask: true })).status(403).body().has('$.code', 'chrome_access_off');
      });

      await ctx.step('a body without a ticket → 400; an unknown browser name → 404 chrome_not_found', async () => {
        (await ctx.client.as(owner).patch('/v1/chrome/connections/:id', { accessMode: 'always' }, { params: { id: chrome.id } })).status(200);
        (await session.sandbox.post('/v1/chrome/attach', {})).status(400);
        (await attach({ chrome: 'no-such-chrome' })).status(404).body().has('$.code', 'chrome_not_found');
      });

      await ctx.step('disconnect the browser → attach → 404 chrome_not_connected', async () => {
        (await ctx.client.as(owner).del('/v1/chrome/connections/:id', { params: { id: chrome.id } })).status(204);
        (await attach()).status(404).body().has('$.code', 'chrome_not_connected');
      });
    } finally {
      control.dispose();
      await session.cleanup();
      await db.query('DELETE FROM kortix.chrome_connections WHERE chrome_id = $1', [chrome.id]).catch(() => {});
      await db.end();
    }
  },
);
