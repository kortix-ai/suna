import { randomUUID } from 'node:crypto';
import { flow } from '../core/flow';
import { withDb } from '../fixtures/chat';
import { bindDatabaseSessionCredential, createDatabaseSession } from '../fixtures/database-project';

const ARTIFACTS = '/v1/projects/:projectId/artifacts';
const ONE = `${ARTIFACTS}/:artifactId`;
const ACTIVITY = `${ONE}/activity`;
const CONTENT = `${ONE}/content`;
const RESTORE = `${ONE}/restore`;
const VERSIONS = `${ONE}/versions`;
const COMMENTS = `${ONE}/comments`;
const THREAD = `${COMMENTS}/:threadId`;
const REPLIES = `${THREAD}/replies`;
const COMMENT = `${THREAD}/:commentId`;
const FEATURES = '/v1/projects/:projectId/features';
const DRIVE_FILES = '/v1/drives/:driveId/files/content';
const TOKEN = '/v1/projects/:projectId/cli-token';
const ACCESS = '/v1/projects/:projectId/access/:userId';

type Item = {
  id: string;
  type: string;
  at: string;
  actor: { kind: 'user' | 'session' | 'system'; id: string | null; name: string | null };
  data: Record<string, unknown>;
};
type Feed = { items: Item[]; next_cursor: string | null; older_versions: boolean };
type Artifact = { artifact_id: string; entry_version: string; path: string; entry: string };

