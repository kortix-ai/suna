import { flow } from '../core/flow';

flow('SESS-33', {
  domain: 'sessions',
  routes: [
    'POST /v1/projects/:projectId/sessions/:sessionId/log',
    'GET /v1/projects/:projectId/sessions/:sessionId/log',
    'GET /v1/projects/:projectId/sessions/:sessionId',
  ],
}, async ctx => {
  const project = await ctx.fixtures.project();
  const session = await ctx.fixtures.session(project);
  const params = { projectId: project.id, sessionId: session.id };
  const owner = ctx.client.as(ctx.P.OWNER);
  const route = '/v1/projects/:projectId/sessions/:sessionId/log';
  const sessionRoute = '/v1/projects/:projectId/sessions/:sessionId';
  const initial = await owner.get(sessionRoute, { params });
  initial.status(200);
  const initialStatus = initial.json<any>().status;
  const stream = 'kortix.pi.turn-admission.v1';
  const identified = (item: Record<string, unknown>) => ({ ...item, _kortixAppendId: crypto.randomUUID() });
  const accepted = (messageId: string, historyRevision?: number) => identified({
    kind: 'journal', stream,
    record: { type: 'accepted', turn: { messageId }, ...(historyRevision === undefined ? {} : { historyRevision }) },
  });
  const completed = (messageId: string) => identified({ kind: 'journal', stream, record: { type: 'completed', messageId } });
  const stage = (revision: number, messageId = 'u1') => identified({
    kind: 'history', version: 1, revision, action: 'stage', messageId,
    fromLeaf: 'e2', toLeaf: null, hiddenMessageIds: [messageId],
  });
  const restore = (revision: number) => identified({ kind: 'history', version: 1, revision, action: 'restore' });
  const options = (item: ReturnType<typeof identified>) => ({ params, headers: { 'idempotency-key': item._kortixAppendId } });
  const append = (item: ReturnType<typeof identified>) => owner.post(route, item, options(item));
  const read = async () => {
    const response = await owner.get(route, { params });
    response.status(200);
    return response.json<Array<Record<string, any>>>();
  };

  await ctx.step('accept a prompt and reject rewind until its durable completion', async () => {
    (await append(accepted('u1', 0))).status(204);
    (await append(stage(1))).status(409).body().has('$.error', 'history has an unfinished turn');
    (await append(completed('u1'))).status(204);
  });
  await ctx.step('stage and restore history; identical retries append each transition once', async () => {
    const staged = stage(1);
    (await append(staged)).status(204);
    (await append(staged)).status(204);
    (await append({ ...staged, toLeaf: 'different' })).status(409);
    const restored = restore(2);
    (await append(restored)).status(204);
    (await append(restored)).status(204);
    const records = await read();
    if (records.length !== 4 || records[2]._kortixAppendId !== staged._kortixAppendId || records[3]._kortixAppendId !== restored._kortixAppendId) {
      throw new Error('history transitions did not persist exactly once in append order');
    }
  });
  await ctx.step('new prompt commits the rewind and prevents restore of the discarded branch', async () => {
    (await append(stage(3))).status(204);
    (await append(accepted('u2', 3))).status(409).body().has('$.error', 'history revision changed');
    (await append(accepted('u2', 4))).status(204);
    (await append(completed('u2'))).status(204);
    (await append(restore(5))).status(409).body().has('$.error', 'nothing to restore');
  });
  await ctx.step('old workers and invalid history requests cannot change a rewound log', async () => {
    const before = await read();
    (await append(accepted('legacy'))).status(409);
    const staged = stage(5, 'u2');
    (await owner.post(route, staged, { params })).status(400);
    (await append({ ...staged, version: 2 })).status(400);
    (await append({ ...staged, hiddenMessageIds: ['wrong'] })).status(400);
    if (JSON.stringify(await read()) !== JSON.stringify(before)) throw new Error('rejected history request changed the log');
  });
  await ctx.step('concurrent rewind and prompt at one revision commit exactly one winner', async () => {
    const writes = [stage(5, 'u2'), accepted('u3', 5)];
    const responses = await Promise.all(writes.map(append));
    if (responses.map(response => response.statusCode).sort().join(',') !== '204,409') {
      throw new Error(`history race returned ${responses.map(response => response.statusCode)}`);
    }
    const winner = writes[responses.findIndex(response => response.statusCode === 204)];
    const rows = await read();
    if (rows.filter(row => writes.some(write => write._kortixAppendId === row._kortixAppendId)).length !== 1 || rows.at(-1)?._kortixAppendId !== winner._kortixAppendId) {
      throw new Error('history race did not persist exactly the acknowledged winner');
    }
    (await append(winner)).status(204);
  });
  await ctx.step('history appends preserve compute status and reject callers without session access', async () => {
    (await owner.get(sessionRoute, { params })).status(200).body().has('$.status', initialStatus);
    const item = restore(6);
    for (const [principal, statuses] of [[ctx.P.ANON, [401]], [ctx.P.NONMEMBER, [403, 404]]] as const) {
      (await ctx.client.as(principal).post(route, item, options(item))).status([...statuses]);
    }
  });
});
