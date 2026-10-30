import { randomUUID } from 'node:crypto';
import { flow } from '../core/flow';
import { AgentPrincipalsWorld, type AgentSession } from '../fixtures/agent-principals';

const ARTIFACTS = '/v1/projects/:projectId/artifacts';
const ONE = `${ARTIFACTS}/:artifactId`;
const COMMENTS = `${ONE}/comments`;
const CONTEXT = `${COMMENTS}/context`;
const COMMENT = `${COMMENTS}/:threadId/:commentId`;
const SEND = `${COMMENTS}/send`;
const FEATURES = '/v1/projects/:projectId/features';
type Artifact = { artifact_id: string; entry_version: string };
type Thread = { thread_id: string; can_reply: boolean; can_resolve: boolean; position: { start: number; end: number } | null;
  comments: Array<{ comment_id: string; can_edit: boolean; can_delete: boolean; mentions: Array<{ kind: string; session_id?: string; user_id?: string; token?: string }> }> };
type Context = { can_comment: boolean; can_moderate: boolean; comment_count: number; send_thread_ids: string[]; send_thread_count: number;
  people: Array<{ user_id: string; token: string }>; agents: Array<{ agent_name: string; session_id: string | null; token: string }>;
  send_target: { kind: 'session' | 'new'; session_id: string | null; agent_name: string } | null;
  version: { commit_id: string | null; entry_version: string | null } };
const AGENTS = [
  'project:', '  name: artifact-context', 'default_agent: writer', 'agents:',
  '  writer:', '    kortix_permissions: [project.session.read, project.session.start, project.artifact.read, project.artifact.write, project.artifact.comment]',
  '  researcher:', '    kortix_permissions: [project.session.read, project.artifact.comment]',
  '  reader:', '    kortix_permissions: [project.session.read, project.artifact.read]', '',
].join('\n');

