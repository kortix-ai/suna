/**
 * Kortix as a Backend (KaaB) — the session-create override contract, black-box.
 * A backend caller (account PAT → origin 'backend') brings a per-end-user
 * identity + connectors + model + secrets BY REFERENCE at session start; a
 * non-backend caller may not. Maps to spec §27 (KAAB-*). See
 * docs/KORTIX_AS_A_BACKEND_GUIDE.md.
 *
 * All flows provision a REAL managed repo + (happy paths) a sandbox, so they
 * carry the same requires as SESS-1. The 4xx contract paths reject before
 * provisioning; they still seed a project so a declared agent exists.
 */
import { flow } from '../core/flow';

const REQ = { domain: 'kaab', timeoutMs: 120_000 };
const CREATE = 'POST /v1/projects/:projectId/sessions';

flow(
  'KAAB-1',
  { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    await ctx.step('backend PAT create with overrides → 201, echoes origin/origin_ref', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { origin_ref: 'end-user-42', runtime_context: { tenant: 'acme' } },
          { params: { projectId: p.id } },
        );
      r.status(201);
      // origin is DERIVED from the token kind (a PAT ⇒ backend), never the body.
      r.body().has('$.origin', 'backend');
      r.body().has('$.origin_ref', 'end-user-42');
      const id = r.json<any>()?.session_id ?? r.json<any>()?.id;
      if (id) ctx.track('session', id, { projectId: p.id });
    });
  },
);

flow(
  'KAAB-2',
  { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    await ctx.step('non-backend (user) setting origin_ref → 403 origin_override_forbidden', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/sessions', { origin_ref: 'spoofed' }, { params: { projectId: p.id } });
      r.status(403);
      r.body().has('$.code', 'origin_override_forbidden');
    });
    await ctx.step('non-backend (user) setting secrets → 403 origin_override_forbidden', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/sessions', { secrets: ['ANYTHING'] }, { params: { projectId: p.id } });
      r.status(403);
      r.body().has('$.code', 'origin_override_forbidden');
    });
  },
);

flow(
  'KAAB-3',
  { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    await ctx.step('backend secrets=[unknown identifier] → 404 SECRET_IDENTIFIER_NOT_FOUND', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { secrets: ['DEFINITELY_NOT_A_REAL_SECRET_XYZ'] },
          { params: { projectId: p.id } },
        );
      r.status(404);
      r.body().has('$.code', 'SECRET_IDENTIFIER_NOT_FOUND');
    });
    await ctx.step('backend secrets=[] (inject zero) → 201, secrets_allowlist=[]', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post('/v1/projects/:projectId/sessions', { secrets: [] }, { params: { projectId: p.id } });
      r.status(201);
      r.body().has('$.secrets_allowlist', []);
      const id = r.json<any>()?.session_id ?? r.json<any>()?.id;
      if (id) ctx.track('session', id, { projectId: p.id });
    });
  },
);

flow(
  'KAAB-4',
  { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    await ctx.step('backend opencode_model=unservable → 400 INVALID_SESSION_MODEL (fail-fast, not a dead turn)', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { opencode_model: 'totally-bogus-model-xyz-9999' },
          { params: { projectId: p.id } },
        );
      r.status(400);
      r.body().has('$.code', 'INVALID_SESSION_MODEL');
    });
  },
);

flow(
  'KAAB-5',
  { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    await ctx.step('backend runtime_context with a credential-like key → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { runtime_context: { api_key: 'x' } },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('backend runtime_context over the 64-entry cap → 400', async () => {
      const ctx64: Record<string, string> = {};
      for (let i = 0; i < 70; i++) ctx64[`k${i}`] = String(i);
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post('/v1/projects/:projectId/sessions', { runtime_context: ctx64 }, { params: { projectId: p.id } });
      r.status(400);
    });
  },
);

flow(
  'KAAB-6',
  { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    const key = ctx.fixtures.name('kaab-idem');
    let first: string | undefined;
    await ctx.step('backend create with Idempotency-Key → 201', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { origin_ref: 'idem-user' },
          { params: { projectId: p.id }, headers: { 'Idempotency-Key': key } },
        );
      r.status(201);
      first = r.json<any>()?.session_id ?? r.json<any>()?.id;
      if (first) ctx.track('session', first, { projectId: p.id });
    });
    await ctx.step('same key + same body replays the SAME session (no double-create)', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { origin_ref: 'idem-user' },
          { params: { projectId: p.id }, headers: { 'Idempotency-Key': key } },
        );
      r.status([200, 201, 202]);
      r.body().has('$.session_id', first);
    });
    await ctx.step('same key + different secrets body → 409 IDEMPOTENCY_SECRETS_CONFLICT', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { origin_ref: 'idem-user', secrets: [] },
          { params: { projectId: p.id }, headers: { 'Idempotency-Key': key } },
        );
      r.status(409);
    });
  },
);

flow(
  'KAAB-7',
  { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] },
  async (ctx) => {
    const p = await ctx.fixtures.project({ seed: true });
    const key = ctx.fixtures.name('kaab-idem-ident');
    await ctx.step('backend create with Idempotency-Key + origin_ref:alice → 201', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { origin_ref: 'alice' },
          { params: { projectId: p.id }, headers: { 'Idempotency-Key': key } },
        );
      r.status(201);
      const id = r.json<any>()?.session_id ?? r.json<any>()?.id;
      if (id) ctx.track('session', id, { projectId: p.id });
    });
    await ctx.step('same key, DIFFERENT origin_ref:bob → 409 (no cross-end-user session bleed)', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          { origin_ref: 'bob' },
          { params: { projectId: p.id }, headers: { 'Idempotency-Key': key } },
        );
      r.status(409);
      r.body().has('$.code', 'IDEMPOTENCY_ORIGIN_CONFLICT');
    });
    await ctx.step('oversized Idempotency-Key header → 400 INVALID_IDEMPOTENCY_KEY (not a 500)', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post(
          '/v1/projects/:projectId/sessions',
          {},
          { params: { projectId: p.id }, headers: { 'Idempotency-Key': 'x'.repeat(300) } },
        );
      r.status(400);
      r.body().has('$.code', 'INVALID_IDEMPOTENCY_KEY');
    });
  },
);
