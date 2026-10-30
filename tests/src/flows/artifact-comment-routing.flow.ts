import { randomUUID } from 'node:crypto';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import { AgentPrincipalsWorld, type AgentSession } from '../fixtures/agent-principals';
import { createDatabaseSession } from '../fixtures/database-project';

const ARTIFACTS = '/v1/projects/:projectId/artifacts';
const ONE = `${ARTIFACTS}/:artifactId`;
const COMMENTS = `${ONE}/comments`;
const REPLIES = `${COMMENTS}/:threadId/replies`;
const COMMENT = `${COMMENTS}/:threadId/:commentId`;
const SEND = `${COMMENTS}/send`;
const FEATURES = '/v1/projects/:projectId/features';
type Mention = { kind: 'user'; user_id: string } | { kind: 'session'; session_id: string; agent_name: string } | { kind: 'agent'; agent_name: string };
type Comment = { comment_id: string; body: string; mentions: Mention[] };
type Thread = { thread_id: string; agent_state: string; sent_session_id: string | null; comments: Comment[] };
type Artifact = { artifact_id: string; title: string; path: string; entry_version: string };
type Command = { command_id: string; command_type: string; status: string; session_id: string | null; actor_user_id: string | null; idempotency_key: string; payload: Record<string, any> };
type Notice = { notification_id: string; user_id: string; actor_user_id: string | null; email_due_at: Date | null; created_at: Date };
const AGENTS = [
  'project:', '  name: artifact-routing', 'default_agent: writer', 'agents:',
  '  writer:', '    kortix_permissions: [project.session.read, project.session.start, project.artifact.read, project.artifact.write, project.artifact.comment]',
  '  critic:', '    kortix_permissions: [project.session.read, project.session.start, project.artifact.comment]',
  '  researcher:', '    kortix_permissions: [project.session.read, project.artifact.comment]',
  '  reader:', '    kortix_permissions: [project.session.read, project.session.start, project.artifact.read]', '',
].join('\n');

