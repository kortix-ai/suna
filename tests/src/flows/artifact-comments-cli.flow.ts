import { flow } from '../core/flow';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { CliSandbox, type CliResult } from '../fixtures/cli';

const ARTIFACTS = '/v1/projects/:projectId/artifacts';
const ONE = `${ARTIFACTS}/:artifactId`;
const COMMENTS = `${ONE}/comments`;
const LOOKUP = '/v1/projects/:projectId/artifact-comment-threads/:threadId';
const FEATURES = '/v1/projects/:projectId/features';
type Author = { kind: 'user'; user_id: string; name: string | null } | { kind: 'session'; session_id: string; agent_name: string; title: string | null };
type Comment = { comment_id: string; body: string; author: Author; author_user_id: string | null; author_session_id: string | null };
type Thread = { thread_id: string; artifact_id: string; status: string; anchor: Record<string, unknown>; comments: Comment[] };
type Artifact = { artifact_id: string; entry_version: string };

function ok(result: CliResult, label: string): CliResult {
  if (result.exitCode !== 0) throw new Error(`${label}: exit ${result.exitCode}: ${result.all.slice(0, 800)}`);
  return result;
}

const AGENTS = [
  'project:', '  name: artifact-cli-review', 'default_agent: reviewer', 'agents:',
  '  reviewer:', '    kortix_permissions: [project.session.read, project.artifact.comment]',
  '  reader:', '    kortix_permissions: [project.session.read, project.artifact.read]', '',
].join('\n');