flow('ART-9', {
  domain: 'artifacts', requires: ['database', 'sandbox'], timeoutMs: 180_000,
  routes: [`PATCH ${FEATURES}`, `POST ${ARTIFACTS}`, `GET ${ONE}`, `PUT ${ONE}`, `DELETE ${ONE}`, `GET ${ONE}/versions`, `GET ${ONE}/content`,
    `GET ${CONTEXT}`, `GET ${COMMENTS}`, `POST ${COMMENTS}`, `PATCH ${COMMENT}`, `POST ${SEND}`, 'GET /v1/drives'],
}, async (ctx) => {
  const providerBase = process.env.PLATINUM_API_URL?.replace(/\/+$/, '');
  const providerKey = process.env.PLATINUM_API_KEY;
  if (!providerBase || !providerKey || providerKey.startsWith('encrypted:')) throw new Error('ART-9 needs decrypted Files credentials and a workers-disabled API');
  const team = await ctx.fixtures.team({ enterprise: true });
  const project = await team.project({ managedGit: true });
  const other = await team.project();
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const owner = ctx.client.as(ctx.P.OWNER);
  const asMember = ctx.client.as(member);
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  const pp = { projectId: project.id };
  const params: { projectId: string; artifactId: string } = { ...pp, artifactId: randomUUID() };
  const source = '# Context proof\n\nForecast is ready.\n';
  const quote = 'Forecast is ready.';
  let artifact: Artifact;
  let privateDoc: Artifact;
  let writer: AgentSession;
  let reader: AgentSession;
  let oldCommit = '';
  let newCommit = '';
  let volumeName = '';
  let anchored: Thread;
  let legacy: Thread;
  const provider = (method: string, path: string) => fetch(`${providerBase}${path}`, { method, headers: { Authorization: `Bearer ${providerKey}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const context = async (client = owner, query: Record<string, string> = {}) => (await client.get(CONTEXT, { params, query })).status(200).json<Context>();
  const list = async (query: Record<string, string> = {}) => (await owner.get(COMMENTS, { params, query: { status: 'all', ...query } })).status(200).json<{ threads: Thread[] }>().threads;
  const latestVersion = async () => (await owner.get(`${ONE}/versions`, { params })).status(200).json<{ versions: { id: string }[] }>().versions[0]!.id;
  const counts = async () => (await world.db.query<{ jobs: number; commands: number; sessions: number }>(
    `SELECT (SELECT count(*)::int FROM kortix.job_queue WHERE artifact_id=$1) AS jobs,
      (SELECT count(*)::int FROM kortix.session_lifecycle_commands WHERE project_id=$2) AS commands,
      (SELECT count(*)::int FROM kortix.project_sessions WHERE project_id=$2) AS sessions`, [params.artifactId, project.id],
  )).rows[0]!;
  try {
    await ctx.step('context requires authentication and both flags; publish an actual Files doc as a controlled writer', async () => {
      (await ctx.client.as(ctx.P.ANON).get(CONTEXT, { params })).status(401);
      (await owner.get(CONTEXT, { params })).status(403).body().has('$.code', 'feature_disabled');
      for (const projectId of [project.id, other.id]) for (const feature of ['artifacts', 'artifact_comments']) (await owner.patch(FEATURES, { feature, enabled: true }, { params: { projectId } })).status(200);
      await world.writeManifest(AGENTS, 'ke2e: Artifact context permissions');
      writer = await world.mintAgentSession({ agent: 'writer', launcher: ctx.P.OWNER, visibility: 'private' });
      reader = await world.mintAgentSession({ agent: 'reader', launcher: ctx.P.OWNER, visibility: 'private' });
      artifact = (await writer.client.post(ARTIFACTS, { visibility: 'project', files: { 'index.md': { content: source } } }, { params: pp })).status(201).json<Artifact>();
      params.artifactId = artifact.artifact_id;
      oldCommit = await latestVersion();
      const drives = (await owner.get('/v1/drives', { query: pp })).status(200).json<{ drives: { driveId: string }[] }>().drives;
      if (drives.length !== 1) throw new Error('Expected one owned Files drive');
      volumeName = `kd-${drives[0]!.driveId.replace(/-/g, '').slice(0, 20)}`;
      if ((await provider('GET', `/v1/volumes/${volumeName}`)).status !== 200) throw new Error('Owned Files volume is missing');
    });
    await ctx.step('context reports exact current version and accepted tokens without queueing jobs, commands, or sessions', async () => {
      const before = await counts();
      const read = await context();
      if (!read.can_comment || !read.can_moderate || read.comment_count !== 0 || read.version.commit_id !== oldCommit || read.version.entry_version !== artifact.entry_version) throw new Error('Owner context permissions/version/count is incorrect');
      if (read.send_target?.kind !== 'session' || read.send_target.session_id !== writer.sessionId || read.send_target.agent_name !== 'writer') throw new Error('Owner context did not select the actual accessible writer');
      for (const agent of ['writer', 'researcher', 'reader']) if (!read.agents.some((row) => row.agent_name === agent && row.token.startsWith('@agent.'))) throw new Error(`Enabled agent ${agent} is absent from the full roster`);
      for (const id of [ctx.P.OWNER.userId, member.userId]) if (!read.people.some((person) => person.user_id === id && person.token.startsWith('@') && !/\s/.test(person.token))) throw new Error('A current viewer has no accepted person insertion token');
      if (read.send_thread_ids.length || read.send_thread_count !== 0) throw new Error('An empty Artifact cannot have a Send batch');
      await context(owner, { agent: 'researcher' });
      if (JSON.stringify(await counts()) !== JSON.stringify(before)) throw new Error('A context read created jobs, commands, or sessions');
    });
    await ctx.step('agent run authority filters the roster and chooses a private-source fallback without disclosing its session id', async () => {
      const denied = await context(asMember);
      if (denied.send_target !== null || denied.agents.length || denied.send_thread_ids.length || denied.send_thread_count !== 0) throw new Error('An ungranted member can select an agent');
      await world.grantRun('writer', member);
      const granted = await context(asMember);
      if (granted.send_target?.kind !== 'new' || granted.send_target.session_id !== null || granted.agents.some((row) => row.agent_name !== 'writer' || row.session_id !== null)) throw new Error('A private sibling session leaked or the run grant was ignored');
      privateDoc = (await owner.post(ARTIFACTS, { files: { 'index.md': { content: '# Private context\n' } } }, { params: pp })).status(201).json<Artifact>();
      (await asMember.get(CONTEXT, { params: { ...pp, artifactId: privateDoc.artifact_id } })).status(404);
      (await owner.get(CONTEXT, { params: { projectId: other.id, artifactId: artifact.artifact_id } })).status(404);
    });
    await ctx.step('current thread/comment permissions and authoritative unaddressed ids match newly opened human feedback', async () => {
      anchored = (await owner.post(COMMENTS, { body: 'Check the forecast.', anchor: { type: 'text', version: oldCommit, quote, prefix: '# Context proof\n\n', suffix: '\n' } }, { params })).status(201).json<{ thread: Thread }>().thread;
      legacy = (await owner.post(COMMENTS, { body: 'Legacy ETag anchor.', anchor: { type: 'none', version: artifact.entry_version } }, { params })).status(201).json<{ thread: Thread }>().thread;
      for (const thread of [anchored, legacy]) if (!thread.can_reply || !thread.can_resolve || !thread.comments[0]!.can_edit || !thread.comments[0]!.can_delete) throw new Error('The author mutation permissions are absent');
      const read = await context();
      if (read.comment_count !== 2 || [...read.send_thread_ids].sort().join(',') !== [anchored.thread_id, legacy.thread_id].sort().join(',')) throw new Error('The unaddressed Send batch/count is incorrect');
      const memberRows = (await asMember.get(COMMENTS, { params, query: { status: 'all' } })).status(200).json<{ threads: Thread[] }>().threads;
      if (memberRows.some((thread) => !thread.can_reply || thread.comments.some((comment) => comment.can_edit || comment.can_delete))) throw new Error('A different member received author edit/delete rights');
    });
    await ctx.step('historical comments select commit or exact entry ETag anchors and reanchor against that historical Markdown', async () => {
      const prefix = 'A newly inserted paragraph.\n\n';
      artifact = (await owner.put(ONE, { files: { 'index.md': { content: prefix + source } }, base_version: artifact.entry_version }, { params })).status(200).json<Artifact>();
      newCommit = await latestVersion();
      const current = (await list()).find((thread) => thread.thread_id === anchored.thread_id)!;
      const historical = await list({ version: oldCommit });
      if (current.position?.start !== (prefix + source).indexOf(quote) || historical.find((thread) => thread.thread_id === anchored.thread_id)?.position?.start !== source.indexOf(quote)) throw new Error('Current and historical text positions are not pinned to their own saved text');
      if (!historical.some((thread) => thread.thread_id === legacy.thread_id)) throw new Error('The actual historical ETag alias was not recognized');
      const newer = (await owner.post(COMMENTS, { body: 'New version concern.', anchor: { type: 'none', version: newCommit } }, { params })).status(201).json<{ thread: Thread }>().thread;
      if ((await list({ version: oldCommit })).some((thread) => thread.thread_id === newer.thread_id)) throw new Error('A later version thread leaked into historical comments');
      const historicalContext = await context(owner, { version: oldCommit });
      if (historicalContext.can_comment || historicalContext.can_moderate || historicalContext.send_target || historicalContext.send_thread_ids.length || historicalContext.send_thread_count !== 0 || historicalContext.comment_count !== 3 || historicalContext.version.commit_id !== oldCommit) throw new Error('Historical context permits mutations or has the wrong version/count');
      for (const thread of historical) if (thread.can_reply || thread.can_resolve || thread.comments.some((comment) => comment.can_edit || comment.can_delete)) throw new Error('Historical rows expose mutation permissions');
      const bytes = (await owner.get(`${ONE}/content`, { params, query: { version: oldCommit } })).status(200).text();
      if (bytes !== source) throw new Error('The pinned historical entry bytes differ from the original document');
    });
    await ctx.step('literal server agent tokens address the correct target and edited-away automatic routes become eligible again', async () => {
      const token = (await context()).agents.find((agent) => agent.agent_name === 'writer')!.token;
      const routed = (await owner.post(COMMENTS, { body: `${token} Review this concern.`, anchor: { type: 'none', version: newCommit } }, { params })).status(201).json<{ thread: Thread }>().thread;
      if (routed.comments[0]!.mentions.length !== 1 || routed.comments[0]!.mentions[0]!.kind !== 'session' || routed.comments[0]!.mentions[0]!.session_id !== writer.sessionId) throw new Error('A server insertion token resolved to another identity');
      const readerContext = await context(reader.client);
      const readerThread = (await reader.client.get(COMMENTS, { params, query: { status: 'all' } })).status(200).json<{ threads: Thread[] }>().threads.find((thread) => thread.thread_id === routed.thread_id);
      if (readerContext.agents.length || readerThread?.comments[0]?.mentions[0]?.token !== token) throw new Error('A reader without agent run rights did not receive the stored mention display token');
      if ((await context()).send_thread_ids.includes(routed.thread_id)) throw new Error('An addressed pending route is in the Send batch');
      (await owner.patch(COMMENT, { body: 'No automatic agent recipient remains.' }, { params: { ...params, threadId: routed.thread_id, commentId: routed.comments[0]!.comment_id } })).status(200);
      if (!(await context()).send_thread_ids.includes(routed.thread_id)) throw new Error('A removed original mention still hides the unaddressed thread');
      (await owner.post(SEND, { thread_ids: [legacy.thread_id], batch_id: randomUUID() }, { params })).status(200);
      if ((await context()).send_thread_ids.includes(legacy.thread_id)) throw new Error('A manual agent route did not address its selected thread');
    });
    await ctx.step('101 eligible threads expose a first100 batch and total101; Send rejects101 and leaves the final thread after sending100', async () => {
      const ids: string[] = Array.from({ length: 101 }, () => randomUUID());
      await world.db.query("UPDATE kortix.artifact_comment_threads SET status='resolved' WHERE artifact_id=$1 AND project_id=$2", [params.artifactId, project.id]);
      await world.db.query(`WITH inserted AS (
        INSERT INTO kortix.artifact_comment_threads(thread_id,artifact_id,project_id,anchor,anchor_version,created_by_user_id)
        SELECT id,$2,$3,jsonb_build_object('type','none','version',$4::text),$4,$5 FROM unnest($1::uuid[]) AS seeded(id)
        RETURNING thread_id
      ) INSERT INTO kortix.artifact_comments(thread_id,author_user_id,body)
        SELECT thread_id,$5,'Batch boundary concern.' FROM inserted`, [ids, params.artifactId, project.id, newCommit, ctx.P.OWNER.userId]);
      const read = await context();
      if (read.send_thread_ids.length !== 100 || read.send_thread_count !== 101 || read.send_thread_ids.some((id) => !ids.includes(id))) throw new Error('Context did not expose first100 IDs with total101');
      (await owner.post(SEND, { thread_ids: ids, batch_id: randomUUID() }, { params })).status(400);
      (await owner.post(SEND, { thread_ids: read.send_thread_ids, batch_id: randomUUID() }, { params })).status(200);
      const remaining = await context();
      const expected = ids.filter((id) => !read.send_thread_ids.includes(id));
      if (remaining.send_thread_count !== 1 || remaining.send_thread_ids.length !== 1 || remaining.send_thread_ids[0] !== expected[0]) throw new Error('Sending100 did not preserve the final eligible thread');
    });
    await ctx.step('read-only credentials/history failures/flags are enforced and unshare removes the context', async () => {
      const read = await context(reader.client);
      if (read.can_comment || read.can_moderate || read.agents.length || read.send_target || read.send_thread_ids.length || read.send_thread_count !== 0) throw new Error('A read-only agent has comment or Send rights');
      (await reader.client.post(COMMENTS, { body: 'Forbidden.', anchor: { type: 'none', version: newCommit } }, { params })).status(403).body().has('$.code', 'artifact_comment_forbidden');
      (await owner.get(CONTEXT, { params, query: { version: 'invalid/version' } })).status(400);
      (await owner.get(COMMENTS, { params, query: { version: 'missing-commit' } })).status(404);
      (await owner.patch(FEATURES, { feature: 'artifact_comments', enabled: false }, { params: pp })).status(200);
      (await owner.get(CONTEXT, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.patch(FEATURES, { feature: 'artifact_comments', enabled: true }, { params: pp })).status(200);
      (await owner.del(ONE, { params })).status(200);
      (await owner.get(CONTEXT, { params })).status(404);
    });
  } finally {
    await world.close();
    if (volumeName) await ctx.step('delete the owned Files volume and confirm provider404', async () => {
      if ((await provider('DELETE', `/v1/volumes/${volumeName}?missing_ok=true`)).status !== 204) throw new Error('Owned volume deletion failed');
      if ((await provider('GET', `/v1/volumes/${volumeName}`)).status !== 404) throw new Error('Owned volume cleanup did not persist');
    });
  }
});
