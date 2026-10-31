import { randomUUID } from 'node:crypto';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { withDb } from '../fixtures/chat';

const ARTIFACTS = '/v1/projects/:projectId/artifacts';
const ARTIFACT = `${ARTIFACTS}/:artifactId`;
const COMMENTS = `${ARTIFACT}/comments`;
const THREAD = `${COMMENTS}/:threadId`;
const REPLIES = `${THREAD}/replies`;
const COMMENT = `${THREAD}/:commentId`;
const SCREENSHOT = `${COMMENTS}/:commentId/screenshot`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==';
const WEBP = 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=';
const FEATURES = '/v1/projects/:projectId/features';
const ROLES = '/v1/accounts/:accountId/iam/roles';
const POLICIES = '/v1/accounts/:accountId/iam/policies';

type Comment = {
  comment_id: string;
  author_user_id: string | null;
  author_session_id: string | null;
  body: string;
  deleted_at: string | null;
  edited_at: string | null;
  marks?: unknown[];
  screenshot_key?: string | null;
  screenshot_url?: string;
};

type Thread = {
  thread_id: string;
  artifact_id: string;
  anchor: { type: string; version: string; quote?: string };
  anchor_version: string;
  status: 'open' | 'resolved';
  created_by_user_id: string | null;
  created_by_session_id: string | null;
  resolved_by_user_id: string | null;
  resolved_by_session_id: string | null;
  resolved_at: string | null;
  comments: Comment[];
};

const AGENTS = [
  'project:',
  '  name: artifact-comments',
  'default_agent: commenter',
  'agents:',
  '  commenter:',
  '    kortix_permissions: [project.session.read, project.artifact.comment]',
  '  reader:',
  '    kortix_permissions: [project.session.read, project.artifact.read]',
  '',
].join('\n');