flow('ART-6', {
  domain: 'artifacts',
  requires: ['database', 'sandbox'],
  timeoutMs: 180_000,
  routes: [
    `PATCH ${FEATURES}`, `POST ${ARTIFACTS}`, `GET ${ONE}`, `PUT ${ONE}`, `PATCH ${ONE}`, `DELETE ${ONE}`,
    `GET ${CONTENT}`, `GET ${VERSIONS}`, `POST ${RESTORE}`, `GET ${ACTIVITY}`, 'GET /v1/drives', `PUT ${DRIVE_FILES}`,
    `POST ${COMMENTS}`, `POST ${REPLIES}`, `PATCH ${THREAD}`, `DELETE ${COMMENT}`,
    `POST ${TOKEN}`, 'DELETE /v1/projects/:projectId/cli-token/:tokenId', `DELETE ${ACCESS}`,
  ],
}, async (ctx) => {
  const providerBase = process.env.PLATINUM_API_URL?.replace(/\/+$/, '');
  const providerKey = process.env.PLATINUM_API_KEY;
  if (!providerBase || !providerKey || providerKey.startsWith('encrypted:')) throw new Error('ART-6 needs decrypted Platinum Files credentials and a normal API stack');
  const team = await ctx.fixtures.team();
  const project = await team.project();
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const owner = ctx.client.as(ctx.P.OWNER);
  const asMember = ctx.client.as(member);
  const projectParams = { projectId: project.id };
  const params: { projectId: string; artifactId: string } = { ...projectParams, artifactId: randomUUID() };
  const source = '# Activity report\n\nThe original forecast.\n';
  let artifact: Artifact;
  let volumeName = '';
  let tokenId = '';
  let firstCommitId = '';
  const versions: Array<{ id: string; kind: 'user' | 'session' | 'system'; actorId: string | null }> = [];
  const feed = async (query: Record<string, string | number> = {}) =>
    (await owner.get(ACTIVITY, { params, query })).status(200).json<Feed>();
  const latestCommitId = async () => {
    const history = (await owner.get(VERSIONS, { params })).status(200).json<{ versions: { id: string }[] }>().versions;
    if (!history[0]?.id) throw new Error('The Artifact entry has no Files commit history');
    return history[0].id;
  };
  const event = (items: Item[], type: string) => {
    const found = items.find((item) => item.type === type);
    if (!found) throw new Error(`Activity has no ${type} event`);
    return found;
  };
  const provider = (method: string, path: string, body?: string) => fetch(`${providerBase}${path}`, {
    method, headers: { Authorization: `Bearer ${providerKey}`, ...(body === undefined ? {} : { 'content-type': 'application/octet-stream' }) },
    ...(body === undefined ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(30_000),
  });

  try {
    await ctx.step('activity is authenticated and flag off → 403 feature_disabled; enable both Artifact flags', async () => {
      (await ctx.client.as(ctx.P.ANON).get(ACTIVITY, { params })).status(401);
      (await owner.get(ACTIVITY, { params })).status(403).body().has('$.code', 'feature_disabled');
      for (const feature of ['artifacts', 'artifact_comments']) {
        (await owner.patch(FEATURES, { feature, enabled: true }, { params: projectParams })).status(200);
      }
    });

    await ctx.step('publish a private doc → published event and user-authored save; a non-viewer → 404', async () => {
      artifact = (await owner.post(ARTIFACTS, { files: { 'index.md': { content: source } } }, { params: projectParams }))
        .status(201).json<Artifact>();
      params.artifactId = artifact.artifact_id;
      firstCommitId = await latestCommitId();
      versions.push({ id: firstCommitId, kind: 'user', actorId: ctx.P.OWNER.userId! });
      const published = event((await feed()).items, 'published');
      if (published.actor.kind !== 'user' || published.actor.id !== ctx.P.OWNER.userId) throw new Error('Published event has the wrong actor');
      (await asMember.get(ACTIVITY, { params })).status(404);
      const drives = (await owner.get('/v1/drives', { query: projectParams })).status(200).json<{ drives: { driveId: string }[] }>().drives;
      if (drives.length !== 1) throw new Error(`Expected one project drive, got ${drives.length}`);
      volumeName = `kd-${drives[0]!.driveId.replace(/-/g, '').slice(0, 20)}`;
      const exists = await provider('GET', `/v1/volumes/${volumeName}`);
      if (exists.status !== 200) throw new Error(`Published Files volume is not visible to the provider credential: ${exists.status}`);
    });

    await ctx.step('an Artifact API save and a direct Files API write both persist and retain the user actor', async () => {
      const saved = (await owner.put(ONE, { files: { 'index.md': { content: `${source}\nSaved through Artifacts.\n` } }, base_version: artifact.entry_version }, { params }))
        .status(200).json<Artifact>();
      if (saved.entry_version === artifact.entry_version) throw new Error('The Artifact save did not move the file ETag');
      versions.push({ id: await latestCommitId(), kind: 'user', actorId: ctx.P.OWNER.userId! });
      const drive = (await owner.get('/v1/drives', { query: projectParams })).status(200).json<{ drives: { driveId: string }[] }>().drives[0]!;
      const direct = `${source}\nSaved through Files.\n`;
      (await owner.put(DRIVE_FILES, direct, {
        params: { driveId: drive.driveId }, query: { path: `${artifact.path}/${artifact.entry}` }, raw: true,
        headers: { 'content-type': 'application/octet-stream' },
      })).status(200);
      versions.push({ id: await latestCommitId(), kind: 'user', actorId: ctx.P.OWNER.userId! });
      if ((await owner.get(CONTENT, { params })).status(200).text() !== direct) throw new Error('Files API bytes did not persist');
    });

    await ctx.step('a session-bound API save appears with its session id, agent name and session title', async () => {
      const sessionId = await createDatabaseSession(ctx.env, {
        projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility: 'private', metadata: { name: 'Activity writer' },
      });
      ctx.track('session', sessionId, { projectId: project.id });
      await withDb(ctx, (db) => db.query('UPDATE kortix.project_sessions SET agent_name = $2 WHERE session_id = $1', [sessionId, 'analyst']));
      const minted = (await owner.post(TOKEN, { name: ctx.fixtures.name('activity-session') }, { params: projectParams }))
        .status(201).json<{ token_id: string; secret_key: string }>();
      tokenId = minted.token_id;
      await bindDatabaseSessionCredential(ctx.env, { tokenId, commandId: randomUUID(), sessionId, accountId: team.id, projectId: project.id });
      const session = ctx.client.withBearer(minted.secret_key, 'ACTIVITY_SESSION');
      const current = (await owner.get(ONE, { params })).status(200).json<Artifact>();
      const saved = (await session.put(ONE, { files: { 'index.md': { content: `${source}\nSaved by the session.\n` } }, base_version: current.entry_version }, { params }))
        .status(200).json<Artifact>();
      if (saved.entry_version === current.entry_version) throw new Error('The session save did not move the file ETag');
      const commitId = await latestCommitId();
      versions.push({ id: commitId, kind: 'session', actorId: sessionId });
      const item = (await feed()).items.find((item) => item.id === `save:${commitId}`);
      if (item?.actor.kind !== 'session' || item.actor.id !== sessionId || !item.actor.name?.includes('analyst') || !item.actor.name.includes('Activity writer')) {
        throw new Error(`Session save attribution is incorrect: ${JSON.stringify(item?.actor)}`);
      }
    });

    await ctx.step('a direct provider write appears as system; an identical conditional API save adds a user save without changing its author', async () => {
      const direct = `${source}\nSaved outside the Kortix API.\n`;
      const query = new URLSearchParams({ path: `${artifact.path}/${artifact.entry}`, overwrite: 'true' });
      const written = await provider('PUT', `/v1/volumes/${volumeName}/files/content?${query}`, direct);
      if (written.status !== 201) throw new Error(`Direct Platinum file write returned ${written.status}`);
      const current = (await owner.get(ONE, { params })).status(200).json<Artifact>();
      const directCommitId = await latestCommitId();
      versions.push({ id: directCommitId, kind: 'system', actorId: null });
      if ((await owner.get(CONTENT, { params })).status(200).text() !== direct) throw new Error('Direct provider bytes did not persist');
      const items = (await feed()).items;
      if (new Set(versions.map((version) => version.id)).size !== 5) throw new Error('Five different saves did not create five Files commits');
      for (const expected of versions) {
        const item = items.find((item) => item.id === `save:${expected.id}`);
        if (item?.type !== 'saved' || item.actor.kind !== expected.kind || item.actor.id !== expected.actorId || item.data.commit_id !== expected.id) {
          throw new Error(`Save ${expected.id} attribution is incorrect: ${JSON.stringify(item)}`);
        }
      }
      const beforeSameBytes = items.filter((item) => item.type === 'saved').length;
      const identical = (await owner.put(ONE, { files: { 'index.md': { content: direct } }, base_version: current.entry_version }, { params }))
        .status(200).json<Artifact>();
      const sameBytesCommitId = await latestCommitId();
      if (sameBytesCommitId === directCommitId || identical.entry_version === current.entry_version) throw new Error('A conditional save did not create its own Files version');
      if ((await owner.get(CONTENT, { params })).status(200).text() !== direct) throw new Error('An identical save changed the entry bytes');
      const afterSameBytes = (await feed()).items;
      const unchanged = afterSameBytes.find((item) => item.id === `save:${directCommitId}`);
      const added = afterSameBytes.find((item) => item.id === `save:${sameBytesCommitId}`);
      if (afterSameBytes.filter((item) => item.type === 'saved').length !== beforeSameBytes + 1 || unchanged?.actor.kind !== 'system' || unchanged.actor.id !== null
        || added?.actor.kind !== 'user' || added.actor.id !== ctx.P.OWNER.userId || added.data.commit_id !== sameBytesCommitId) {
        throw new Error('An identical conditional save lost its new user actor or changed the previous system actor');
      }
    });

    await ctx.step('rename, visibility, sharing, restore and thread changes append their events in order', async () => {
      (await owner.patch(ONE, { title: 'Final activity report' }, { params })).status(200);
      (await owner.patch(ONE, { visibility: 'project' }, { params })).status(200);
      (await owner.patch(ONE, { shared_with_user_ids: [member.userId] }, { params })).status(200);
      (await owner.post(RESTORE, { version: firstCommitId }, { params })).status(200);
      if ((await owner.get(CONTENT, { params })).status(200).text() !== source) throw new Error('Restore did not persist the original entry');
      const opened = (await owner.post(COMMENTS, { anchor: { type: 'none', version: artifact.entry_version }, body: 'Review the activity.' }, { params }))
        .status(201).json<{ thread: { thread_id: string } }>();
      const threadParams = { ...params, threadId: opened.thread.thread_id };
      const reply = (await asMember.post(REPLIES, { body: 'Reviewed.' }, { params: threadParams }))
        .status(201).json<{ comment: { comment_id: string } }>();
      (await owner.patch(THREAD, { status: 'resolved' }, { params: threadParams })).status(200);
      (await owner.patch(THREAD, { status: 'open' }, { params: threadParams })).status(200);
      (await owner.del(COMMENT, { params: { ...threadParams, commentId: reply.comment.comment_id } })).status(200);
      const expected = ['published', 'renamed', 'visibility_changed', 'shared_with_changed', 'restored', 'thread_opened', 'replied', 'resolved', 'reopened', 'comment_deleted'];
      const items = (await feed()).items;
      const actual = items.filter((item) => item.id.startsWith('event:')).map((item) => item.type).reverse();
      if (actual.join(',') !== expected.join(',')) throw new Error(`Activity events are out of order: ${actual.join(',')}`);
      if (event(items, 'renamed').data.to !== 'Final activity report' || event(items, 'visibility_changed').data.to !== 'project') {
        throw new Error('Metadata event data does not describe the persisted change');
      }
      const priorName = event(items, 'replied').actor.name;
      if (!priorName) throw new Error('The replying person has no name');
      (await owner.del(ACCESS, { params: { ...projectParams, userId: member.userId! } })).status(200);
      const afterDeparture = event((await feed()).items, 'replied');
      if (afterDeparture.actor.id !== member.userId || afterDeparture.actor.name !== priorName) throw new Error('Leaving the project erased the comment actor name');
    });

    await ctx.step('limit=1 cursor pagination preserves same-millisecond microseconds and exact-timestamp id ties without duplicates or omissions', async () => {
      const before = await feed({ limit: 100 });
      const tied = ['renamed', 'visibility_changed', 'thread_opened'].map((type) => event(before.items, type));
      const ids = tied.map((item) => item.id.slice('event:'.length));
      await withDb(ctx, (db) => db.query(
        `UPDATE kortix.artifact_events SET created_at = CASE WHEN event_id = $2::uuid
           THEN '2026-01-01T00:00:00.123457Z'::timestamptz ELSE '2026-01-01T00:00:00.123456Z'::timestamptz END
         WHERE artifact_id = $1 AND event_id = ANY($3::uuid[])`, [params.artifactId, ids[2], ids],
      ));
      const published = event(before.items, 'published');
      const saved = before.items.find((item) => item.type === 'saved');
      if (!saved) throw new Error('There is no save to compare with an event timestamp');
      await withDb(ctx, (db) => db.query(
        'UPDATE kortix.artifact_events SET created_at = $2::timestamptz WHERE artifact_id = $1 AND event_id = $3::uuid',
        [params.artifactId, saved.at, published.id.slice('event:'.length)],
      ));
      const full = await feed({ limit: 100 });
      if (full.older_versions) throw new Error('A short history incorrectly reports a truncated save window');
      const expectedTies = [`event:${ids[2]}`, ...ids.slice(0, 2).sort().reverse().map((id) => `event:${id}`)];
      const actualTies = full.items.filter((item) => tied.some((target) => target.id === item.id)).map((item) => item.id);
      if (actualTies.join(',') !== expectedTies.join(',')) throw new Error('Microsecond or exact-timestamp ordering is incorrect');
      const sourceTie = full.items.filter((item) => item.id === saved.id || item.id === published.id).map((item) => item.id);
      if (sourceTie.join(',') !== [saved.id, published.id].sort().reverse().join(',')) throw new Error('An event/save timestamp tie is out of order');
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const result = await feed({ limit: 1, ...(cursor ? { cursor } : {}) });
        if (result.items.length !== 1) throw new Error(`Single-item page returned ${result.items.length} items`);
        paged.push(result.items[0]!.id);
        cursor = result.next_cursor;
        if (!cursor) break;
      }
      if (cursor || paged.join(',') !== full.items.map((item) => item.id).join(',') || new Set(paged).size !== paged.length) {
        throw new Error('Cursor pagination duplicated, omitted or reordered activity');
      }
    });

    await ctx.step('nondecimal or out-of-range limits → 400 invalid_limit; turning artifact_comments off → 403', async () => {
      for (const limit of ['1e3', '1.5', '0', '101']) {
        (await owner.get(ACTIVITY, { params, query: { limit } })).status(400).body().has('$.code', 'invalid_limit');
      }
      (await owner.get(ACTIVITY, { params, query: { cursor: 'not-a-cursor' } })).status(400);
      (await owner.patch(FEATURES, { feature: 'artifact_comments', enabled: false }, { params: projectParams })).status(200);
      (await owner.get(ACTIVITY, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.patch(FEATURES, { feature: 'artifact_comments', enabled: true }, { params: projectParams })).status(200);
      (await owner.del(ONE, { params })).status(200);
      (await owner.get(ACTIVITY, { params })).status(404);
    });
  } finally {
    if (tokenId) await owner.del('/v1/projects/:projectId/cli-token/:tokenId', { params: { ...projectParams, tokenId } });
    if (volumeName) await ctx.step('delete the synthetic Files volume → 204; provider read-back → 404', async () => {
      const removed = await provider('DELETE', `/v1/volumes/${volumeName}?missing_ok=true`);
      if (removed.status !== 204) throw new Error(`Synthetic Files volume cleanup returned ${removed.status}`);
      const gone = await provider('GET', `/v1/volumes/${volumeName}`);
      if (gone.status !== 404) throw new Error(`Synthetic Files volume still exists: ${gone.status}`);
    });
  }
});
