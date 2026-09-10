import { flow } from '../core/flow';

flow(
  'SESS-32',
  {
    domain: 'sessions',
    routes: [
      'POST /v1/projects/:projectId/sessions/:sessionId/agent-state',
      'POST /v1/projects/:projectId/sessions/:sessionId/log',
      'GET /v1/projects/:projectId/sessions/:sessionId/log',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'DELETE /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const session = await ctx.fixtures.session(project);
    const sibling = await ctx.fixtures.session(project);
    const other = await ctx.fixtures.project();
    const params = { projectId: project.id, sessionId: session.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    const route = '/v1/projects/:projectId/sessions/:sessionId/agent-state';
    const logRoute = '/v1/projects/:projectId/sessions/:sessionId/log';
    const sessionRoute = '/v1/projects/:projectId/sessions/:sessionId';
    const stream = 'kortix.pi.agent-state.v1';
    const value = (revision: number, schemaVersion = 1, count = revision) => ({
      kind: 'journal',
      stream,
      _kortixAppendId: crypto.randomUUID(),
      record: { namespace: 'counter', revision, schemaVersion, value: { count } },
    });
    const options = (item: ReturnType<typeof value>) => ({
      params,
      headers: { 'idempotency-key': item._kortixAppendId },
    });
    const read = async () => {
      const response = await owner.get(logRoute, { params });
      response.status(200);
      return response.json<any[]>().filter((item) => item.stream === stream);
    };
    const before = await owner.get(sessionRoute, { params });
    before.status(200);
    const originalStatus = before.json<any>().status;

    await ctx.step(
      'write revision one and repeat its idempotency key → one committed state record',
      async () => {
        const initial = value(1);
        (await owner.post(route, initial, options(initial))).status(204);
        (await owner.post(route, initial, options(initial))).status(204);
        const rows = await read();
        if (rows.length !== 1 || rows[0].record.value.count !== 1)
          throw new Error('initial state was not committed exactly once');
        (
          await owner.post(
            route,
            { ...initial, record: { ...initial.record, value: { count: 99 } } },
            options(initial),
          )
        ).status(409);
      },
    );
    await ctx.step(
      'two concurrent writes from revision one → one succeeds and one conflicts',
      async () => {
        const writes = [value(2, 1, 10), value(2, 1, 20)];
        const responses = await Promise.all(
          writes.map((item) => owner.post(route, item, options(item))),
        );
        const statuses = responses.map((response) => response.statusCode).sort();
        if (statuses.join(',') !== '204,409')
          throw new Error(`concurrent state writes returned ${statuses}`);
        responses
          .find((response) => response.statusCode === 409)!
          .body()
          .has('$.code', 'PI_STATE_CONFLICT');
        const rows = await read();
        if (
          rows.length !== 2 ||
          rows[1].record.revision !== 2 ||
          ![10, 20].includes(rows[1].record.value.count)
        )
          throw new Error('concurrent writes lost or duplicated state');
      },
    );
    await ctx.step('migrate to schema two, reject downgrade and preserve exact state', async () => {
      const upgraded = value(3, 2, 30);
      (await owner.post(route, upgraded, options(upgraded))).status(204);
      const downgrade = value(4, 1, 40);
      (await owner.post(route, downgrade, options(downgrade))).status(409);
      const rows = await read();
      if (
        rows.length !== 3 ||
        rows[2].record.schemaVersion !== 2 ||
        rows[2].record.value.count !== 30
      )
        throw new Error('schema downgrade changed durable state');
    });
    await ctx.step('generic log endpoint cannot bypass conditional state writes', async () => {
      const item = value(4, 2);
      (await owner.post(logRoute, item, options(item))).status(400);
    });
    await ctx.step(
      'missing key, invalid namespace and oversized value fail without changing state',
      async () => {
        const item = value(4, 2);
        (await owner.post(route, item, { params })).status(400);
        (
          await owner.post(
            route,
            { ...item, record: { ...item.record, namespace: '../other' } },
            options(item),
          )
        ).status(400);
        (
          await owner.post(
            route,
            { ...item, record: { ...item.record, value: 'x'.repeat(65537) } },
            options(item),
          )
        ).status(413);
        if ((await read()).length !== 3) throw new Error('invalid input changed state');
      },
    );
    await ctx.step(
      'sibling sessions remain empty and project mismatch cannot read or write state',
      async () => {
        const response = await owner.get(logRoute, {
          params: { ...params, sessionId: sibling.id },
        });
        response.status(200);
        if (response.json<any[]>().some((item) => item.stream === stream))
          throw new Error('state leaked to sibling session');
        const item = value(4, 2);
        (
          await owner.post(route, item, {
            ...options(item),
            params: { ...params, projectId: other.id },
          })
        ).status(404);
        (await owner.get(logRoute, { params: { ...params, projectId: other.id } })).status(404);
      },
    );
    await ctx.step('anonymous and nonmember callers cannot read or write state', async () => {
      for (const [principal, statuses] of [
        [ctx.P.ANON, [401]],
        [ctx.P.NONMEMBER, [403, 404]],
      ] as const) {
        const item = value(4, 2);
        (await ctx.client.as(principal).post(route, item, options(item))).status([...statuses]);
        (await ctx.client.as(principal).get(logRoute, { params })).status([...statuses]);
      }
    });
    await ctx.step(
      'state operations preserve compute status; deleting the session revokes state access',
      async () => {
        (await owner.get(sessionRoute, { params }))
          .status(200)
          .body()
          .has('$.status', originalStatus);
        (await owner.request('DELETE', sessionRoute, { params })).status(200);
        const item = value(4, 2);
        (await owner.post(route, item, options(item))).status(404);
        (await owner.get(logRoute, { params })).status(404);
      },
    );
  },
);