flow('ART-4', {
  domain: 'artifacts',
  requires: ['database', 'supabaseAdmin'],
  timeoutMs: 180_000,
  routes: [
    `PATCH ${FEATURES}`, `GET ${COMMENTS}`, `POST ${COMMENTS}`,
    `POST ${REPLIES}`, `PATCH ${THREAD}`, `PATCH ${COMMENT}`, `DELETE ${COMMENT}`,
    `GET ${ARTIFACTS}`, `GET ${SCREENSHOT}`, `PATCH ${ARTIFACT}`, `DELETE /v1/projects/:projectId`, `DELETE ${ARTIFACT}`, `POST ${ROLES}`, `POST ${POLICIES}`,
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const project = await team.project({ managedGit: true });
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const readOnly = await team.addMember('member');
  const owner = ctx.client.as(ctx.P.OWNER);
  const asMember = ctx.client.as(member);
  const asReadOnly = ctx.client.as(readOnly);
  const artifactId = randomUUID();
  const privateId = randomUUID();
  const driveId = randomUUID();
  const params = { projectId: project.id, artifactId };
  const anchor = { type: 'text', version: 'v1', quote: 'Revenue rose to 20.', prefix: '', suffix: '' };
  let threadId = '';
  let rootCommentId = '';
  let memberCommentId = '';
  const thread = () => ({ params: { ...params, threadId } });
  const comment = (commentId: string) => ({ params: { ...params, threadId, commentId } });
  const list = () => owner.get(COMMENTS, { params, query: { status: 'all' } });
  const find = async () => {
    const rows = (await list()).status(200).json<{ threads: Thread[] }>().threads;
    const found = rows.find((row) => row.thread_id === threadId);
    if (!found) throw new Error(`thread ${threadId} missing from comments`);
    return found;
  };
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  const screenshotKeys = new Set<string>();
  const screenshotProjects = new Set([project.id]);
  const region = { type: 'region', version: 'v1', selector: '#chart', snippet: 'Forecast chart', viewport_width: 1200, scroll: { x: 0, y: 0 }, offset: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } };
  const marks = [{ tool: 'arrow', color: 'red', width: 0.006, points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }] }];
  const rememberScreenshot = (comment: Comment) => { if (!comment.screenshot_key) throw new Error('Screenshot key missing'); screenshotKeys.add(comment.screenshot_key); return comment.screenshot_key; };
  const storageUrl = (key: string, mode = '') => `${ctx.env.supabaseUrl}/storage/v1/object/${mode}session-attachments/${key.split('/').map(encodeURIComponent).join('/')}`;
  const serviceHeaders = () => { const key = ctx.env.supabaseServiceRoleKey!; return { apikey: key, Authorization: `Bearer ${key}` }; };
  async function objectAbsent(key: string) {
    const response = await fetch(storageUrl(key), { headers: serviceHeaders(), signal: AbortSignal.timeout(20_000) });
    if (response.ok) throw new Error('Deleted screenshot object is still readable with the service role');
    const body = await response.json().catch(() => ({})) as { statusCode?: string | number; error?: string };
    if (response.status !== 404 && String(body.statusCode) !== '404' && body.error !== 'not_found') throw new Error(`Unexpected screenshot absence response${response.status}`);
  }


  try {
    await ctx.step('seed a project page and a private page without external Files storage', async () => {
      await withDb(ctx, async (db) => {
        await db.query(
          `INSERT INTO kortix.drives (drive_id, account_id, kind, name, project_id, platinum_volume_name)
           VALUES ($1, $2, 'project', 'Artifact comments', $3, $4)`,
          [driveId, team.id, project.id, `ke2e-comments-${driveId}`],
        );
        for (const [id, visibility] of [[artifactId, 'project'], [privateId, 'private']]) {
          await db.query(
            `INSERT INTO kortix.artifacts
               (artifact_id, project_id, account_id, drive_id, root, entry, folder, title, type, visibility, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, 'index.html', true, 'Quarterly report', 'html', $6, $7)`,
            [id, project.id, team.id, driveId, `/Company/Artifacts/${id}`, visibility, ctx.P.OWNER.userId],
          );
        }
      });
      (await owner.patch(FEATURES, { feature: 'artifacts', enabled: true }, { params: { projectId: project.id } })).status(200);
    });

    await ctx.step('ANON reads a public Artifact comments route → 401; artifact_comments off → 403 feature_disabled', async () => {
      await withDb(ctx, (db) => db.query('UPDATE kortix.artifacts SET visibility = \'public\' WHERE artifact_id = $1', [artifactId]));
      (await ctx.client.as(ctx.P.ANON).get(COMMENTS, { params })).status(401);
      (await owner.get(COMMENTS, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.post(COMMENTS, { anchor, body: 'Review the forecast.' }, { params })).status(403).body().has('$.code', 'feature_disabled');
      await withDb(ctx, (db) => db.query('UPDATE kortix.artifacts SET visibility = \'project\' WHERE artifact_id = $1', [artifactId]));
      (await owner.patch(FEATURES, { feature: 'artifact_comments', enabled: true }, { params: { projectId: project.id } })).status(200);
    });

    await ctx.step('a project member cannot read or comment on the private Artifact → 404; malformed anchors → 400 invalid_anchor', async () => {
      const privateParams = { ...params, artifactId: privateId };
      (await asMember.get(COMMENTS, { params: privateParams })).status(404);
      (await asMember.post(COMMENTS, { anchor, body: 'Private feedback.' }, { params: privateParams })).status(404);
      (await owner.post(COMMENTS, { anchor: { ...anchor, quote: 'x'.repeat(33) }, body: 'Bad anchor.' }, { params }))
        .status(400).body().has('$.code', 'invalid_anchor');
      (await owner.post(COMMENTS, { anchor: { type: 'none', version: 'v\0' }, body: 'NUL anchor.' }, { params }))
        .status(400).body().has('$.code', 'invalid_anchor');
      (await owner.post(COMMENTS, { anchor, body: 'x'.repeat(10_001) }, { params })).status(400);
    });

    await ctx.step('OWNER creates a text thread → 201; GET returns its stored anchor and user authorship', async () => {
      const created = (await owner.post(COMMENTS, { anchor, body: 'Review the forecast.' }, { params }))
        .status(201).json<{ thread: Thread }>().thread;
      threadId = created.thread_id;
      rootCommentId = created.comments[0]!.comment_id;
      const stored = await find();
      if (stored.anchor.quote !== anchor.quote || stored.anchor_version !== 'v1' || stored.status !== 'open') {
        throw new Error(`incorrect thread state: ${JSON.stringify(stored)}`);
      }
      if (stored.created_by_user_id !== ctx.P.OWNER.userId || stored.created_by_session_id !== null
        || stored.comments[0]!.author_user_id !== ctx.P.OWNER.userId || stored.comments[0]!.author_session_id !== null) {
        throw new Error('a person was not recorded as the comment author');
      }
      if (stored.comments[0]!.body !== 'Review the forecast.') throw new Error('the first comment did not persist');
    });

    await ctx.step('a member replies → 201; OWNER resolves and reopens; status filters and read-back agree', async () => {
      const reply = (await asMember.post(REPLIES, { body: 'The forecast is confirmed.' }, thread()))
        .status(201).json<{ comment: Comment }>().comment;
      memberCommentId = reply.comment_id;
      if (reply.author_user_id !== member.userId || reply.author_session_id !== null) throw new Error('reply author is incorrect');
      const resolved = (await owner.patch(THREAD, { status: 'resolved' }, thread())).status(200).json<{ thread: Thread }>().thread;
      if (resolved.status !== 'resolved' || resolved.resolved_by_user_id !== ctx.P.OWNER.userId || !resolved.resolved_at) {
        throw new Error('resolve did not persist its actor and timestamp');
      }
      (await owner.get(COMMENTS, { params, query: { status: 'open' } })).status(200).body().has('$.threads.length', 0);
      (await owner.get(COMMENTS, { params, query: { status: 'resolved' } })).status(200).body().has('$.threads[0].thread_id', threadId);
      (await owner.patch(THREAD, { status: 'open' }, thread())).status(200);
      const reopened = await find();
      if (reopened.status !== 'open' || reopened.resolved_at !== null || reopened.resolved_by_user_id !== null) {
        throw new Error('reopen retained the resolved state');
      }
      if (!reopened.comments.some((row) => row.comment_id === memberCommentId && row.body === 'The forecast is confirmed.')) {
        throw new Error('the reply did not persist');
      }
    });

    await ctx.step('each author can edit their comment; editing another author → 403 artifact_comment_forbidden', async () => {
      const edited = (await owner.patch(COMMENT, { body: 'Review the final forecast.' }, comment(rootCommentId)))
        .status(200).json<{ comment: Comment }>().comment;
      if (edited.body !== 'Review the final forecast.' || !edited.edited_at) throw new Error('edit did not persist body and timestamp');
      (await asMember.patch(COMMENT, { body: 'Changed by someone else.' }, comment(rootCommentId)))
        .status(403).body().has('$.code', 'artifact_comment_forbidden');
      (await owner.patch(COMMENT, { body: 'Changed by the manager.' }, comment(memberCommentId)))
        .status(403).body().has('$.code', 'artifact_comment_forbidden');
      (await asMember.patch(COMMENT, { body: 'The final forecast is confirmed.' }, comment(memberCommentId))).status(200);
      if ((await find()).comments.find((row) => row.comment_id === memberCommentId)?.body !== 'The final forecast is confirmed.') {
        throw new Error('the member edit did not persist');
      }
    });

    await ctx.step('a member cannot delete another author; a manager deletes their reply and GET keeps its tombstone', async () => {
      (await asMember.del(COMMENT, comment(rootCommentId))).status(403).body().has('$.code', 'artifact_comment_forbidden');
      const deleted = (await owner.del(COMMENT, comment(memberCommentId))).status(200).json<{ comment: Comment }>().comment;
      if (!deleted.deleted_at) throw new Error('delete did not set deleted_at');
      const stored = (await find()).comments.find((row) => row.comment_id === memberCommentId);
      if (!stored?.deleted_at) throw new Error('the deleted reply lost its tombstone');
      if (stored.body !== '') throw new Error('GET exposed a deleted comment body');
      const erased = await withDb(ctx, async (db) => (await db.query<{ body: string; deleted_at: Date | null }>(
        'SELECT body, deleted_at FROM kortix.artifact_comments WHERE comment_id = $1', [memberCommentId],
      )).rows[0]);
      if (erased?.body !== '' || !erased.deleted_at) throw new Error('delete retained the comment body in the database');
      (await owner.post(REPLIES, { body: 'Wrong Artifact.' }, { params: { ...params, artifactId: privateId, threadId } })).status(404);
    });

    await ctx.step('deleting a thread root leaves a tombstone and refuses new replies → 409 thread_deleted', async () => {
      const created = (await owner.post(COMMENTS, { anchor: { type: 'none', version: 'v1' }, body: 'Withdraw this thread.' }, { params }))
        .status(201).json<{ thread: Thread }>().thread;
      const deadParams = { ...params, threadId: created.thread_id, commentId: created.comments[0]!.comment_id };
      (await owner.del(COMMENT, { params: deadParams })).status(200).body().has('$.comment.body', '');
      (await owner.post(REPLIES, { body: 'Late reply.' }, { params: deadParams }))
        .status(409).body().has('$.code', 'thread_deleted');
    });

    await ctx.step('a member with only project.read and project.artifact.read can list but cannot comment → 403', async () => {
      const role = (await owner.post(ROLES, {
        key: `artifact_reader_${randomUUID().slice(0, 8)}`,
        name: 'Artifact reader',
        resourceType: 'project',
        actions: ['project.read', 'project.artifact.read'],
      }, { params: { accountId: team.id } })).status(201).json<{ role_id: string }>();
      (await owner.post(POLICIES, {
        principalType: 'member', principalId: readOnly.userId, roleId: role.role_id,
        scopeType: 'project', scopeId: project.id,
      }, { params: { accountId: team.id } })).status(201);
      const readable = await waitFor(() => asReadOnly.get(COMMENTS, { params }), {
        until: (response) => response.statusCode === 200,
        timeoutMs: 20_000, intervalMs: 1_000, description: 'the project-scoped reader can read comments',
      });
      readable.status(200);
      (await asReadOnly.get(COMMENTS, { params: { ...params, artifactId: privateId } })).status(404);
      (await asReadOnly.post(COMMENTS, { anchor, body: 'Hidden Artifact.' }, { params: { ...params, artifactId: privateId } })).status(404);
      (await asReadOnly.post(COMMENTS, { anchor, body: 'A reader cannot comment.' }, { params }))
        .status(403).body().has('$.code', 'artifact_comment_forbidden');
    });

    await ctx.step('a governed session with artifact.comment (implies read) comments as the session; a read-only agent → 403', async () => {
      await world.writeManifest(AGENTS, 'ke2e: artifact comment agents');
      const commenter = await world.mintAgentSession({ agent: 'commenter', launcher: ctx.P.OWNER, visibility: 'project' });
      const reader = await world.mintAgentSession({ agent: 'reader', launcher: ctx.P.OWNER, visibility: 'project' });
      const created = (await commenter.client.post(COMMENTS, { anchor: { type: 'none', version: 'v1' }, body: 'Agent review.' }, { params }))
        .status(201).json<{ thread: Thread }>().thread;
      if (created.created_by_user_id !== null || created.created_by_session_id !== commenter.sessionId
        || created.comments[0]!.author_user_id !== null || created.comments[0]!.author_session_id !== commenter.sessionId) {
        throw new Error('session-bound author was recorded as a person');
      }
      const artifacts = (await commenter.client.get(ARTIFACTS, { params: { projectId: project.id } }))
        .status(200).json<{ artifacts: { artifact_id: string }[] }>().artifacts;
      if (!artifacts.some((row) => row.artifact_id === artifactId)) throw new Error('artifact.comment did not imply reading the Artifact list');
      (await commenter.client.get(COMMENTS, { params })).status(200);
      (await reader.client.get(COMMENTS, { params })).status(200);
      (await reader.client.post(REPLIES, { body: 'Read-only agent.' }, thread())).status(403);
      (await commenter.client.patch(THREAD, { status: 'resolved' }, thread()))
        .status(403).body().has('$.code', 'artifact_comment_forbidden');
      (await commenter.client.patch(THREAD, { status: 'resolved' }, { params: { ...params, threadId: created.thread_id } }))
        .status(200).body().has('$.thread.resolved_by_session_id', commenter.sessionId);
      await withDb(ctx, (db) => db.query(
        `INSERT INTO kortix.artifact_comments (thread_id, author_session_id, body, deleted_at)
         SELECT $1, $2, CASE WHEN n = 1 THEN '' ELSE 'Earlier agent comment' END,
           CASE WHEN n = 1 THEN now() ELSE NULL END FROM generate_series(1, 29) AS n`,
        [created.thread_id, commenter.sessionId],
      ));
      (await commenter.client.post(REPLIES, { body: 'Comment 31 in one hour.' }, thread()))
        .status(429).headerEquals('retry-after', '3600');
    });

    await ctx.step('two concurrent writes after 59 in the current minute → one 201, one 429, one persisted comment and writes=60', async () => {
      await withDb(ctx, (db) => db.query(
        `INSERT INTO kortix.artifact_comment_write_limits (artifact_id, actor_key, window_started_at, writes)
         VALUES ($1, $2, now(), 59)
         ON CONFLICT (artifact_id, actor_key) DO UPDATE SET window_started_at = now(), writes = 59`,
        [artifactId, `user:${ctx.P.OWNER.userId}`],
      ));
      const bodies = ['Concurrent quota write A.', 'Concurrent quota write B.'];
      const replies = await Promise.all(bodies.map((body) => owner.post(REPLIES, { body }, thread())));
      const statuses = replies.map((reply) => reply.statusCode).sort().join(',');
      if (statuses !== '201,429') throw new Error(`concurrent quota returned ${statuses}, expected 201,429`);
      replies.find((reply) => reply.statusCode === 201)!.status(201);
      replies.find((reply) => reply.statusCode === 429)!.status(429).headerEquals('retry-after', '60');
      const persisted = await withDb(ctx, async (db) => (await db.query<{ writes: number; comments: number }>(
        `SELECT
           (SELECT writes FROM kortix.artifact_comment_write_limits WHERE artifact_id = $1 AND actor_key = $2) AS writes,
           (SELECT count(*)::int FROM kortix.artifact_comments WHERE thread_id = $3 AND body = ANY($4::text[])) AS comments`,
        [artifactId, `user:${ctx.P.OWNER.userId}`, threadId, bodies],
      )).rows[0]);
      if (persisted?.writes !== 60 || persisted.comments !== 1) throw new Error(`concurrent quota persisted ${JSON.stringify(persisted)}`);
      await withDb(ctx, (db) => db.query(
        'DELETE FROM kortix.artifact_comment_write_limits WHERE artifact_id = $1 AND actor_key = $2',
        [artifactId, `user:${ctx.P.OWNER.userId}`],
      ));
    });

    await ctx.step('turning artifacts off also disables comment routes even while artifact_comments remains on', async () => {
      (await owner.patch(FEATURES, { feature: 'artifacts', enabled: false }, { params: { projectId: project.id } })).status(200);
      (await owner.get(COMMENTS, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.patch(FEATURES, { feature: 'artifacts', enabled: true }, { params: { projectId: project.id } })).status(200);
      (await list()).status(200);
    });

    await ctx.step('PNG/WebP screenshot and normalized marks persist; every read rechecks view access and Storage known-key reads are denied', async () => {
      const privateParams = { ...params, artifactId: privateId };
      const created = (await owner.post(COMMENTS, { anchor: region, body: 'Drawn screenshot feedback.', marks, screenshot_base64: PNG }, { params: privateParams })).status(201).json<{ thread: Thread }>().thread;
      const comment = created.comments[0]!;
      const key = rememberScreenshot(comment);
      if (JSON.stringify(comment.marks) !== JSON.stringify(marks)) throw new Error('Marks did not round-trip');
      const path = `/projects/${project.id}/artifacts/${privateId}/comments/${comment.comment_id}/screenshot`;
      if (comment.screenshot_url !== path) throw new Error('Screenshot read URL must be the protected relative Artifact path');
      (await owner.get(SCREENSHOT, { params: { ...privateParams, commentId: comment.comment_id } })).status(200).headerEquals('content-type', 'image/png').headerEquals('cache-control', 'private, no-store');
      (await asMember.get(SCREENSHOT, { params: { ...privateParams, commentId: comment.comment_id } })).status(404).body().has('$.code', 'screenshot_not_found');
      (await ctx.client.as(ctx.P.NONMEMBER).get(SCREENSHOT, { params: { ...privateParams, commentId: comment.comment_id } })).status(404);
      const auth = ctx.P.OWNER.auth;
      if (auth.mode !== 'bearer') throw new Error('Owner JWT required for binary verification');
      await auth.ensureFresh?.();
      const binary = await fetch(`${ctx.env.apiUrl}${path}`, { headers: { Authorization: `Bearer ${auth.token}` }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      if (binary.status !== 200 || Buffer.from(await binary.arrayBuffer()).toString('base64') !== PNG || binary.headers.has('location')) throw new Error('Protected screenshot bytes changed or redirected');
      const jwt = member.auth;
      if (jwt.mode !== 'bearer') throw new Error('Member JWT required for Storage privacy verification');
      await jwt.ensureFresh?.();
      const headers = { apikey: ctx.env.supabaseAnonKey!, Authorization: `Bearer ${jwt.token}` };
      for (const [url, request] of [
        [storageUrl(key, 'authenticated/'), { headers }],
        [storageUrl(key, 'public/'), { headers: { apikey: ctx.env.supabaseAnonKey! } }],
        [storageUrl(key, 'sign/'), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }) }],
      ] as const) {
        const denied = await fetch(url, { ...request, signal: AbortSignal.timeout(20_000) });
        if (denied.ok) throw new Error('Generic Storage bypasses Artifact screenshot permissions');
      }
      (await owner.patch(ARTIFACT, { shared_with_user_ids: [member.userId!] }, { params: privateParams })).status(200);
      (await asMember.get(SCREENSHOT, { params: { ...privateParams, commentId: comment.comment_id } })).status(200);
      (await owner.patch(ARTIFACT, { shared_with_user_ids: [] }, { params: privateParams })).status(200);
      (await asMember.get(SCREENSHOT, { params: { ...privateParams, commentId: comment.comment_id } })).status(404);
      const reply = (await owner.post(REPLIES, { body: 'WebP screenshot reply.', marks, screenshot_base64: `data:image/webp;base64,${WEBP}` }, { params: { ...privateParams, threadId: created.thread_id } })).status(201).json<{ comment: Comment }>().comment;
      const replyKey = rememberScreenshot(reply);
      (await owner.get(SCREENSHOT, { params: { ...privateParams, commentId: reply.comment_id } })).status(200).headerEquals('content-type', 'image/webp');
      (await owner.patch(COMMENT, { body: 'Edited text only.' }, { params: { ...privateParams, threadId: created.thread_id, commentId: comment.comment_id } })).status(200).body().has('$.comment.screenshot_key', key);
      (await owner.del(COMMENT, { params: { ...privateParams, threadId: created.thread_id, commentId: reply.comment_id } })).status(200).body().has('$.comment.screenshot_key', null);
      (await owner.get(SCREENSHOT, { params: { ...privateParams, commentId: reply.comment_id } })).status(404);
      await objectAbsent(replyKey);
    });

    await ctx.step('decoded screenshot2MiB cap, type/magic mismatch and bounded marks reject; capture failure still saves marks without an image', async () => {
      const privateParams = { ...params, artifactId: privateId };
      for (const screenshot_base64 of [Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'), 'data:image/svg+xml;base64,PHN2Zy8+', `data:image/webp;base64,${PNG}`, Buffer.from(PNG, 'base64').subarray(0, 20).toString('base64')]) {
        (await owner.post(COMMENTS, { anchor: region, body: 'Invalid screenshot.', screenshot_base64 }, { params: privateParams })).status(413).body().has('$.code', 'screenshot_too_large');
      }
      (await owner.post(COMMENTS, { anchor: region, body: 'Invalid marks.', marks: [{ ...marks[0], points: [{ x: -1, y: 0 }, { x: 1, y: 1 }] }] }, { params: privateParams })).status(400).body().has('$.code', 'invalid_marks');
      const saved = (await owner.post(COMMENTS, { anchor: region, body: 'Capture failed but the drawing survives.', marks }, { params: privateParams })).status(201).json<{ thread: Thread }>().thread.comments[0]!;
      if (saved.screenshot_key !== null || saved.screenshot_url || JSON.stringify(saved.marks) !== JSON.stringify(marks)) throw new Error('Capture failure lost marks or invented an image');
      (await owner.get(SCREENSHOT, { params: { ...privateParams, commentId: saved.comment_id } })).status(404);
      (await owner.del(ARTIFACT, { params: privateParams })).status(200);
      for (const key of screenshotKeys) await objectAbsent(key);
    });

    await ctx.step('project deletion releases screenshot objects before its tombstone; authenticated known URLs then return404', async () => {
      const purge = await team.project({ name: 'Screenshot purge' });
      screenshotProjects.add(purge.id);
      const id = randomUUID(), drive = randomUUID();
      await withDb(ctx, async db => {
        await db.query("INSERT INTO kortix.drives(drive_id,account_id,project_id,kind,name,platinum_volume_name) VALUES($1,$2,$3,'project','Screenshot purge',$4)", [drive, team.id, purge.id, `screenshot-purge-${drive}`]);
        await db.query("INSERT INTO kortix.artifacts(artifact_id,project_id,account_id,drive_id,root,entry,folder,title,type,visibility,created_by_user_id) VALUES($1,$2,$3,$4,'/screenshots','index.html',true,'Screenshot purge','html','project',$5)", [id, purge.id, team.id, drive, ctx.P.OWNER.userId]);
      });
      for (const feature of ['artifacts', 'artifact_comments']) (await owner.patch(FEATURES, { feature, enabled: true }, { params: { projectId: purge.id } })).status(200);
      const purgeParams = { projectId: purge.id, artifactId: id };
      const picture = (await owner.post(COMMENTS, { anchor: region, body: 'Erase this screenshot with the project.', marks, screenshot_base64: PNG }, { params: purgeParams })).status(201).json<{ thread: Thread }>().thread.comments[0]!;
      const key = rememberScreenshot(picture);
      (await owner.del('/v1/projects/:projectId', { params: { projectId: purge.id } })).status(200);
      (await owner.get(SCREENSHOT, { params: { ...purgeParams, commentId: picture.comment_id } })).status(404);
      await objectAbsent(key);
    });

    await ctx.step('OWNER unshares the Artifact → 200; comment routes → 404 and both comment tables contain no rows for it', async () => {
      const threadIds = (await list()).status(200).json<{ threads: Thread[] }>().threads.map((row) => row.thread_id);
      (await owner.del(ARTIFACT, { params })).status(200);
      (await owner.get(COMMENTS, { params })).status(404);
      const counts = await withDb(ctx, async (db) => (await db.query<{ threads: string; comments: string }>(
        `SELECT
           (SELECT count(*) FROM kortix.artifact_comment_threads WHERE artifact_id = $1) AS threads,
           (SELECT count(*) FROM kortix.artifact_comments WHERE thread_id = ANY($2::uuid[])) AS comments`,
        [artifactId, threadIds],
      )).rows[0]);
      if (counts?.threads !== '0' || counts.comments !== '0') throw new Error(`unshare left comment data: ${JSON.stringify(counts)}`);
    });
  } finally {
    let cleanupError: unknown;
    try {
      const receipts = await withDb(ctx, async db => (await db.query<{ object_key: string }>('SELECT object_key FROM kortix.artifact_comment_screenshot_objects WHERE project_id=ANY($1::uuid[])', [[...screenshotProjects]])).rows);
      for (const row of receipts) screenshotKeys.add(row.object_key);
      if (screenshotKeys.size) {
        const response = await fetch(`${ctx.env.supabaseUrl}/storage/v1/object/session-attachments`, { method: 'DELETE', headers: { ...serviceHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [...screenshotKeys] }), signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`Screenshot cleanup failed${response.status}`);
        for (const key of screenshotKeys) await objectAbsent(key);
      }
    } catch (error) { cleanupError = error; }
    await world.close();
    if (cleanupError) throw cleanupError;
  }
});
