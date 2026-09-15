import { flow } from '../core/flow';
import { createHash } from 'node:crypto';

flow('SESS-33', {
  domain: 'sessions',
  requires: ['database'],
  routes: [
    'POST /v1/projects/:projectId/sessions/:sessionId/log',
    'GET /v1/projects/:projectId/sessions/:sessionId/log',
    'GET /v1/projects/:projectId/sessions/:sessionId',
    'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    'PUT /v1/projects/:projectId/sessions/:sessionId/attachments/:sha256',
    'GET /v1/projects/:projectId/sessions/:sessionId/attachments/:sha256',
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
  const connectDatabase = async () => {
    if (!ctx.env.databaseUrl || ctx.env.target === 'prod') throw new Error('mirror fixtures require a non-production database');
    const { Client } = await import('pg');
    const local = /localhost|127\.0\.0\.1/.test(ctx.env.databaseUrl);
    const client = new Client({ connectionString: ctx.env.databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
    await client.connect();
    return client;
  };
  const seedMirror = async (ids: string[]) => {
    const client = await connectDatabase();
    try {
      await client.query(`INSERT INTO kortix.session_transcript_mirrors (session_id,project_id,account_id,opencode_session_id,head_complete)
        SELECT session_id,project_id,account_id,'ses_history',true FROM kortix.project_sessions WHERE session_id=$1
        ON CONFLICT (session_id) DO NOTHING`, [session.id]);
      for (const id of ids) {
        const role = id.startsWith('u') ? 'user' : 'assistant';
        const time = Number(id.slice(1)) * 2 + (role === 'assistant' ? 1 : 0);
        await client.query(`INSERT INTO kortix.session_transcript_messages (session_id,message_id,opencode_session_id,role,message_created_at,info,parts)
          VALUES ($1,$2,'ses_history',$3,to_timestamp($4),$5::jsonb,$6::jsonb)`, [session.id,id,role,time,JSON.stringify({ id,role,time:{created:time*1000,completed:time*1000} }),JSON.stringify([{ id:'part-'+id,type:'text',text:id }])]);
      }
    } finally { await client.end(); }
  };
  const mirror = async (ids: string[], limit = 80) => {
    const response = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', { params, query: { shape: 'sync', limit: String(limit) } });
    response.status(200).body().has('$.available', true).has('$.message_count', Math.min(ids.length, limit)).has('$.complete', ids.length <= limit);
    const actual = response.json<any>().messages.map((message: any) => message.info.id);
    if (JSON.stringify(actual) !== JSON.stringify(ids.slice(-limit))) throw new Error(`mirror contains ${actual}, expected ${ids.slice(-limit)}`);
  };
  await ctx.step('a captured transcript without Pi history controls keeps every message visible', async () => {
    await seedMirror(['u0', 'a0', 'u1', 'a1']);
    await mirror(['u0', 'a0', 'u1', 'a1']);
  });
  await ctx.step('a stopped transcript preserves its immutable file reference and the API returns the exact bytes without starting compute', async () => {
    const content = `history-attachment-${crypto.randomUUID()}`;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const attachmentRoute = '/v1/projects/:projectId/sessions/:sessionId/attachments/:sha256';
    const attachmentParams = { ...params, sha256 };
    const url = `/projects/${project.id}/sessions/${session.id}/attachments/${sha256}`;
    (await owner.put(attachmentRoute, content, { params: attachmentParams, raw: true, headers: { 'content-type': 'text/plain' } })).status(204);
    const before = (await owner.get(sessionRoute, { params })).status(200).json<any>();
    const client = await connectDatabase();
    try {
      await client.query(`UPDATE kortix.session_transcript_messages SET parts=parts || $2::jsonb WHERE session_id=$1 AND message_id='u0'`, [session.id, JSON.stringify([{ id: 'history-file', type: 'file', mime: 'text/plain', filename: 'note.txt', url }])]);
    } finally { await client.end(); }
    const response = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', { params, query: { shape: 'sync' } });
    response.status(200).body().has('$.source', 'mirror');
    const file = response.json<any>().messages.flatMap((message: any) => message.parts).find((part: any) => part.id === 'history-file');
    if (file?.url !== url) throw new Error('mirror lost the immutable attachment reference');
    const bytes = await owner.get(attachmentRoute, { params: attachmentParams });
    bytes.status(200);
    if (bytes.text() !== content) throw new Error('historical attachment bytes changed');
    (await owner.get(sessionRoute, { params })).status(200).body().has('$.status', before.status);
  });
  const identified = (item: Record<string, unknown>): Record<string, unknown> & { _kortixAppendId: string } => ({ ...item, _kortixAppendId: crypto.randomUUID() });
  const accepted = (messageId: string, historyRevision?: number) => identified({
    kind: 'journal', stream,
    record: { type: 'accepted', turn: { messageId }, ...(historyRevision === undefined ? {} : { historyRevision }) },
  });
  const completed = (messageId: string) => identified({ kind: 'journal', stream, record: { type: 'completed', messageId } });
  const stage = (revision: number, messageId = 'u1') => identified({
    kind: 'history', version: 1, revision, action: 'stage', messageId,
    fromLeaf: 'e2', toLeaf: null, hiddenMessageIds: [messageId, 'a' + messageId.slice(1)],
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
    await mirror(['u0', 'a0']);
    await mirror(['u0', 'a0'], 1);
    (await append({ ...staged, toLeaf: 'different' })).status(409);
    const restored = restore(2);
    (await append(restored)).status(204);
    (await append(restored)).status(204);
    await mirror(['u0', 'a0', 'u1', 'a1']);
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
    await seedMirror(['u2', 'a2']);
    await mirror(['u0', 'a0', 'u2', 'a2']);
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
  let promptWon = false;
  await ctx.step('concurrent rewind and prompt at one revision commit exactly one winner', async () => {
    const writes = [stage(5, 'u2'), accepted('u3', 5)];
    const responses = await Promise.all(writes.map(append));
    if (responses.map(response => response.statusCode).sort().join(',') !== '204,409') {
      throw new Error(`history race returned ${responses.map(response => response.statusCode)}`);
    }
    const winner = writes[responses.findIndex(response => response.statusCode === 204)];
    promptWon = winner.kind === 'journal';
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
  await ctx.step('rewind all visible mirror rows returns a known empty transcript; restore keeps committed rows hidden', async () => {
    if (promptWon) (await append(completed('u3'))).status(204);
    (await append({ ...stage(6, 'u0'), fromLeaf: promptWon ? 'e2' : null, hiddenMessageIds: ['u0', 'a0', 'u2', 'a2'] })).status(204);
    await mirror([]);
    (await append(restore(7))).status(204);
    await mirror(['u0', 'a0', 'u2', 'a2']);
  });
  await ctx.step('prepare fences prompts without hiding messages, cancel releases it, and commit changes visibility once', async () => {
    const operationId = crypto.randomUUID();
    const selection = { ...stage(8, 'u2') };
    delete (selection as any)._kortixAppendId;
    const prepared = identified({ kind: 'history', version: 1, revision: 8, action: 'prepare', operationId, selection, workspace: null });
    (await append(prepared)).status(204);
    (await append(prepared)).status(204);
    await mirror(['u0', 'a0', 'u2', 'a2']);
    (await append(accepted('fenced', 9))).status(409).body().has('$.error', 'history recovery is pending');
    (await append(identified({ kind: 'history', version: 1, revision: 9, action: 'commit', operationId: crypto.randomUUID() }))).status(409);
    (await append(identified({ kind: 'history', version: 1, revision: 9, action: 'cancel', operationId }))).status(204);
    await mirror(['u0', 'a0', 'u2', 'a2']);
    const second = crypto.randomUUID();
    (await append(identified({ ...prepared, revision: 10, operationId: second, selection: { ...selection, revision: 10 } }))).status(204);
    const committed = identified({ kind: 'history', version: 1, revision: 11, action: 'commit', operationId: second });
    (await append(committed)).status(204);
    (await append(committed)).status(204);
    await mirror(['u0', 'a0']);
    const undoId = crypto.randomUUID();
    (await append(identified({ kind: 'history', version: 1, revision: 12, action: 'prepare', operationId: undoId, selection: { kind: 'history', version: 1, revision: 12, action: 'restore' }, workspace: null }))).status(204);
    (await append(identified({ kind: 'history', version: 1, revision: 13, action: 'commit', operationId: undoId }))).status(204);
    await mirror(['u0', 'a0', 'u2', 'a2']);
  });
});