flow('ART-7', {
  domain: 'artifacts', requires: ['database', 'sandbox'], timeoutMs: 180_000,
  routes: [
    `PATCH ${FEATURES}`, `POST ${ARTIFACTS}`, `GET ${ONE}`, `PUT ${ONE}`, `PATCH ${ONE}`, `DELETE ${ONE}`,
    `GET ${COMMENTS}`, `POST ${COMMENTS}`, `POST ${REPLIES}`, `PATCH ${COMMENT}`, `POST ${SEND}`, `GET ${ONE}/activity`,
    'GET /v1/drives', 'GET /v1/notifications', 'GET /v1/notifications/preferences',
  ],
}, async (ctx) => {
  const providerBase = process.env.PLATINUM_API_URL?.replace(/\/+$/, '');
  const providerKey = process.env.PLATINUM_API_KEY;
  if (!providerBase || !providerKey || providerKey.startsWith('encrypted:')) throw new Error('ART-7 needs decrypted Files credentials and a workers-disabled API');
  const team = await ctx.fixtures.team({ enterprise: true });
  const project = await team.project({ managedGit: true });
  const other = await team.project();
  const member = await team.addMember('member');
  const mentioned = await team.addMember('member');
  for (const person of [member, mentioned]) await team.grantProjectRole(project.id, person.userId!, 'member');
  const owner = ctx.client.as(ctx.P.OWNER);
  const asMember = ctx.client.as(member);
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  const pp = { projectId: project.id };
  const ap = (artifact: Artifact) => ({ ...pp, artifactId: artifact.artifact_id });
  const tp = (artifact: Artifact, thread: Thread) => ({ ...ap(artifact), threadId: thread.thread_id });
  const key = (thread: Thread, comment = thread.comments[0]!) => `artifact-comments:${thread.thread_id}:${comment.comment_id}`;
  const provider = (method: string, path: string) => fetch(`${providerBase}${path}`, { method, headers: { Authorization: `Bearer ${providerKey}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  let humanDoc: Artifact;
  let agentDoc: Artifact;
  let privateDoc: Artifact;
  let digestDoc: Artifact;
  let writer: AgentSession;
  let critic: AgentSession;
  let reader: AgentSession;
  let volumeName = '';
  let emailAvailable = false;
  const allArtifacts: Artifact[] = [];
  const ownedKeys = new Set<string>();

  const commands = async (prefix?: string) => {
    if (prefix) ownedKeys.add(prefix);
    return (await world.db.query<Command>(
    `SELECT command_id, command_type, status, session_id, actor_user_id, idempotency_key, payload
     FROM kortix.session_lifecycle_commands WHERE project_id = $1
       AND ($2::text IS NULL OR idempotency_key = $2 OR idempotency_key LIKE $2 || ':%') ORDER BY created_at, command_id`,
    [project.id, prefix ?? null],
    )).rows;
  };
  const waitCommands = (prefix: string, count = 1) => waitFor(() => commands(prefix), { until: (rows) => rows.length === count, timeoutMs: 15_000, intervalMs: 100, description: `${count} queued Artifact command(s)` });
  const deliveryDone = (jobKey: string) => waitFor(async () => (await world.db.query<{ queue: string; status: string }>(
    'SELECT queue, status FROM kortix.job_queue WHERE job_key = $1', [jobKey],
  )).rows, { until: (rows) => rows.some((row) => row.queue === 'artifact-comment-people') && rows.every((row) => row.status === 'done'), timeoutMs: 15_000, intervalMs: 100, description: 'the owned comment outbox delivery' });
  const list = async (artifact: Artifact) => (await owner.get(COMMENTS, { params: ap(artifact), query: { status: 'all' } })).status(200).json<{ threads: Thread[] }>().threads;
  const currentThread = async (artifact: Artifact, thread: Thread) => {
    const found = (await list(artifact)).find((row) => row.thread_id === thread.thread_id);
    if (!found) throw new Error('The expected Artifact thread is missing');
    return found;
  };
  const noticeRows = async (jobKey: string) => (await world.db.query<Notice>(
    `SELECT notification_id, user_id, actor_user_id, email_due_at, created_at FROM kortix.notifications
     WHERE project_id = $1 AND kind = 'artifact_comment' AND dedupe_key = $2 ORDER BY user_id`, [project.id, jobKey],
  )).rows;
  const expectNotices = async (jobKey: string, people: string[]) => {
    await deliveryDone(jobKey);
    const rows = await noticeRows(jobKey);
    if (rows.map((row) => row.user_id).sort().join(',') !== [...people].sort().join(',')) throw new Error(`Artifact comment notification recipients differ: ${rows.length}, expected ${people.length}`);
    for (const row of rows) {
      if (emailAvailable ? !row.email_due_at || Math.abs(row.email_due_at.getTime() - row.created_at.getTime() - 15 * 60_000) > 60_000 : row.email_due_at !== null) throw new Error('Artifact comment digest scheduling does not match public email availability');
    }
    return rows;
  };
  const assertPrompt = (text: unknown, artifact: Artifact, threads: Thread[], words: string[]) => {
    if (typeof text !== 'string') throw new Error('The queued Artifact delivery has no text prompt');
    for (const value of [artifact.artifact_id, artifact.title, artifact.path, artifact.entry_version, '--base-version', ...words]) if (!text.includes(value)) throw new Error(`Artifact prompt is missing ${value}`);
    for (const thread of threads) for (const command of [`kortix artifacts reply ${thread.thread_id}`, `kortix artifacts resolve ${thread.thread_id}`]) if (!text.includes(command)) throw new Error(`Artifact prompt is missing ${command}`);
  };

  try {
    await ctx.step('enable only Artifact inbox flags and publish real Files; controlled sessions have no runtime', async () => {
      const missing = { ...pp, artifactId: randomUUID() };
      const body = { thread_ids: [randomUUID()], batch_id: randomUUID() };
      (await ctx.client.as(ctx.P.ANON).post(SEND, body, { params: missing })).status(401);
      (await owner.post(SEND, body, { params: missing })).status(403).body().has('$.code', 'feature_disabled');
      for (const projectId of [project.id, other.id]) for (const feature of ['artifacts', 'artifact_comments']) (await owner.patch(FEATURES, { feature, enabled: true }, { params: { projectId } })).status(200);
      (await owner.patch(FEATURES, { feature: 'notification_center', enabled: false }, { params: pp })).status(200).body().has('$.experimental.notification_center', false);
      humanDoc = (await owner.post(ARTIFACTS, { files: { 'index.md': { content: '# People review\n\nConfirm the signed source.\n' } }, visibility: 'project' }, { params: pp })).status(201).json<Artifact>();
      allArtifacts.push(humanDoc);
      const drives = (await owner.get('/v1/drives', { query: pp })).status(200).json<{ drives: { driveId: string }[] }>().drives;
      if (drives.length !== 1) throw new Error('The owned routing project has more than one drive');
      volumeName = `kd-${drives[0]!.driveId.replace(/-/g, '').slice(0, 20)}`;
      if ((await provider('GET', `/v1/volumes/${volumeName}`)).status !== 200) throw new Error('The owned routing Files volume is absent');
      privateDoc = (await owner.post(ARTIFACTS, { files: { 'index.md': { content: '# Private review\n' } } }, { params: pp })).status(201).json<Artifact>();
      allArtifacts.push(privateDoc);
      (await owner.patch(ONE, { shared_with_user_ids: [mentioned.userId] }, { params: ap(privateDoc) })).status(200);
      await world.writeManifest(AGENTS, 'ke2e: Artifact comment routing agents');
      writer = await world.mintAgentSession({ agent: 'writer', launcher: ctx.P.OWNER, visibility: 'private', metadata: { name: 'Artifact writer' } });
      critic = await world.mintAgentSession({ agent: 'critic', launcher: ctx.P.OWNER, visibility: 'private' });
      reader = await world.mintAgentSession({ agent: 'reader', launcher: ctx.P.OWNER, visibility: 'private' });
      for (const agent of ['writer', 'researcher']) await world.grantRun(agent, member);
      for (const title of ['Agent routing', 'Running digest']) {
        const artifact = (await writer.client.post(ARTIFACTS, { files: { 'index.md': { content: `# ${title}\n\nQueue the review.\n` } }, visibility: 'project' }, { params: pp })).status(201).json<Artifact>();
        allArtifacts.push(artifact);
        if (title === 'Agent routing') agentDoc = artifact;
        else digestDoc = artifact;
      }
      const preferences = (await owner.get('/v1/notifications/preferences')).status(200).json<{ kinds: Record<string, { push: boolean; email: boolean }>; email_available: boolean }>();
      if (!preferences.kinds.artifact_comment?.push || !preferences.kinds.artifact_comment.email) throw new Error('Artifact comments are absent from default push/email preferences');
      emailAvailable = preferences.email_available;
    });

    await ctx.step('a member mention notifies the creator and mentioned person; replies notify participants but never the person author', async () => {
      const opened = (await asMember.post(COMMENTS, { body: `Confirm the source, @${mentioned.userId}.`, anchor: { type: 'none', version: humanDoc.entry_version } }, { params: ap(humanDoc) })).status(201).json<{ thread: Thread }>().thread;
      if (!opened.comments[0]!.mentions.some((mention) => mention.kind === 'user' && mention.user_id === mentioned.userId)) throw new Error('The resolved member mention was not stored');
      const notices = await expectNotices(key(opened), [ctx.P.OWNER.userId!, mentioned.userId!]);
      const inbox = (await ctx.client.as(mentioned).get('/v1/notifications')).status(200).json<{ notifications: { id: string; kind: string; artifact_id: string | null; artifact_thread_id: string | null; url: string }[] }>();
      const row = inbox.notifications.find((item) => item.id === notices.find((notice) => notice.user_id === mentioned.userId)!.notification_id);
      if (row?.kind !== 'artifact_comment' || row.artifact_id !== humanDoc.artifact_id || row.artifact_thread_id !== opened.thread_id || row.url !== `/projects/${project.id}/artifacts/${humanDoc.artifact_id}?thread=${opened.thread_id}&notification=${row.id}`) throw new Error('The Artifact bell row is hidden or links to the wrong thread while notification_center is off');
      const reply = (await owner.post(REPLIES, { body: `Please check it, @${mentioned.userId}.` }, { params: tp(humanDoc, opened) })).status(201).json<{ comment: Comment }>().comment;
      await expectNotices(key(opened, reply), [member.userId!, mentioned.userId!]);
      const confirmed = (await ctx.client.as(mentioned).post(REPLIES, { body: 'The signed source is correct.' }, { params: tp(humanDoc, opened) })).status(201).json<{ comment: Comment }>().comment;
      await expectNotices(key(opened, confirmed), [ctx.P.OWNER.userId!, member.userId!]);
      const broadcast = (await asMember.post(COMMENTS, { body: '@all @here Review this broadcast.', anchor: { type: 'none', version: humanDoc.entry_version } }, { params: ap(humanDoc) })).status(201).json<{ thread: Thread }>().thread;
      await expectNotices(key(broadcast), [ctx.P.OWNER.userId!, mentioned.userId!]);
      if (broadcast.comments[0]!.mentions.some((mention) => mention.kind !== 'user')) throw new Error('A people broadcast resolved an agent mention');
      if ((await commands()).length !== 0) throw new Error('A people-only discussion started an agent turn');
    });

    await ctx.step('Artifact inbox flags do not reveal legacy turn notifications; a person who lost Artifact view receives no row', async () => {
      const visibleSession = await createDatabaseSession(ctx.env, { accountId: team.id, projectId: project.id, userId: ctx.P.OWNER.userId!, visibility: 'project' });
      ctx.track('session', visibleSession, { projectId: project.id });
      const seeded = (await world.db.query<{ notification_id: string }>(
        `INSERT INTO kortix.notifications (user_id, account_id, project_id, session_id, kind, title, body)
         VALUES ($1,$2,$3,$4,'turn_done','Synthetic turn finished','') RETURNING notification_id`, [mentioned.userId, team.id, project.id, visibleSession],
      )).rows[0]!.notification_id;
      const inbox = (await ctx.client.as(mentioned).get('/v1/notifications')).status(200).json<{ notifications: { id: string }[] }>();
      if (inbox.notifications.some((row) => row.id === seeded)) throw new Error('Artifact flags enabled a legacy turn notification');
      (await ctx.client.as(mentioned).get(ONE, { params: ap(privateDoc) })).status(200);
      (await owner.patch(ONE, { shared_with_user_ids: [] }, { params: ap(privateDoc) })).status(200);
      (await ctx.client.as(mentioned).get(ONE, { params: ap(privateDoc) })).status(404);
      const hidden = (await owner.post(COMMENTS, { body: `Private source, @${mentioned.userId}.`, anchor: { type: 'none', version: privateDoc.entry_version } }, { params: ap(privateDoc) })).status(201).json<{ thread: Thread }>().thread;
      await expectNotices(key(hidden), []);
    });

    await ctx.step('mentioning the Artifact session queues exactly one continue command with the current version and repair instructions', async () => {
      const anchoredVersion = agentDoc.entry_version;
      agentDoc = (await owner.put(ONE, { files: { 'index.md': { content: '# Agent routing\n\nQueue the review.\nA new source is confirmed.\n' } }, base_version: agentDoc.entry_version }, { params: ap(agentDoc) })).status(200).json<Artifact>();
      const opened = (await owner.post(COMMENTS, { body: '@writer Fix the signed source.', anchor: { type: 'text', version: anchoredVersion, quote: 'Queue the review.', prefix: '', suffix: '' } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread;
      if (!opened.comments[0]!.mentions.some((mention) => mention.kind === 'session' && mention.session_id === writer.sessionId)) throw new Error('The Artifact session mention was not resolved');
      const rows = await waitCommands(key(opened));
      const command = rows[0]!;
      if (command.command_type !== 'continue_session' || command.status !== 'queued' || command.session_id !== writer.sessionId || command.actor_user_id !== ctx.P.OWNER.userId || command.idempotency_key !== key(opened) || command.payload.delivery !== 'queue' || command.payload.placement !== 'composer') throw new Error('The session mention queued the wrong delivery');
      assertPrompt(command.payload.text, agentDoc, [opened], ['Queue the review.', 'Fix the signed source.']);
      const delivered = await waitFor(() => currentThread(agentDoc, opened), { until: (thread) => thread.agent_state === 'sent', timeoutMs: 15_000, intervalMs: 100, description: 'the existing-session thread becomes sent' });
      if (delivered.sent_session_id !== writer.sessionId || (await commands(key(opened))).length !== 1) throw new Error('The existing-session delivery duplicated or lost its target');
    });

    await ctx.step('Send batches two threads once; repeating or concurrently retrying one batch id queues only one command', async () => {
      const opened: Thread[] = [];
      for (const body of ['Fix the heading.', 'Fix the reference.']) opened.push((await owner.post(COMMENTS, { body, anchor: { type: 'none', version: agentDoc.entry_version } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread);
      for (const thread of opened) { await deliveryDone(key(thread)); if ((await commands(key(thread))).length) throw new Error('A plain new thread started a turn without Send'); }
      const batchId = randomUUID();
      const input = { thread_ids: opened.map((thread) => thread.thread_id), batch_id: batchId };
      const results = await Promise.all([owner.post(SEND, input, { params: ap(agentDoc) }), owner.post(SEND, input, { params: ap(agentDoc) })]);
      for (const response of results) response.status(200).body().has('$.session_id', writer.sessionId).has('$.created', false);
      (await owner.post(SEND, input, { params: ap(agentDoc) })).status(200).body().has('$.session_id', writer.sessionId).has('$.created', false);
      const rows = await waitCommands(`artifact-comments:batch:${batchId}`);
      if (rows.length !== 1 || rows[0]!.command_type !== 'continue_session' || rows[0]!.session_id !== writer.sessionId || rows[0]!.status !== 'queued') throw new Error('Send batch was not idempotent');
      assertPrompt(rows[0]!.payload.text, agentDoc, opened, ['Fix the heading.', 'Fix the reference.']);
      (await owner.post(SEND, { thread_ids: [], batch_id: randomUUID() }, { params: ap(agentDoc) })).status(400);
      (await owner.post(SEND, input, { params: ap(humanDoc) })).status(404);
      (await owner.post(SEND, input, { params: { projectId: other.id, artifactId: agentDoc.artifact_id } })).status(404);
      (await reader.client.post(SEND, { ...input, batch_id: randomUUID() }, { params: ap(agentDoc) })).status(403);
    });

    await ctx.step('a commenter without prompt rights reserves a new session as that person and creates no runtime', async () => {
      const opened = (await asMember.post(COMMENTS, { body: '@writer Review the member source.', anchor: { type: 'none', version: agentDoc.entry_version } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread;
      const rows = await waitCommands(key(opened));
      const command = rows[0]!;
      const reserved = command.payload.body?.session_id;
      if (command.command_type !== 'create_session' || command.status !== 'queued' || command.actor_user_id !== member.userId || command.payload.body?.agent_name !== 'writer'
        || typeof reserved !== 'string' || reserved === writer.sessionId || command.payload.inSession === true || command.payload.callerSessionId != null) throw new Error('Private-session fallback lost the commenter identity or reserved session');
      if (command.payload.body.initial_prompt !== undefined || command.payload.body.pending_prompt?.agent !== 'writer') throw new Error('The reserved session bypasses pending-prompt authority checks');
      assertPrompt(command.payload.body.pending_prompt?.text, agentDoc, [opened], ['Review the member source.']);
      const linked = await currentThread(agentDoc, opened);
      if (linked.agent_state !== 'pending' || linked.sent_session_id !== reserved) throw new Error('The fallback thread is not linked to its pending session');
      const created = (await world.db.query<{ n: number }>('SELECT count(*)::int AS n FROM kortix.project_sessions WHERE session_id = $1', [reserved])).rows[0]!.n;
      if (created !== 0) throw new Error('A workers-disabled routing request provisioned the reserved session');
      const manual = (await asMember.post(COMMENTS, { body: 'Review the member batch.', anchor: { type: 'none', version: digestDoc.entry_version } }, { params: ap(digestDoc) })).status(201).json<{ thread: Thread }>().thread;
      const batchId = randomUUID();
      const body = { thread_ids: [manual.thread_id], batch_id: batchId };
      const sent = (await asMember.post(SEND, body, { params: ap(digestDoc) })).status(200).json<{ session_id: string; created: boolean }>();
      if (!sent.created || sent.session_id === writer.sessionId) throw new Error('Send did not reserve a new session for the commenter');
      (await asMember.post(SEND, body, { params: ap(digestDoc) })).status(200).body().has('$.session_id', sent.session_id).has('$.created', true);
      const batch = (await waitCommands(`artifact-comments:batch:${batchId}`))[0]!;
      if (batch.command_type !== 'create_session' || batch.payload.body?.session_id !== sent.session_id || batch.actor_user_id !== member.userId) throw new Error('A retried new-session batch lost its reservation or commenter');
      assertPrompt(batch.payload.body.pending_prompt?.text, digestDoc, [manual], ['Review the member batch.']);
      const dependentId = randomUUID();
      const dependentKey = `artifact-comments:batch:${dependentId}`;
      (await asMember.post(SEND, { ...body, batch_id: dependentId }, { params: ap(digestDoc) })).status(200).body().has('$.session_id', sent.session_id).has('$.created', false);
      const dependent = (await world.db.query<{ payload: Record<string, any>; status: string }>('SELECT payload, status FROM kortix.job_queue WHERE queue = $1 AND job_key = $2', ['artifact-comment-agents', dependentKey])).rows[0];
      if (dependent?.status !== 'queued' || dependent.payload.targets?.[0]?.sessionId !== sent.session_id || dependent.payload.targets?.[0]?.createKey !== `artifact-comments:batch:${batchId}` || (await commands(dependentKey)).length !== 0) throw new Error('A pending reservation was duplicated or its dependent delivery was lost');
      const mixed = (await asMember.post(COMMENTS, { body: '@writer @researcher Review both sources.', anchor: { type: 'none', version: agentDoc.entry_version } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread;
      const fanout = await waitCommands(key(mixed));
      if (fanout[0]!.command_type !== 'create_session' || fanout[0]!.payload.body?.agent_name !== 'researcher') throw new Error('An earlier pending writer reservation blocked the later researcher target');
      const fanoutJob = (await world.db.query<{ payload: Record<string, any> }>('SELECT payload FROM kortix.job_queue WHERE queue = $1 AND job_key = $2', ['artifact-comment-agents', key(mixed)])).rows[0];
      if (fanoutJob?.payload.targets?.length !== 2 || fanoutJob.payload.targets[0]?.sessionId !== reserved || fanoutJob.payload.targets[0]?.createKey !== key(opened)) throw new Error('Mixed fanout did not retain the earlier pending reservation');
    });

    await ctx.step('removing an automatic mention stops later implicit replies; manual Send retains its agent context', async () => {
      const opened = (await owner.post(COMMENTS, { body: '@writer Review the removable route.', anchor: { type: 'none', version: agentDoc.entry_version } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread;
      await waitCommands(key(opened));
      (await owner.patch(COMMENT, { body: 'The automatic route was removed.' }, { params: { ...tp(agentDoc, opened), commentId: opened.comments[0]!.comment_id } })).status(200);
      const reply = (await owner.post(REPLIES, { body: 'Keep this discussion between people.' }, { params: tp(agentDoc, opened) })).status(201).json<{ comment: Comment }>().comment;
      await deliveryDone(key(opened, reply));
      if ((await commands(key(opened, reply))).length) throw new Error('An edited-away mention survived as an implicit agent target');
      const manual = (await owner.post(COMMENTS, { body: 'Keep the manual route.', anchor: { type: 'none', version: agentDoc.entry_version } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread;
      const batchId = randomUUID();
      (await owner.post(SEND, { thread_ids: [manual.thread_id], batch_id: batchId }, { params: ap(agentDoc) })).status(200).body().has('$.session_id', writer.sessionId);
      await waitCommands(`artifact-comments:batch:${batchId}`);
      const followup = (await owner.post(REPLIES, { body: 'Continue the manual review.' }, { params: tp(agentDoc, manual) })).status(201).json<{ comment: Comment }>().comment;
      const rows = await waitCommands(key(manual, followup));
      if (rows[0]!.session_id !== writer.sessionId || rows[0]!.command_type !== 'continue_session') throw new Error('Manual Send lost its unconditional agent context');
    });

    await ctx.step('five agent replies reach a project-visible session; the sixth pauses; the next person resets the loop', async () => {
      const visible = await world.db.query<{ visibility: string }>(
        "UPDATE kortix.project_sessions SET visibility = 'project' WHERE session_id = $1 AND project_id = $2 RETURNING visibility",
        [writer.sessionId, project.id],
      );
      if (visible.rows[0]?.visibility !== 'project') throw new Error('The controlled loop target is not project-visible');
      const opened = (await owner.post(COMMENTS, { body: '@writer Check this loop.', anchor: { type: 'none', version: agentDoc.entry_version } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread;
      await waitCommands(key(opened));
      for (let number = 1; number <= 5; number++) {
        const reply = (await critic.client.post(REPLIES, { body: `@writer Agent response ${number}.` }, { params: tp(agentDoc, opened) })).status(201).json<{ comment: Comment }>().comment;
        const rows = await waitCommands(key(opened, reply));
        if (rows[0]!.session_id !== writer.sessionId || rows[0]!.command_type !== 'continue_session') throw new Error('An allowed agent reply did not reach the existing target');
        if (number === 1) await expectNotices(key(opened, reply), [ctx.P.OWNER.userId!]);
      }
      const sixth = (await critic.client.post(REPLIES, { body: '@writer Agent response 6.' }, { params: tp(agentDoc, opened) })).status(201).json<{ comment: Comment }>().comment;
      await deliveryDone(key(opened, sixth));
      if ((await commands(key(opened, sixth))).length || (await currentThread(agentDoc, opened)).agent_state !== 'paused') throw new Error('The sixth agent reply was delivered or did not pause the thread');
      const person = (await owner.post(REPLIES, { body: '@writer Continue with the confirmed source.' }, { params: tp(agentDoc, opened) })).status(201).json<{ comment: Comment }>().comment;
      await waitCommands(key(opened, person));
      const again = (await critic.client.post(REPLIES, { body: '@writer The person confirmed it.' }, { params: tp(agentDoc, opened) })).status(201).json<{ comment: Comment }>().comment;
      await waitCommands(key(opened, again));
      if ((await currentThread(agentDoc, opened)).agent_state === 'paused') throw new Error('A person reply did not reset the agent loop');
    });

    await ctx.step('a running turn receives one queued digest containing all comments; no command interrupts or steers it', async () => {
      const token = randomUUID();
      await world.db.query(`UPDATE kortix.session_sandboxes SET status = 'active', metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('activeTurns', $2::jsonb) WHERE session_id = $1`, [writer.sessionId, JSON.stringify({ [token]: { token, state: 'active', runtimeSessionId: 'fixture-runtime', messageId: 'fixture-message', startedAtMs: Date.now() } })]);
      const before = (await commands()).length;
      const opened: Thread[] = [];
      for (const body of ['@writer Digest issue one.', '@writer Digest issue two.']) opened.push((await owner.post(COMMENTS, { body, anchor: { type: 'none', version: digestDoc.entry_version } }, { params: ap(digestDoc) })).status(201).json<{ thread: Thread }>().thread);
      const reply = (await owner.post(REPLIES, { body: 'Digest supporting reference.' }, { params: tp(digestDoc, opened[0]!) })).status(201).json<{ comment: Comment }>().comment;
      for (const thread of opened) await deliveryDone(key(thread));
      await deliveryDone(key(opened[0]!, reply));
      const after = await commands();
      if (after.length !== before + 1) throw new Error('A running turn received more than one Artifact digest');
      const digest = after.find((row) => typeof row.payload.text === 'string' && row.payload.text.includes('Digest issue one.'));
      if (!digest || digest.status !== 'queued' || digest.payload.delivery !== 'queue' || digest.payload.placement !== 'composer') throw new Error('The Artifact digest can steer or interrupt a running turn');
      assertPrompt(digest.payload.text, digestDoc, opened, ['Digest issue one.', 'Digest issue two.', 'Digest supporting reference.']);
      await world.db.query("UPDATE kortix.session_sandboxes SET metadata = metadata - 'activeTurns' WHERE session_id = $1", [writer.sessionId]);
    });

    await ctx.step('multiple explicit agent mentions retain every delivery target and an agent-created fallback keeps caller session context', async () => {
      const opened = (await owner.post(COMMENTS, { body: '@writer @researcher Compare both sources.', anchor: { type: 'none', version: agentDoc.entry_version } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread;
      const rows = await waitCommands(key(opened), 2);
      const continued = rows.find((row) => row.command_type === 'continue_session' && row.session_id === writer.sessionId);
      const created = rows.find((row) => row.command_type === 'create_session' && row.payload.body?.agent_name === 'researcher');
      if (!continued || !created || new Set(rows.map((row) => row.idempotency_key)).size !== 2) throw new Error('Automatic multi-agent delivery dropped or duplicated a target');
      if (!rows.some((row) => row.idempotency_key === key(opened)) || !rows.some((row) => row.idempotency_key.startsWith(`${key(opened)}:target:`))) throw new Error('Automatic delivery keys do not preserve the primary and secondary targets');
      const child = (await critic.client.post(COMMENTS, { body: '@researcher Check the agent source.', anchor: { type: 'none', version: agentDoc.entry_version } }, { params: ap(agentDoc) })).status(201).json<{ thread: Thread }>().thread;
      const childCommand = (await waitCommands(key(child)))[0]!;
      if (childCommand.command_type !== 'create_session' || childCommand.actor_user_id !== ctx.P.OWNER.userId || childCommand.payload.inSession !== true || childCommand.payload.callerSessionId !== critic.sessionId || childCommand.payload.body?.agent_name !== 'researcher') throw new Error('An agent-created fallback lost its caller context');
      if ((await commands()).some((row) => !['continue_session', 'create_session'].includes(row.command_type) || row.status !== 'queued')) throw new Error('The worker-disabled flow started a runtime or consumed a command');
    });
  } finally {
    try {
      if (!volumeName) {
        const drive = (await world.db.query<{ platinum_volume_name: string }>('SELECT platinum_volume_name FROM kortix.drives WHERE project_id = $1', [project.id])).rows[0];
        if (drive) volumeName = drive.platinum_volume_name;
      }
      if (allArtifacts.length) await ctx.step('unshare removes owned Artifact delivery jobs and every queued prompt', async () => {
        for (const artifact of allArtifacts) (await owner.del(ONE, { params: ap(artifact) })).status(200);
        const jobs = (await world.db.query<{ n: number }>("SELECT count(*)::int AS n FROM kortix.job_queue WHERE queue IN ('artifact-comment-people','artifact-comment-agents') AND job_key = ANY($1::text[])", [[...ownedKeys]])).rows[0]!.n;
        if ((await commands()).length || jobs !== 0) throw new Error('Unshare left an owned delivery job or queued Artifact prompt');
      });
    } finally {
      await world.close();
      if (volumeName) await ctx.step('delete the owned routing volume → 204; provider read-back → 404', async () => {
        const removed = await provider('DELETE', `/v1/volumes/${volumeName}?missing_ok=true`);
        if (removed.status !== 204) throw new Error(`Owned routing volume deletion returned ${removed.status}`);
        const gone = await provider('GET', `/v1/volumes/${volumeName}`);
        if (gone.status !== 404) throw new Error(`Owned routing volume still exists: ${gone.status}`);
      });
    }
  }
});