flow('ART-5', {
  domain: 'artifacts', requires: ['database', 'sandbox'], timeoutMs: 180_000,
  routes: [
    `PATCH ${FEATURES}`, `POST ${ARTIFACTS}`, `DELETE ${ONE}`, `GET ${ONE}/versions`, `GET ${ONE}/content`,
    `GET ${COMMENTS}`, `POST ${COMMENTS}`, `POST ${COMMENTS}/:threadId/replies`, `PATCH ${COMMENTS}/:threadId`,
    `GET ${LOOKUP}`, `GET ${ONE}/activity`, 'GET /v1/drives',
  ],
}, async (ctx) => {
  const providerBase = process.env.PLATINUM_API_URL?.replace(/\/+$/, '');
  const providerKey = process.env.PLATINUM_API_KEY;
  if (!providerBase || !providerKey || providerKey.startsWith('encrypted:')) throw new Error('ART-5 needs decrypted Platinum Files credentials and a normal API stack');
  const team = await ctx.fixtures.team({ enterprise: true });
  const project = await team.project({ managedGit: true });
  const other = await team.project();
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const owner = ctx.client.as(ctx.P.OWNER);
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  const sandbox = new CliSandbox('artifact-comments');
  const pp = { projectId: project.id };
  const source = '# Review report\n\nThe forecast needs review.\nThe source is the signed report.\n';
  let doc: Artifact;
  let page: Artifact;
  let privateArtifact: Artifact;
  let thread: Thread;
  let volumeName = '';
  let run: (args: string[]) => Promise<CliResult>;
  let readerRun: (args: string[]) => Promise<CliResult>;
  let sessionId = '';
  const params = () => ({ ...pp, artifactId: doc.artifact_id });
  const threads = async () => (await owner.get(COMMENTS, { params: params(), query: { status: 'all' } })).status(200).json<{ threads: Thread[] }>().threads;
  const provider = (method: string, path: string) => fetch(`${providerBase}${path}`, { method, headers: { Authorization: `Bearer ${providerKey}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });

  try {
    await ctx.step('publish real doc and HTML files; mint governed session PATs without starting a runtime', async () => {
      const missingThread = { ...pp, threadId: crypto.randomUUID() };
      (await ctx.client.as(ctx.P.ANON).get(LOOKUP, { params: missingThread })).status(401);
      (await owner.get(LOOKUP, { params: missingThread })).status(403).body().has('$.code', 'feature_disabled');
      for (const projectId of [project.id, other.id]) for (const feature of ['artifacts', 'artifact_comments']) {
        (await owner.patch(FEATURES, { feature, enabled: true }, { params: { projectId } })).status(200);
      }
      doc = (await owner.post(ARTIFACTS, { files: { 'index.md': { content: source } }, visibility: 'project' }, { params: pp })).status(201).json<Artifact>();
      page = (await owner.post(ARTIFACTS, { files: { 'index.html': { content: '<html><title>Review chart</title><div id="chart">Synthetic chart</div></html>' } }, visibility: 'project' }, { params: pp })).status(201).json<Artifact>();
      privateArtifact = (await owner.post(ARTIFACTS, { files: { 'index.md': { content: '# Private review\n' } } }, { params: pp })).status(201).json<Artifact>();
      const drives = (await owner.get('/v1/drives', { query: pp })).status(200).json<{ drives: { driveId: string }[] }>().drives;
      if (drives.length !== 1) throw new Error(`Expected one owned project drive, got ${drives.length}`);
      volumeName = `kd-${drives[0]!.driveId.replace(/-/g, '').slice(0, 20)}`;
      if ((await provider('GET', `/v1/volumes/${volumeName}`)).status !== 200) throw new Error('The synthetic Files volume was not created');
      await world.writeManifest(AGENTS, 'ke2e: artifact CLI commenters');
      const reviewer = await world.mintAgentSession({ agent: 'reviewer', launcher: ctx.P.OWNER, visibility: 'project', metadata: { name: 'Review agent' } });
      const reader = await world.mintAgentSession({ agent: 'reader', launcher: ctx.P.OWNER, visibility: 'project' });
      sessionId = reviewer.sessionId;
      const env = (secret: string, sid: string) => ({ KORTIX_TOKEN: secret, KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: project.id, KORTIX_SESSION_ID: sid, KORTIX_FEATURE_FLAGS: 'artifacts,artifact_comments' });
      run = (args) => sandbox.run(['artifacts', ...args], { env: env(reviewer.secret, reviewer.sessionId) });
      readerRun = (args) => sandbox.run(['artifacts', ...args], { env: env(reader.secret, reader.sessionId) });
    });

    await ctx.step('real CLI comment --quote pins a Files commit and creates a text thread authored by its session', async () => {
      thread = JSON.parse(ok(await run(['comment', doc.artifact_id, 'Confirm the forecast source.', '--quote', 'The forecast needs review.', '--json']), 'quote comment').stdout);
      const versions = (await owner.get(`${ONE}/versions`, { params: params() })).status(200).json<{ versions: { id: string }[] }>().versions;
      if (thread.anchor.type !== 'text' || thread.anchor.quote !== 'The forecast needs review.' || thread.anchor.version !== versions[0]?.id) throw new Error('The CLI did not pin its text anchor to the Files history commit');
      const comment = thread.comments[0]!;
      if (comment.author_session_id !== sessionId || comment.author_user_id !== null || comment.author.kind !== 'session' || comment.author.session_id !== sessionId
        || comment.author.agent_name !== 'reviewer' || comment.author.title !== 'Review agent') throw new Error('Session authorship is not hydrated or raw session identity was lost');
      const found = (await threads()).find((row) => row.thread_id === thread.thread_id);
      if (found?.comments[0]?.body !== 'Confirm the forecast source.') throw new Error('The CLI comment did not persist');
    });

    await ctx.step('missing quote exits nonzero with quote not found and creates no thread; whole and selector comments use explicit defaults', async () => {
      const before = (await threads()).length;
      const missing = await run(['comment', doc.artifact_id, 'This must not be posted.', '--quote', 'A sentence that is absent.']);
      if (missing.exitCode === 0 || !missing.all.includes('quote not found')) throw new Error('Missing quote did not fail explicitly');
      if ((await threads()).length !== before) throw new Error('A missing quote created a thread');
      const whole = JSON.parse(ok(await run(['comment', doc.artifact_id, 'Review the whole report.', '--json']), 'whole comment').stdout) as Thread;
      if (whole.anchor.type !== 'none') throw new Error('A whole-artifact comment has a positional anchor');
      const selected = JSON.parse(ok(await run(['comment', page.artifact_id, 'Check the chart labels.', '--selector', '#chart', '--json']), 'selector comment').stdout) as Thread;
      if (selected.anchor.type !== 'point' || selected.anchor.selector !== '#chart' || selected.anchor.viewport_width !== 1280 || selected.anchor.snippet !== ''
        || JSON.stringify(selected.anchor.offset) !== JSON.stringify({ x: 0.5, y: 0.5 }) || JSON.stringify(selected.anchor.scroll) !== JSON.stringify({ x: 0, y: 0 })) throw new Error('Selector anchor defaults changed');
    });

    await ctx.step('comments --json, reply by thread id, resolve, resolved/all filters, and reopen run as real CLI processes', async () => {
      const open = JSON.parse(ok(await run(['comments', doc.artifact_id, '--json']), 'comments').stdout) as Thread[];
      if (open.length !== 2 || !open.some((row) => row.thread_id === thread.thread_id)) throw new Error('Open comments are incomplete');
      const reply = JSON.parse(ok(await run(['reply', thread.thread_id, 'Corrected the source citation.', '--json']), 'reply').stdout) as Comment;
      if (reply.author.kind !== 'session' || reply.author.session_id !== sessionId) throw new Error('CLI reply lost the session author');
      const resolved = JSON.parse(ok(await run(['resolve', thread.thread_id, '--json']), 'resolve').stdout) as Thread;
      if (resolved.status !== 'resolved') throw new Error('Resolve did not persist');
      const onlyResolved = JSON.parse(ok(await run(['comments', doc.artifact_id, '--resolved', '--json']), 'resolved comments').stdout) as Thread[];
      const all = JSON.parse(ok(await run(['comments', doc.artifact_id, '--all', '--json']), 'all comments').stdout) as Thread[];
      const stillOpen = JSON.parse(ok(await run(['comments', doc.artifact_id, '--json']), 'remaining open comments').stdout) as Thread[];
      if (onlyResolved.length !== 1 || onlyResolved[0]?.thread_id !== thread.thread_id || all.length !== 2 || stillOpen.some((row) => row.thread_id === thread.thread_id)) throw new Error('Comment status filters are incorrect');
      const reopened = JSON.parse(ok(await run(['reopen', thread.thread_id, '--json']), 'reopen').stdout) as Thread;
      if (reopened.status !== 'open') throw new Error('Reopen did not persist');
    });

    await ctx.step('thread lookup hydrates user and session authors; another project and a private non-viewer receive 404', async () => {
      const human = (await owner.post(`${COMMENTS}/:threadId/replies`, { body: 'The source is confirmed.' }, { params: { ...params(), threadId: thread.thread_id } })).status(201).json<{ comment: Comment }>().comment;
      if (human.author.kind !== 'user' || human.author.user_id !== ctx.P.OWNER.userId || !human.author.name || human.author_user_id !== ctx.P.OWNER.userId) throw new Error('The user author is not hydrated or raw user identity was lost');
      const looked = (await owner.get(LOOKUP, { params: { ...pp, threadId: thread.thread_id } })).status(200).json<{ thread: Thread }>().thread;
      if (!looked.comments.some((row) => row.author.kind === 'session' && row.author.session_id === sessionId) || !looked.comments.some((row) => row.comment_id === human.comment_id && row.author.kind === 'user')) throw new Error('Thread lookup did not hydrate both authors');
      (await owner.get(LOOKUP, { params: { projectId: other.id, threadId: thread.thread_id } })).status(404);
      const hidden = (await owner.post(COMMENTS, { body: 'Private review.', anchor: { type: 'none', version: privateArtifact.entry_version } }, { params: { ...pp, artifactId: privateArtifact.artifact_id } })).status(201).json<{ thread: Thread }>().thread;
      (await ctx.client.as(member).get(LOOKUP, { params: { ...pp, threadId: hidden.thread_id } })).status(404);
    });

    await ctx.step('activity --json includes the CLI thread events and limit; a session without artifact.comment exits nonzero with 403', async () => {
      const activity = JSON.parse(ok(await run(['activity', doc.artifact_id, '--limit', '100', '--json']), 'activity').stdout) as { items: { type: string; data: { thread_id?: string } }[] };
      for (const type of ['thread_opened', 'replied', 'resolved', 'reopened']) if (!activity.items.some((item) => item.type === type && item.data.thread_id === thread.thread_id)) throw new Error(`CLI activity has no ${type} event`);
      const limited = JSON.parse(ok(await run(['activity', doc.artifact_id, '--limit', '1', '--json']), 'limited activity').stdout) as { items: unknown[]; next_cursor: string | null };
      if (limited.items.length !== 1 || !limited.next_cursor) throw new Error('The activity limit was ignored');
      const before = (await threads()).length;
      const denied = await readerRun(['comment', doc.artifact_id, 'A reader must not post.']);
      if (denied.exitCode === 0 || !denied.all.includes('403')) throw new Error(`Reader denial did not expose HTTP403: ${denied.all.slice(0, 500)}`);
      if ((await threads()).length !== before) throw new Error('The denied reader created a thread');
    });

    await ctx.step('unshare removes the thread lookup surface → 404', async () => {
      for (const artifact of [doc, page, privateArtifact]) (await owner.del(ONE, { params: { ...pp, artifactId: artifact.artifact_id } })).status(200);
      (await owner.get(LOOKUP, { params: { ...pp, threadId: thread.thread_id } })).status(404);
    });
  } finally {
    sandbox.dispose();
    await world.close();
    if (volumeName) await ctx.step('delete the owned Files volume → 204; provider read-back → 404', async () => {
      const removed = await provider('DELETE', `/v1/volumes/${volumeName}?missing_ok=true`);
      if (removed.status !== 204) throw new Error(`Synthetic Files cleanup returned ${removed.status}`);
      const gone = await provider('GET', `/v1/volumes/${volumeName}`);
      if (gone.status !== 404) throw new Error(`Synthetic Files volume still exists: ${gone.status}`);
    });
  }
});
