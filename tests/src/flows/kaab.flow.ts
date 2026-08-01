import { flow } from '../core/flow';

const REQ = { domain: 'kaab', timeoutMs: 120_000 };
const CREATE = 'POST /v1/projects/:projectId/sessions';

flow('KAAB-1', { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] }, async (ctx) => {
  const project = await ctx.fixtures.sharedSeededProject();
  await ctx.step('backend PAT creates a session with runtime context', async () => {
    const response = await ctx.client
      .as(ctx.P.PAT_ACCT)
      .post(
        '/v1/projects/:projectId/sessions',
        { runtime_context: { ticket_id: 'ticket-123' } },
        { params: { projectId: project.id } },
      );
    response.status(201);
    response.body().has('$.origin', 'backend').exists('$.session_id');
    const sessionId = response.json<{ session_id?: string }>()?.session_id;
    if (sessionId) ctx.track('session', sessionId, { projectId: project.id });
  });
});

flow('KAAB-2', { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] }, async (ctx) => {
  const project = await ctx.fixtures.sharedSeededProject();
  await ctx.step('human JWT cannot set a backend secret allowlist', async () => {
    const response = await ctx.client
      .as(ctx.P.OWNER)
      .post(
        '/v1/projects/:projectId/sessions',
        { secrets: ['ANYTHING'] },
        { params: { projectId: project.id } },
      );
    response.status(403);
    response.body().has('$.code', 'origin_override_forbidden');
  });
});

flow('KAAB-3', { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] }, async (ctx) => {
  const project = await ctx.fixtures.sharedSeededProject();
  await ctx.step('unknown secret identifier is rejected', async () => {
    const response = await ctx.client
      .as(ctx.P.PAT_ACCT)
      .post(
        '/v1/projects/:projectId/sessions',
        { secrets: ['DEFINITELY_NOT_A_REAL_SECRET_XYZ'] },
        { params: { projectId: project.id } },
      );
    response.status(404);
    response.body().has('$.code', 'SECRET_IDENTIFIER_NOT_FOUND');
  });
  await ctx.step('empty secret allowlist creates a session with no project secrets', async () => {
    const response = await ctx.client
      .as(ctx.P.PAT_ACCT)
      .post(
        '/v1/projects/:projectId/sessions',
        { secrets: [] },
        { params: { projectId: project.id } },
      );
    response.status(201);
    response.body().has('$.secrets_allowlist', []);
    const sessionId = response.json<{ session_id?: string }>()?.session_id;
    if (sessionId) ctx.track('session', sessionId, { projectId: project.id });
  });
});

flow('KAAB-4', { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] }, async (ctx) => {
  const project = await ctx.fixtures.sharedSeededProject();
  await ctx.step('unavailable model fails during session creation', async () => {
    const response = await ctx.client
      .as(ctx.P.PAT_ACCT)
      .post(
        '/v1/projects/:projectId/sessions',
        { opencode_model: 'totally-bogus-model-xyz-9999' },
        { params: { projectId: project.id } },
      );
    response.status(400);
    response.body().has('$.code', 'INVALID_SESSION_MODEL');
  });
});

flow('KAAB-5', { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] }, async (ctx) => {
  const project = await ctx.fixtures.sharedSeededProject();
  await ctx.step('credential-like runtime context key is rejected', async () => {
    const response = await ctx.client
      .as(ctx.P.PAT_ACCT)
      .post(
        '/v1/projects/:projectId/sessions',
        { runtime_context: { api_key: 'x' } },
        { params: { projectId: project.id } },
      );
    response.status(400);
    response.body().has('$.code', 'INVALID_SESSION_RUNTIME_CONTEXT');
  });
  await ctx.step('runtime context over the entry cap is rejected', async () => {
    const runtimeContext: Record<string, string> = {};
    for (let index = 0; index < 70; index++) runtimeContext[`k${index}`] = String(index);
    const response = await ctx.client
      .as(ctx.P.PAT_ACCT)
      .post(
        '/v1/projects/:projectId/sessions',
        { runtime_context: runtimeContext },
        { params: { projectId: project.id } },
      );
    response.status(400);
    response.body().has('$.code', 'INVALID_SESSION_RUNTIME_CONTEXT');
  });
});

flow('KAAB-6', { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] }, async (ctx) => {
  const project = await ctx.fixtures.sharedSeededProject();
  const key = ctx.fixtures.name('kaab-idempotency');
  const body = { runtime_context: { ticket_id: 'ticket-123' } };
  let sessionId: string | undefined;

  await ctx.step('first idempotent session create succeeds', async () => {
    const response = await ctx.client
      .as(ctx.P.PAT_ACCT)
      .post('/v1/projects/:projectId/sessions', body, {
        params: { projectId: project.id },
        headers: { 'Idempotency-Key': key },
      });
    response.status(201);
    sessionId = response.json<{ session_id?: string }>()?.session_id;
    if (sessionId) ctx.track('session', sessionId, { projectId: project.id });
  });
  await ctx.step('same key and body return the same session', async () => {
    const response = await ctx.client
      .as(ctx.P.PAT_ACCT)
      .post('/v1/projects/:projectId/sessions', body, {
        params: { projectId: project.id },
        headers: { 'Idempotency-Key': key },
      });
    response.status([201, 202]);
    response.body().has('$.session_id', sessionId);
  });
  await ctx.step('changed secret scope conflicts with the idempotency key', async () => {
    const response = await ctx.client.as(ctx.P.PAT_ACCT).post(
      '/v1/projects/:projectId/sessions',
      { ...body, secrets: [] },
      {
        params: { projectId: project.id },
        headers: { 'Idempotency-Key': key },
      },
    );
    response.status(409);
    response.body().has('$.code', 'IDEMPOTENCY_SECRETS_CONFLICT');
  });
});

flow('KAAB-7', { ...REQ, requires: ['funded', 'daytona'], routes: [CREATE] }, async (ctx) => {
  const project = await ctx.fixtures.sharedSeededProject();
  const key = ctx.fixtures.name('kaab-context-idempotency');

  await ctx.step('first runtime context claims the idempotency key', async () => {
    const response = await ctx.client.as(ctx.P.PAT_ACCT).post(
      '/v1/projects/:projectId/sessions',
      { runtime_context: { ticket_id: 'ticket-123' } },
      {
        params: { projectId: project.id },
        headers: { 'Idempotency-Key': key },
      },
    );
    response.status(201);
    const sessionId = response.json<{ session_id?: string }>()?.session_id;
    if (sessionId) ctx.track('session', sessionId, { projectId: project.id });
  });
  await ctx.step('changed runtime context conflicts with the idempotency key', async () => {
    const response = await ctx.client.as(ctx.P.PAT_ACCT).post(
      '/v1/projects/:projectId/sessions',
      { runtime_context: { ticket_id: 'ticket-456' } },
      {
        params: { projectId: project.id },
        headers: { 'Idempotency-Key': key },
      },
    );
    response.status(409);
    response.body().has('$.code', 'IDEMPOTENCY_CONTEXT_CONFLICT');
  });
  await ctx.step('oversized idempotency key is rejected', async () => {
    const response = await ctx.client.as(ctx.P.PAT_ACCT).post(
      '/v1/projects/:projectId/sessions',
      {},
      {
        params: { projectId: project.id },
        headers: { 'Idempotency-Key': 'x'.repeat(300) },
      },
    );
    response.status(400);
    response.body().has('$.code', 'INVALID_IDEMPOTENCY_KEY');
  });
});
