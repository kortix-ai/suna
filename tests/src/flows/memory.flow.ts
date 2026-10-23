/**
 * MEMORY-1..13 — Memory pages (`project_channels`): `/v1/projects/:projectId/memory/*`
 * and "Used memory" (`/sessions/:sessionId/memory-usage`).
 * Spec: tests/spec/end-to-end.md § 7b. Source of truth: apps/api/src/memory/ and
 * apps/api/src/projects/routes/project-memory.ts; shapes in
 * packages/api-contract/src/memory.ts. Pure rules (byte cap, secret shapes,
 * merge, undo plan, render, import mapping) are pinned by the unit tests next
 * to them; these flows prove the HTTP contract.
 *
 * An agent's thread is a `project_sessions` row in a space plus a project
 * token bound to it: the credential kortixd's `remember` tool sends. Only
 * MEMORY-13 starts a sandbox: the "Used memory" record is written by the turn
 * hook on the sandbox proxy, which no flow reaches without a real box.
 */
import { randomUUID } from 'node:crypto';
import {
  MemoryChangeListSchema,
  MemorySearchResultSchema,
  MemoryUsageSchema,
  MemoryDeleteResultSchema,
  MemoryLayerExportSchema,
  MemoryLayerSchema,
  MemoryPageListSchema,
  MemoryPageSchema,
  MemoryRememberResultSchema,
  MemoryUndoResultSchema,
  MemoryVersionListSchema,
  type MemoryChange,
  type MemoryLayer,
  type MemoryLayerExport,
  type MemoryPage,
  type MemoryPageSummary,
  type MemoryRememberResult,
  type MemorySearchHit,
  type MemoryUsage,
  type MemoryVersion,
} from '@kortix/api-contract';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import { isKe2eRetryableError, type Client, type Res } from '../core/client';
import type { BodyAssert } from '../core/expect';
import type { FlowContext, FlowMeta } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { endedAfter, readTranscript, readTurn, sendPrompt, waitForSessionReady, waitForTurn } from '../fixtures/session-run';

const R = {
  layer: 'GET /v1/projects/:projectId/memory/layers/:layerKey',
  pages: 'GET /v1/projects/:projectId/memory/layers/:layerKey/pages',
  create: 'POST /v1/projects/:projectId/memory/layers/:layerKey/pages',
  note: 'POST /v1/projects/:projectId/memory/layers/:layerKey/notes',
  changes: 'GET /v1/projects/:projectId/memory/layers/:layerKey/changes',
  page: 'GET /v1/projects/:projectId/memory/pages/:pageId',
  update: 'PATCH /v1/projects/:projectId/memory/pages/:pageId',
  remove: 'DELETE /v1/projects/:projectId/memory/pages/:pageId',
  history: 'GET /v1/projects/:projectId/memory/pages/:pageId/history',
  restore: 'POST /v1/projects/:projectId/memory/pages/:pageId/restore',
  undo: 'POST /v1/projects/:projectId/memory/versions/:versionId/undo',
  remember: 'POST /v1/projects/:projectId/memory/remember',
  export: 'GET /v1/projects/:projectId/memory/layers/:layerId/export',
  search: 'GET /v1/projects/:projectId/memory/search',
  usage: 'GET /v1/projects/:projectId/sessions/:sessionId/memory-usage',
} as const;
const FEATURES = 'PATCH /v1/projects/:projectId/features';
const SPACE_CREATE = 'POST /v1/projects/:projectId/spaces';
const SPACE_UPDATE = 'PATCH /v1/projects/:projectId/spaces/:spaceId';
const SPACE_DM = 'POST /v1/projects/:projectId/spaces/dm';
const TOKEN_MINT = 'POST /v1/projects/:projectId/cli-token';

const LAYER = '/v1/projects/:projectId/memory/layers/:layerKey';
const PAGES = '/v1/projects/:projectId/memory/layers/:layerKey/pages';
const NOTES = '/v1/projects/:projectId/memory/layers/:layerKey/notes';
const CHANGES = '/v1/projects/:projectId/memory/layers/:layerKey/changes';
const PAGE = '/v1/projects/:projectId/memory/pages/:pageId';
const HISTORY = '/v1/projects/:projectId/memory/pages/:pageId/history';
const RESTORE = '/v1/projects/:projectId/memory/pages/:pageId/restore';
const UNDO = '/v1/projects/:projectId/memory/versions/:versionId/undo';
const REMEMBER = '/v1/projects/:projectId/memory/remember';
const EXPORT = '/v1/projects/:projectId/memory/layers/:layerId/export';
const SEARCH = '/v1/projects/:projectId/memory/search';
const USAGE = '/v1/projects/:projectId/sessions/:sessionId/memory-usage';
const SESSIONS = '/v1/projects/:projectId/sessions';
const SPACES = '/v1/projects/:projectId/spaces';
const SPACE = '/v1/projects/:projectId/spaces/:spaceId';
const DM = '/v1/projects/:projectId/spaces/dm';

const MANIFEST =
  'kortix_version: 2\nproject:\n  name: ke2e-memory\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n';
const PRIVATE_THREAD = 'a private thread';
const COPY = '/opt/kortix/memory';

/**
 * Credential shapes the secret check refuses, built at run time so no
 * scanner reads a key in this file. Synthetic values: they open nothing.
 */
const FAKE_KEY = ['sk', 'proj', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('-');
const FAKE_ASSIGNMENT = ['pass', 'word', '=', 'Hunter2', 'Northwind'].join('');
/** Ordinary prose with the words a naive check refuses: it must pass. */
const ORDINARY = 'The password reset flow emails a token link; risk-management-framework rules apply; the bearer of bad news is Priya.';

const meta = (routes: string[], extra: Partial<FlowMeta> = {}): FlowMeta => ({
  domain: 'memory',
  requires: ['database'],
  timeoutMs: 120_000,
  routes,
  ...extra,
});

async function openWorld(ctx: FlowContext, opts: { manifest?: boolean } = {}) {
  const team = await ctx.fixtures.team();
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  if (opts.manifest) await world.writeManifest(MANIFEST, 'ke2e: memory agent');
  return { team, project, world };
}

type Space = { space_id: string; slug: string | null };

async function channel(world: AgentPrincipalsWorld, name: string): Promise<Space> {
  return (await world.owner.post(SPACES, { name }, { params: { projectId: world.projectId } })).status(201).json<Space>();
}

interface Thread {
  sessionId: string;
  client: Client;
}

/**
 * An agent thread: a session row in `spaceId` (agent `kortix`, owned by
 * OWNER) and a project token bound to it, the credential an agent's
 * `KORTIX_TOKEN` is. `world.close()` deletes both.
 */
async function thread(
  ctx: FlowContext,
  world: AgentPrincipalsWorld,
  input: { projectId?: string; spaceId: string | null; visibility: 'project' | 'private'; firstPrompt: string },
): Promise<Thread> {
  const projectId = input.projectId ?? world.projectId;
  const sessionId = randomUUID();
  world.sessions.push(sessionId);
  await world.db.query(
    `INSERT INTO kortix.project_sessions
       (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, space_id, metadata)
     VALUES ($1, $2, $3, $1, 'kortix', 'stopped', $4, $5::kortix.project_session_visibility, $6, $7::jsonb)`,
    [sessionId, world.accountId, projectId, world.ownerUserId, input.visibility, input.spaceId, JSON.stringify({ first_prompt: input.firstPrompt })],
  );
  const minted = (await world.owner.post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('memory') }, { params: { projectId } }))
    .status(201)
    .json<{ token_id: string; secret_key: string }>();
  world.tokens.push(minted.token_id);
  await world.db.query(
    `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
     VALUES ($1::uuid, $1, $2, $3, 'provisioning') ON CONFLICT (sandbox_id) DO NOTHING`,
    [sessionId, world.accountId, projectId],
  );
  await world.db.query('UPDATE kortix.account_tokens SET session_id = $2 WHERE token_id = $1::uuid', [minted.token_id, sessionId]);
  return { sessionId, client: ctx.client.withBearer(minted.secret_key, `thread ${sessionId.slice(0, 8)}`) };
}

/** Assert the body of `res` with `check`, then return it. */
function read<T>(res: Res, check: (body: BodyAssert) => unknown): T {
  check(res.body());
  return res.json<T>();
}

function fail(what: string, detail: unknown): never {
  throw new Error(`${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1_200)}`);
}

// ─────────────────────────────────────────────────────────────────────────────

flow('MEMORY-1', meta([...Object.values(R), FEATURES]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const projectId = project.id;
  const id = randomUUID();
  const everyRoute = () =>
    Promise.all([
      world.owner.get(LAYER, { params: { projectId, layerKey: 'company' } }),
      world.owner.get(PAGES, { params: { projectId, layerKey: 'company' } }),
      world.owner.post(PAGES, { type: 'people', title: 'Priya' }, { params: { projectId, layerKey: 'company' } }),
      world.owner.post(NOTES, { text: 'Launch moves to Nov 19' }, { params: { projectId, layerKey: 'company' } }),
      world.owner.get(CHANGES, { params: { projectId, layerKey: 'company' } }),
      world.owner.get(PAGE, { params: { projectId, pageId: id } }),
      world.owner.patch(PAGE, { base_version: 1, body: 'x' }, { params: { projectId, pageId: id } }),
      world.owner.del(PAGE, { params: { projectId, pageId: id } }),
      world.owner.get(HISTORY, { params: { projectId, pageId: id } }),
      world.owner.post(RESTORE, { version_id: randomUUID() }, { params: { projectId, pageId: id } }),
      world.owner.post(UNDO, undefined, { params: { projectId, versionId: id } }),
      world.owner.post(REMEMBER, { title: 'Priya', type: 'people', fact: 'Approves launch copy' }, { params: { projectId } }),
      world.owner.get(EXPORT, { params: { projectId, layerId: id } }),
      world.owner.get(SEARCH, { params: { projectId }, query: { q: 'Pricing' } }),
      world.owner.get(USAGE, { params: { projectId, sessionId: id } }),
    ]);
  try {
    await ctx.step('with project_channels off (the default), all 15 memory routes → 403 {code: feature_disabled, feature: project_channels}', async () => {
      for (const r of await everyRoute()) r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'project_channels');
    });

    await ctx.step('the refused calls stored nothing: the project has no memory layer row', async () => {
      const { rows } = await world.db.query('SELECT 1 FROM kortix.memory_layers WHERE project_id = $1', [projectId]);
      if (rows.length !== 0) fail('memory layers stored while the flag is off', rows.length);
    });

    await ctx.step('an anonymous caller → 401; a non-member → 403/404', async () => {
      (await ctx.client.as(ctx.P.ANON).get(LAYER, { params: { projectId, layerKey: 'company' } })).status(401);
      (await ctx.client.as(ctx.P.NONMEMBER).get(LAYER, { params: { projectId, layerKey: 'company' } })).status([403, 404]);
    });

    let pageId = '';
    await ctx.step('flag on: a Company page is created → 201', async () => {
      await world.setFeature('project_channels', true);
      const r = await world.owner.post(PAGES, { type: 'decisions', title: 'Pricing', body: 'Plans stay at $49.' }, { params: { projectId, layerKey: 'company' } });
      pageId = read<MemoryPage>(r.status(201), (b) => b.schema(MemoryPageSchema)).page_id;
    });

    await ctx.step('flag off again: every memory route → 403 feature_disabled, and the page row stays', async () => {
      await world.setFeature('project_channels', false);
      for (const r of await everyRoute()) r.status(403).body().has('$.code', 'feature_disabled');
      (await world.owner.get(PAGE, { params: { projectId, pageId } })).status(403).body().has('$.code', 'feature_disabled');
      const { rows } = await world.db.query('SELECT 1 FROM kortix.memory_pages WHERE page_id = $1 AND deleted_at IS NULL', [pageId]);
      if (rows.length !== 1) fail('turning the flag off removed the page', rows.length);
    });

    await ctx.step('flag on once more: the page reads back unchanged', async () => {
      await world.setFeature('project_channels', true);
      (await world.owner.get(PAGE, { params: { projectId, pageId } }))
        .status(200).body().has('$.title', 'Pricing').has('$.body', 'Plans stay at $49.').has('$.version_no', 1);
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-2', meta([R.layer, R.pages, R.create, R.note, R.page, R.update, R.remove, R.history, FEATURES, SPACE_CREATE, SPACE_UPDATE, SPACE_DM]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { manifest: true });
  const projectId = project.id;
  const layerOf = (client: Client, layerKey: string) => client.get(LAYER, { params: { projectId, layerKey } });
  try {
    await world.setFeature('project_channels', true);
    const launch = await channel(world, 'Launch');
    const member = await team.addMember('member');
    await team.grantProjectRole(projectId, member.userId!, 'member');
    const asMember = ctx.client.as(member);

    let company: MemoryLayer;
    await ctx.step('GET layers/company → 200, made on first read: {scope: company, name: Company, space_id: null}, every count 0, writable', async () => {
      const r = await layerOf(world.owner, 'company');
      company = read<MemoryLayer>(r.status(200), (b) => b.schema(MemoryLayerSchema)
        .has('$.scope', 'company').has('$.name', 'Company').has('$.space_id', null)
        .has('$.counts', { people: 0, decisions: 0, workstreams: 0, playbooks: 0, note: 0, unconfirmed: 0, trash: 0 })
        .has('$.read_only', false).has('$.can_write', true));
    });

    await ctx.step('a second read returns the same layer_id; with Files off the layer is marked imported at once (no Drive import job)', async () => {
      (await layerOf(world.owner, 'company')).status(200).body().has('$.layer_id', company!.layer_id);
      const { rows } = await world.db.query<{ imported: boolean; jobs: number }>(
        `SELECT imported_at IS NOT NULL AS imported,
                (SELECT count(*)::int FROM kortix.job_queue WHERE queue = 'memory-import' AND job_key = $1::text) AS jobs
           FROM kortix.memory_layers WHERE layer_id = $1::uuid`,
        [company!.layer_id],
      );
      if (!rows[0]?.imported || rows[0].jobs !== 0) fail('a Files-off layer was not marked imported, or queued an import', rows[0]);
    });

    let channelLayer: MemoryLayer;
    await ctx.step('GET layers/<channel space_id> → 200 {scope: channel, name: "#launch", space_id}', async () => {
      channelLayer = read<MemoryLayer>((await layerOf(world.owner, launch.space_id))
        .status(200), (b) => b.schema(MemoryLayerSchema)
        .has('$.scope', 'channel').has('$.name', '#launch').has('$.space_id', launch.space_id).has('$.can_write', true));
    });

    let dmId = '';
    let dmPageId = '';
    await ctx.step("the caller's own DM layer → 200 {scope: dm, name: kortix}; a page saved there reads back", async () => {
      dmId = (await world.owner.post(DM, { agent_name: 'kortix' }, { params: { projectId } })).status(200).json<Space>().space_id;
      (await layerOf(world.owner, dmId)).status(200).body().schema(MemoryLayerSchema).has('$.scope', 'dm').has('$.name', 'kortix').has('$.space_id', dmId);
      dmPageId = (await world.owner.post(PAGES, { type: 'playbooks', title: 'Tone', body: 'Keep replies short.' }, { params: { projectId, layerKey: dmId } }))
        .status(201).json<MemoryPage>().page_id;
    });

    await ctx.step('a malformed layer key and an unknown space id → 404 memory_not_found', async () => {
      for (const key of ['not-a-uuid', randomUUID()]) (await layerOf(world.owner, key)).status(404).body().has('$.code', 'memory_not_found');
    });

    await ctx.step("another project member: their DM-less view of the owner's DM layer → 404 memory_not_found (never 403)", async () => {
      (await layerOf(asMember, dmId)).status(404).body().has('$.code', 'memory_not_found');
      (await asMember.get(PAGES, { params: { projectId, layerKey: dmId } })).status(404).body().has('$.code', 'memory_not_found');
      (await asMember.post(PAGES, { type: 'people', title: 'Intruder' }, { params: { projectId, layerKey: dmId } })).status(404);
      (await asMember.post(NOTES, { text: 'x' }, { params: { projectId, layerKey: dmId } })).status(404);
    });

    await ctx.step("the member reads, edits and deletes a page of the owner's DM by id → 404 memory_not_found each", async () => {
      const p = { params: { projectId, pageId: dmPageId } };
      (await asMember.get(PAGE, p)).status(404).body().has('$.code', 'memory_not_found');
      (await asMember.get(HISTORY, p)).status(404).body().has('$.code', 'memory_not_found');
      (await asMember.patch(PAGE, { base_version: 1, body: 'x' }, p)).status(404).body().has('$.code', 'memory_not_found');
      (await asMember.del(PAGE, p)).status(404).body().has('$.code', 'memory_not_found');
      (await world.owner.get(PAGE, p)).status(200).body().has('$.body', 'Keep replies short.').has('$.version_no', 1);
    });

    let ownerPageId = '';
    await ctx.step('channel visibility: the member sees the Company and #launch layers, writable, and the owner’s #launch page', async () => {
      ownerPageId = (await world.owner.post(PAGES, { type: 'workstreams', title: 'Q4 Launch', body: '## Status\n\n- Draft' }, { params: { projectId, layerKey: launch.space_id } }))
        .status(201).json<MemoryPage>().page_id;
      (await layerOf(asMember, 'company')).status(200).body().has('$.layer_id', company!.layer_id).has('$.can_write', true);
      (await layerOf(asMember, launch.space_id)).status(200).body().has('$.layer_id', channelLayer!.layer_id).has('$.can_write', true);
      const listed = read<{ pages: MemoryPageSummary[] }>((await asMember.get(PAGES, { params: { projectId, layerKey: launch.space_id } }))
        .status(200), (b) => b.schema(MemoryPageListSchema)).pages;
      if (listed.map((p) => p.page_id).join() !== ownerPageId) fail('the member’s #launch list', listed);
    });

    await ctx.step("the member may edit the owner's page (can_edit) but not delete it: DELETE → 403 forbidden and the page stays", async () => {
      const p = { params: { projectId, pageId: ownerPageId } };
      (await asMember.get(PAGE, p)).status(200).body().has('$.can_edit', true).has('$.can_delete', false);
      (await asMember.patch(PAGE, { base_version: 1, body: '## Status\n\n- Copy approved' }, p)).status(200).body().has('$.version_no', 2);
      (await asMember.del(PAGE, p)).status(403).body().has('$.code', 'forbidden');
      (await world.owner.get(PAGE, p)).status(200).body().has('$.can_delete', true).has('$.body', '## Status\n\n- Copy approved');
    });

    await ctx.step('the member deletes a page they made → 200 {ok: true, version_id}', async () => {
      const own = read<MemoryPage>((await asMember.post(PAGES, { type: 'people', title: 'Mateo' }, { params: { projectId, layerKey: launch.space_id } }))
        .status(201), (b) => b.has('$.can_delete', true));
      (await asMember.del(PAGE, { params: { projectId, pageId: own.page_id } })).status(200).body().schema(MemoryDeleteResultSchema).has('$.ok', true);
    });

    await ctx.step('archive #launch → its layer reads {read_only: true, can_write: false}; pages still read', async () => {
      (await world.owner.patch(SPACE, { archived: true }, { params: { projectId, spaceId: launch.space_id } })).status(200);
      (await layerOf(world.owner, launch.space_id)).status(200).body().has('$.read_only', true).has('$.can_write', false);
      (await world.owner.get(PAGE, { params: { projectId, pageId: ownerPageId } })).status(200).body().has('$.can_edit', false).has('$.can_delete', false);
    });

    await ctx.step('archived #launch: create, note, edit and delete → 409 layer_read_only, and the page is unchanged', async () => {
      const layer = { params: { projectId, layerKey: launch.space_id } };
      const page = { params: { projectId, pageId: ownerPageId } };
      for (const r of [
        await world.owner.post(PAGES, { type: 'people', title: 'New' }, layer),
        await world.owner.post(NOTES, { text: 'One more fact' }, layer),
        await world.owner.patch(PAGE, { base_version: 2, body: 'changed' }, page),
        await world.owner.del(PAGE, page),
      ]) {
        r.status(409).body().has('$.code', 'layer_read_only');
      }
      (await world.owner.get(PAGE, page)).status(200).body().has('$.version_no', 2);
    });

    await ctx.step('unarchive #launch → writable again', async () => {
      (await world.owner.patch(SPACE, { archived: false }, { params: { projectId, spaceId: launch.space_id } })).status(200);
      (await layerOf(world.owner, launch.space_id)).status(200).body().has('$.read_only', false).has('$.can_write', true);
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-3', meta([R.layer, R.pages, R.create, R.note, R.page, R.update, R.remove, FEATURES, SPACE_CREATE]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const projectId = project.id;
  const company = { params: { projectId, layerKey: 'company' } };
  let fillerLayer = '';
  try {
    await world.setFeature('project_channels', true);
    const launch = await channel(world, 'Launch');
    const L = { params: { projectId, layerKey: launch.space_id } };

    let page: MemoryPage;
    await ctx.step('create a page → 201 {version_no: 1, can_edit, can_delete, updated_by.kind: person}', async () => {
      page = read<MemoryPage>((await world.owner.post(PAGES, { type: 'workstreams', title: 'Q4 Launch', summary: 'Status and owners', body: '## Status\n\n- Draft' }, L))
        .status(201), (b) => b.schema(MemoryPageSchema)
        .has('$.type', 'workstreams').has('$.title', 'Q4 Launch').has('$.version_no', 1)
        .has('$.can_edit', true).has('$.can_delete', true).has('$.updated_by.kind', 'person').has('$.updated_by.user_id', world.ownerUserId));
    });

    await ctx.step('the same title in another case and spacing → 409 {code: title_taken, page_id: <the live page>}', async () => {
      (await world.owner.post(PAGES, { type: 'decisions', title: '  q4   LAUNCH ' }, L)).status(409).body().has('$.code', 'title_taken').has('$.page_id', page!.page_id);
    });

    await ctx.step('a body of exactly 8,192 bytes → 201; 8,193 ASCII bytes and 4,097 two-byte characters (8,194 bytes) → 413 page_too_large', async () => {
      (await world.owner.post(PAGES, { type: 'playbooks', title: 'At the cap', body: 'a'.repeat(8192) }, L)).status(201);
      (await world.owner.post(PAGES, { type: 'playbooks', title: 'Over the cap', body: 'a'.repeat(8193) }, L)).status(413).body().has('$.code', 'page_too_large');
      (await world.owner.post(PAGES, { type: 'playbooks', title: 'Over in bytes', body: 'é'.repeat(4097) }, L)).status(413).body().has('$.code', 'page_too_large');
    });

    await ctx.step('a body or summary holding a key shape → 422 secret_detected, and the response does not echo the text', async () => {
      for (const body of [{ body: `use ${FAKE_KEY} for the API` }, { body: FAKE_ASSIGNMENT }, { summary: `key ${FAKE_KEY}` }]) {
        const r = await world.owner.post(PAGES, { type: 'decisions', title: 'Keys', ...body }, L);
        r.status(422).body().has('$.code', 'secret_detected');
        if (r.text().includes(FAKE_KEY) || r.text().includes(FAKE_ASSIGNMENT)) fail('the 422 echoes the secret', r.text());
      }
      const edit = await world.owner.patch(PAGE, { base_version: 1, body: `rotate ${FAKE_KEY}` }, { params: { projectId, pageId: page!.page_id } });
      edit.status(422).body().has('$.code', 'secret_detected');
    });

    await ctx.step('ordinary text with the words password, token and bearer, and a long hyphenated phrase → 201, stored as sent', async () => {
      (await world.owner.post(PAGES, { type: 'playbooks', title: 'Account help', body: ORDINARY }, L)).status(201).body().has('$.body', ORDINARY);
    });

    await ctx.step('bad input → 400 invalid_input: a two-line summary, a 121-character title, type note by hand, an unknown field', async () => {
      for (const body of [
        { type: 'decisions', title: 'Two lines', summary: 'a\nb' },
        { type: 'decisions', title: 'x'.repeat(121) },
        { type: 'note', title: 'By hand' },
        { type: 'decisions', title: 'Extra', status: 'unconfirmed' },
      ]) {
        (await world.owner.post(PAGES, body, L)).status(400).body().has('$.code', 'invalid_input');
      }
    });

    await ctx.step('PATCH with a stale base_version → 409 {code: version_conflict, version_no: 1}; with the current one → 200 version_no 2', async () => {
      const p = { params: { projectId, pageId: page!.page_id } };
      (await world.owner.patch(PAGE, { base_version: 9, body: 'x' }, p)).status(409).body().has('$.code', 'version_conflict').has('$.version_no', 1);
      (await world.owner.patch(PAGE, { base_version: 1, body: '## Status\n\n- Copy approved' }, p))
        .status(200).body().schema(MemoryPageSchema).has('$.version_no', 2).has('$.body', '## Status\n\n- Copy approved');
    });

    let trashed = '';
    await ctx.step('DELETE → 200 {ok: true, version_id}; the page lists only with deleted=1 and reads with can_edit false; counts.trash 1', async () => {
      trashed = (await world.owner.post(PAGES, { type: 'decisions', title: 'Discounts', body: 'No discounts in Q4.' }, L)).status(201).json<MemoryPage>().page_id;
      (await world.owner.del(PAGE, { params: { projectId, pageId: trashed } })).status(200).body().schema(MemoryDeleteResultSchema).has('$.ok', true);
      const live = (await world.owner.get(PAGES, L)).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      const trash = (await world.owner.get(PAGES, { ...L, query: { deleted: '1' } })).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      if (live.some((p) => p.page_id === trashed) || trash.map((p) => p.page_id).join() !== trashed) fail('trash listing', { live, trash });
      (await world.owner.get(PAGE, { params: { projectId, pageId: trashed } })).status(200).body().has('$.can_edit', false);
      (await world.owner.get(LAYER, L)).status(200).body().has('$.counts.trash', 1).has('$.counts.decisions', 0);
      (await world.owner.del(PAGE, { params: { projectId, pageId: trashed } })).status(404).body().has('$.code', 'memory_not_found');
    });

    await ctx.step('?type= filters the list: workstreams lists only "Q4 Launch"', async () => {
      (await world.owner.get(PAGES, { ...L, query: { type: 'workstreams' } }))
        .status(200).body().has('$.pages.length', 1).has('$.pages[0].page_id', page!.page_id);
    });

    await ctx.step('a layer holding 200 live pages refuses page 201 and a note → 409 page_limit; trashing one frees a slot', async () => {
      const first = (await world.owner.post(PAGES, { type: 'playbooks', title: 'Onboarding' }, company)).status(201).json<MemoryPage>();
      fillerLayer = first.layer_id;
      // 199 more live pages, inserted directly: making them over HTTP proves nothing more.
      await world.db.query(
        `INSERT INTO kortix.memory_pages (layer_id, project_id, type, title, title_key)
         SELECT $1, $2, 'playbooks', 'Filler ' || g, 'filler ' || g FROM generate_series(1, 199) g`,
        [fillerLayer, projectId],
      );
      (await world.owner.post(PAGES, { type: 'playbooks', title: 'One more' }, company)).status(409).body().has('$.code', 'page_limit');
      (await world.owner.post(NOTES, { text: 'One more note' }, company)).status(409).body().has('$.code', 'page_limit');
      (await world.owner.del(PAGE, { params: { projectId, pageId: first.page_id } })).status(200);
      (await world.owner.post(PAGES, { type: 'playbooks', title: 'One more' }, company)).status(201);
    });
  } finally {
    if (fillerLayer) await world.db.query("DELETE FROM kortix.memory_pages WHERE layer_id = $1 AND title LIKE 'Filler %'", [fillerLayer]).catch(() => {});
    await world.close();
  }
});

flow('MEMORY-4', meta([R.create, R.changes, R.page, R.update, R.history, R.restore, R.undo, R.pages, FEATURES]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const projectId = project.id;
  const company = { params: { projectId, layerKey: 'company' } };
  try {
    await world.setFeature('project_channels', true);

    let pageId = '';
    const p = () => ({ params: { projectId, pageId } });
    await ctx.step('create a page, then 3 edits (body, summary, title) → version_no 4', async () => {
      pageId = (await world.owner.post(PAGES, { type: 'workstreams', title: 'Q4 Launch', summary: 'Owners', body: '- Draft' }, company)).status(201).json<MemoryPage>().page_id;
      (await world.owner.patch(PAGE, { base_version: 1, body: '- Copy approved' }, p())).status(200);
      (await world.owner.patch(PAGE, { base_version: 2, summary: 'Owners and dates' }, p())).status(200);
      (await world.owner.patch(PAGE, { base_version: 3, title: 'Q4 Launch plan' }, p())).status(200).body().has('$.version_no', 4);
    });

    let versions: MemoryVersion[] = [];
    await ctx.step('history → 4 versions newest first (4,3,2,1; ops update×3 then create), next null; only the newest is undoable', async () => {
      const body = read<{ versions: MemoryVersion[] }>((await world.owner.get(HISTORY, p())).status(200), (b) => b.schema(MemoryVersionListSchema).has('$.next', null));
      versions = body.versions;
      if (versions.map((v) => v.version_no).join() !== '4,3,2,1') fail('history order', versions.map((v) => v.version_no));
      if (versions.map((v) => v.op).join() !== 'update,update,update,create') fail('history ops', versions.map((v) => v.op));
      if (versions.map((v) => v.can_undo).join() !== 'true,false,false,false') fail('can_undo', versions.map((v) => v.can_undo));
      if (versions[3]!.snapshot.body !== '- Draft' || versions[0]!.snapshot.title !== 'Q4 Launch plan') fail('snapshots', versions);
      if (versions.some((v) => v.author.kind !== 'person' || v.author.user_id !== world.ownerUserId)) fail('authors', versions.map((v) => v.author));
    });

    await ctx.step('history pages with limit and before: limit=1 → v4 and a cursor; before=<cursor> → v3; a malformed before → 400', async () => {
      const first = (await world.owner.get(HISTORY, { ...p(), query: { limit: 1 } })).status(200).json<{ versions: MemoryVersion[]; next: string | null }>();
      if (first.versions.length !== 1 || first.versions[0]!.version_no !== 4 || !first.next) fail('first history page', first);
      const second = (await world.owner.get(HISTORY, { ...p(), query: { limit: 1, before: first.next } })).status(200).json<{ versions: MemoryVersion[] }>();
      if (second.versions[0]?.version_no !== 3) fail('second history page', second);
      (await world.owner.get(HISTORY, { ...p(), query: { before: 'nope' } })).status(400);
    });

    let restoreVersion = '';
    await ctx.step('restore v1 → 200 with v1 title, summary and body, version_no 5; the newest history entry is op restore', async () => {
      (await world.owner.post(RESTORE, { version_id: versions[3]!.version_id }, p()))
        .status(200).body().schema(MemoryPageSchema)
        .has('$.title', 'Q4 Launch').has('$.summary', 'Owners').has('$.body', '- Draft').has('$.version_no', 5);
      const top = (await world.owner.get(HISTORY, { ...p(), query: { limit: 1 } })).status(200).json<{ versions: MemoryVersion[] }>().versions[0]!;
      if (top.op !== 'restore') fail('restore op', top);
      restoreVersion = top.version_id;
    });

    await ctx.step('undo the restore → 200 {pages: [the page as at v4]}', async () => {
      (await world.owner.post(UNDO, undefined, { params: { projectId, versionId: restoreVersion } }))
        .status(200).body().schema(MemoryUndoResultSchema)
        .has('$.pages.length', 1).has('$.pages[0].page_id', pageId)
        .has('$.pages[0].title', 'Q4 Launch plan').has('$.pages[0].summary', 'Owners and dates').has('$.pages[0].body', '- Copy approved');
    });

    await ctx.step('undo an older version (v2) → 409 superseded; undo the restore again → 409 already_undone; an unknown version → 404', async () => {
      (await world.owner.post(UNDO, undefined, { params: { projectId, versionId: versions[2]!.version_id } })).status(409).body().has('$.code', 'superseded');
      (await world.owner.post(UNDO, undefined, { params: { projectId, versionId: restoreVersion } })).status(409).body().has('$.code', 'already_undone');
      (await world.owner.post(UNDO, undefined, { params: { projectId, versionId: randomUUID() } })).status(404).body().has('$.code', 'memory_not_found');
      (await world.owner.get(PAGE, p())).status(200).body().has('$.title', 'Q4 Launch plan');
    });

    await ctx.step('the history marks the undone restore: undone true, can_undo false', async () => {
      const all = (await world.owner.get(HISTORY, p())).status(200).json<{ versions: MemoryVersion[] }>().versions;
      const restored = all.find((v) => v.version_id === restoreVersion);
      if (!restored?.undone || restored.can_undo) fail('the undone restore', restored);
    });

    let scratch = '';
    await ctx.step('undo of a create → 200 {pages: []}; the page is in the trash', async () => {
      const made = (await world.owner.post(PAGES, { type: 'decisions', title: 'Scratch' }, company)).status(201).json<MemoryPage>();
      scratch = made.page_id;
      const created = (await world.owner.get(HISTORY, { params: { projectId, pageId: scratch } })).status(200).json<{ versions: MemoryVersion[] }>().versions[0]!;
      (await world.owner.post(UNDO, undefined, { params: { projectId, versionId: created.version_id } })).status(200).body().has('$.pages', []);
      const trash = (await world.owner.get(PAGES, { ...company, query: { deleted: '1' } })).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      if (!trash.some((x) => x.page_id === scratch)) fail('the undone create is not in the trash', trash);
    });

    await ctx.step('Recent changes → newest first: undo, create, undo, restore, update×3, create, each with its person author', async () => {
      const body = read<{ changes: MemoryChange[] }>((await world.owner.get(CHANGES, company)).status(200), (b) => b.schema(MemoryChangeListSchema).has('$.next', null));
      const ops = body.changes.map((c) => c.op).join();
      if (ops !== 'undo,create,undo,restore,update,update,update,create') fail('Recent changes ops', ops);
      if (body.changes.some((c) => c.author.kind !== 'person' || c.author.user_id !== world.ownerUserId || !c.author.name)) fail('change authors', body.changes.map((c) => c.author));
      if (body.changes[0]!.page_id !== scratch || body.changes[0]!.page_title !== 'Scratch') fail('newest change', body.changes[0]);
    });

    await ctx.step('Recent changes pages by 3 with before: 3 + 3 + 2 rows, every change once, the last page has next null', async () => {
      const seen: string[] = [];
      let before: string | undefined;
      const sizes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const page = (await world.owner.get(CHANGES, { ...company, query: { limit: 3, before } })).status(200).json<{ changes: MemoryChange[]; next: string | null }>();
        sizes.push(page.changes.length);
        seen.push(...page.changes.map((c) => c.version_id));
        if (!page.next) break;
        before = page.next;
      }
      if (sizes.join() !== '3,3,2' || new Set(seen).size !== 8) fail('change paging', { sizes, seen });
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-5', meta([R.note, R.page, R.pages, R.layer, FEATURES, SPACE_CREATE, TOKEN_MINT]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const projectId = project.id;
  try {
    await world.setFeature('project_channels', true);
    const launch = await channel(world, 'Launch');
    const L = { params: { projectId, layerKey: launch.space_id } };
    const member = await team.addMember('member');
    await team.grantProjectRole(projectId, member.userId!, 'member');
    const asMember = ctx.client.as(member);

    await ctx.step('a Remember-box note → 201 {type: note, title: the text, body: "<text> ⟦1⟧"}, one source {kind: person, label: the caller’s name}', async () => {
      const note = read<MemoryPage>((await world.owner.post(NOTES, { text: '  Our launch date is Nov 12  ' }, L))
        .status(201), (b) => b.schema(MemoryPageSchema)
        .has('$.type', 'note').has('$.title', 'Our launch date is Nov 12').has('$.body', 'Our launch date is Nov 12 ⟦1⟧')
        .has('$.sources.length', 1).has('$.sources[0].number', 1).has('$.sources[0].kind', 'person').has('$.sources[0].session_id', null));
      if (!note.sources[0]!.label || note.sources[0]!.label !== note.updated_by.name) fail('the note source names the caller', note);
    });

    await ctx.step('a note over 80 characters is titled by its first 79 and an ellipsis; the layer counts note 2 and ?type=note lists both', async () => {
      const text = `${'Northwind '.repeat(10)}renewal is in March.`;
      (await world.owner.post(NOTES, { text }, L)).status(201).body().has('$.title', `${text.slice(0, 79).trimEnd()}…`);
      (await world.owner.get(LAYER, L)).status(200).body().has('$.counts.note', 2);
      (await world.owner.get(PAGES, { ...L, query: { type: 'note' } })).status(200).body().has('$.pages.length', 2);
    });

    await ctx.step('a note of 1,001 characters, a blank note and an unknown field → 400 invalid_input; 1,000 characters → 201', async () => {
      for (const body of [{ text: 'x'.repeat(1001) }, { text: '   ' }, { text: 'ok', pinned: true }]) {
        (await world.owner.post(NOTES, body, L)).status(400).body().has('$.code', 'invalid_input');
      }
      (await world.owner.post(NOTES, { text: 'y'.repeat(1000) }, L)).status(201);
    });

    await ctx.step('a note holding a key shape → 422 secret_detected; ordinary words pass → 201', async () => {
      (await world.owner.post(NOTES, { text: `the key is ${FAKE_KEY}` }, L)).status(422).body().has('$.code', 'secret_detected');
      (await world.owner.post(NOTES, { text: ORDINARY }, L)).status(201);
    });

    const ownersPrivate = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'private', firstPrompt: 'Draft the Northwind pricing memo' });
    const shared = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'project', firstPrompt: 'Review the launch checklist' });

    await ctx.step("source_session_id of the caller's own private thread → 201, the source carries the thread", async () => {
      (await world.owner.post(NOTES, { text: 'Pricing memo is due Friday', source_session_id: ownersPrivate.sessionId }, L))
        .status(201).body().has('$.sources[0].session_id', ownersPrivate.sessionId).has('$.updated_source.session_id', ownersPrivate.sessionId);
    });

    await ctx.step("another member naming the owner's private thread, or an unknown thread → 404 session_not_found, and no note is saved", async () => {
      const before = (await asMember.get(LAYER, L)).status(200).json<MemoryLayer>().counts.note;
      (await asMember.post(NOTES, { text: 'Leak the memo', source_session_id: ownersPrivate.sessionId }, L)).status(404).body().has('$.code', 'session_not_found');
      (await asMember.post(NOTES, { text: 'Ghost thread', source_session_id: randomUUID() }, L)).status(404).body().has('$.code', 'session_not_found');
      (await asMember.get(LAYER, L)).status(200).body().has('$.counts.note', before);
    });

    await ctx.step('the member names a project-visible thread → 201 with that thread as the source', async () => {
      (await asMember.post(NOTES, { text: 'Checklist owner is Mateo', source_session_id: shared.sessionId }, L))
        .status(201).body().has('$.sources[0].session_id', shared.sessionId).has('$.sources[0].kind', 'person');
    });

    await ctx.step("the member reads the owner's note from the private thread: the source has no thread id, and updated_source is null", async () => {
      const notes = (await asMember.get(PAGES, { ...L, query: { type: 'note' } })).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      const memo = notes.find((n) => n.title === 'Pricing memo is due Friday');
      if (!memo || memo.updated_source !== null) fail('the member sees the private thread on the summary', memo);
      (await asMember.get(PAGE, { params: { projectId, pageId: memo.page_id } }))
        .status(200).body().has('$.sources[0].session_id', null).has('$.sources[0].message_id', null).has('$.updated_source', null);
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-6', meta([R.remember, R.layer, R.create, R.page, R.pages, FEATURES, SPACE_CREATE, SPACE_UPDATE, TOKEN_MINT]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const projectId = project.id;
  const p = { params: { projectId } };
  try {
    await world.setFeature('project_channels', true);
    const launch = await channel(world, 'Launch');
    const other = await channel(world, 'Other');
    const agent = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'project', firstPrompt: 'Plan the  Q4 launch\nwith Priya' });

    await ctx.step('a browser JWT calling remember → 403 session_token_required', async () => {
      (await world.owner.post(REMEMBER, { title: 'Priya', type: 'people', fact: 'Approves copy' }, p)).status(403).body().has('$.code', 'session_token_required');
    });

    let first: MemoryRememberResult;
    await ctx.step('a channel thread remembers a fact → 200 {created: true, merged: false} in the #launch layer, copy_path …/channel/people/priya.md', async () => {
      first = read<MemoryRememberResult>((await agent.client.post(REMEMBER, { title: 'Priya', type: 'people', summary: 'Marketing lead', fact: 'Approves all launch copy' }, p))
        .status(200), (b) => b.schema(MemoryRememberResultSchema)
        .has('$.saved', true).has('$.created', true).has('$.merged', false).has('$.title', 'Priya').has('$.status', 'confirmed')
        .has('$.layer.scope', 'channel').has('$.layer.key', launch.space_id).has('$.layer.name', '#launch')
        .has('$.copy_path', `${COPY}/channel/people/priya.md`));
    });

    let second: MemoryRememberResult;
    await ctx.step('the same title in another case with a section → merged into the same page, type kept, layer version raised', async () => {
      second = read<MemoryRememberResult>((await agent.client.post(REMEMBER, { title: '  priya ', type: 'decisions', fact: 'Prefers plain words', section: 'Style' }, p))
        .status(200), (b) => b.schema(MemoryRememberResultSchema)
        .has('$.created', false).has('$.merged', true).has('$.page_id', first!.page_id));
      if (BigInt(second.layer.version) <= BigInt(first!.layer.version)) fail('the layer version did not rise', { first: first!.layer, second: second.layer });
    });

    await ctx.step('the page reads: type people, "## Style" made, two thread sources naming the thread, author the agent for the thread owner', async () => {
      const page = read<MemoryPage>((await world.owner.get(PAGE, { params: { projectId, pageId: first!.page_id } }))
        .status(200), (b) => b.schema(MemoryPageSchema)
        .has('$.type', 'people').has('$.summary', 'Marketing lead')
        .has('$.body', '- Approves all launch copy ⟦1⟧\n\n## Style\n\n- Prefers plain words ⟦2⟧')
        .has('$.sources.length', 2)
        .has('$.updated_by.kind', 'agent').has('$.updated_by.agent', 'kortix').has('$.updated_by.user_id', world.ownerUserId)
        .has('$.updated_source.session_id', agent.sessionId));
      for (const [i, source] of page.sources.entries()) {
        if (source.number !== i + 1 || source.kind !== 'thread' || source.session_id !== agent.sessionId || source.label !== 'Plan the Q4 launch with Priya') {
          fail(`source ${i + 1}`, source);
        }
        if (source.thread_href_hint?.space_kind !== 'channel' || source.thread_href_hint.slug !== 'launch') fail('thread hint', source);
      }
      const listed = (await world.owner.get(PAGES, { params: { projectId, layerKey: launch.space_id } })).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      if (listed.filter((x) => x.title.toLowerCase() === 'priya').length !== 1) fail('one Priya page', listed);
    });

    await ctx.step('body replaces a merged page; layer company from a channel thread → the Company layer', async () => {
      (await agent.client.post(REMEMBER, { title: 'Priya', type: 'people', body: '- Owns launch copy' }, p)).status(200).body().has('$.merged', true);
      (await world.owner.get(PAGE, { params: { projectId, pageId: first!.page_id } })).status(200).body().has('$.body', '- Owns launch copy');
      (await agent.client.post(REMEMBER, { title: 'Pricing policy', type: 'decisions', body: 'We never discount.', layer: 'company' }, p))
        .status(200).body().has('$.layer.scope', 'company').has('$.layer.key', 'company').has('$.copy_path', `${COPY}/company/decisions/pricing-policy.md`);
    });

    await ctx.step('layer dm from a channel thread → 403 memory_layer_forbidden', async () => {
      (await agent.client.post(REMEMBER, { title: 'Tone', type: 'playbooks', fact: 'Short replies', layer: 'dm' }, p)).status(403).body().has('$.code', 'memory_layer_forbidden');
    });

    await ctx.step('refusals: fact and body together or neither → 400; a body over 8,192 bytes → 413; a key shape → 422 not echoed', async () => {
      (await agent.client.post(REMEMBER, { title: 'Keys', type: 'decisions', fact: 'a', body: 'b' }, p)).status(400).body().has('$.code', 'invalid_input');
      (await agent.client.post(REMEMBER, { title: 'Keys', type: 'decisions' }, p)).status(400).body().has('$.code', 'invalid_input');
      (await agent.client.post(REMEMBER, { title: 'Big', type: 'decisions', body: 'a'.repeat(8193) }, p)).status(413).body().has('$.code', 'page_too_large');
      for (const fact of [`use ${FAKE_KEY}`, FAKE_ASSIGNMENT]) {
        const r = await agent.client.post(REMEMBER, { title: 'Keys', type: 'decisions', fact }, p);
        r.status(422).body().has('$.code', 'secret_detected');
        if (r.text().includes(fact)) fail('the 422 echoes the secret', r.text());
      }
    });

    await ctx.step('ordinary words (password reset, token, bearer, a hyphenated phrase) → 200 saved', async () => {
      (await agent.client.post(REMEMBER, { title: 'Account help', type: 'playbooks', fact: ORDINARY }, p)).status(200).body().has('$.created', true);
    });

    await ctx.step('the session token on the people routes: its own layer reads (can_write false), a write → 403 use_remember, another channel → 404', async () => {
      (await agent.client.get(LAYER, { params: { projectId, layerKey: launch.space_id } })).status(200).body().has('$.can_write', false);
      (await agent.client.get(LAYER, { params: { projectId, layerKey: 'company' } })).status(200).body().has('$.can_write', false);
      (await agent.client.post(PAGES, { type: 'people', title: 'Z' }, { params: { projectId, layerKey: 'company' } })).status(403).body().has('$.code', 'use_remember');
      (await agent.client.get(LAYER, { params: { projectId, layerKey: other.space_id } })).status(404).body().has('$.code', 'memory_not_found');
    });

    await ctx.step("a token bound to another project's thread → 403 on this project's remember, and nothing is saved", async () => {
      const elsewhere = await team.project({ managedGit: true });
      const foreign = await thread(ctx, world, { projectId: elsewhere.id, spaceId: null, visibility: 'project', firstPrompt: 'Elsewhere' });
      (await foreign.client.post(REMEMBER, { title: 'Intruder', type: 'people', fact: 'x' }, p)).status(403);
      const listed = (await world.owner.get(PAGES, { params: { projectId, layerKey: launch.space_id } })).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      if (listed.some((x) => x.title === 'Intruder')) fail('a foreign token wrote memory', listed);
    });

    await ctx.step('archive #launch → remember from its thread → 409 layer_read_only; unarchive → 200 again', async () => {
      (await world.owner.patch(SPACE, { archived: true }, { params: { projectId, spaceId: launch.space_id } })).status(200);
      (await agent.client.post(REMEMBER, { title: 'Priya', type: 'people', fact: 'Late fact' }, p)).status(409).body().has('$.code', 'layer_read_only');
      (await world.owner.patch(SPACE, { archived: false }, { params: { projectId, spaceId: launch.space_id } })).status(200);
      (await agent.client.post(REMEMBER, { title: 'Priya', type: 'people', fact: 'Back from the archive' }, p)).status(200);
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-7', meta([R.export, R.remember, R.layer, FEATURES, SPACE_CREATE, TOKEN_MINT]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const projectId = project.id;
  const p = { params: { projectId } };
  try {
    await world.setFeature('project_channels', true);
    const launch = await channel(world, 'Launch');
    const other = await channel(world, 'Other');
    const agent = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'project', firstPrompt: 'Plan the Q4 launch with Priya' });
    const saved = (await agent.client.post(REMEMBER, { title: 'Priya', type: 'people', summary: 'Marketing lead', fact: 'Approves all launch copy' }, p))
      .status(200).json<MemoryRememberResult>();
    const channelLayer = (await world.owner.get(LAYER, { params: { projectId, layerKey: launch.space_id } })).status(200).json<MemoryLayer>();
    const otherLayer = (await world.owner.get(LAYER, { params: { projectId, layerKey: other.space_id } })).status(200).json<MemoryLayer>();

    await ctx.step("the thread's token exports its channel layer → 200 {dir: channel, version: the remember result's}, INDEX lists the page, tokens become [label]", async () => {
      const exp = read<MemoryLayerExport>((await agent.client.get(EXPORT, { params: { projectId, layerId: channelLayer.layer_id } }))
        .status(200), (b) => b.schema(MemoryLayerExportSchema)
        .has('$.layer_id', channelLayer.layer_id).has('$.dir', 'channel').has('$.version', saved.layer.version));
      if (!exp.index.includes(`- Priya — Marketing lead (${COPY}/channel/people/priya.md)`)) fail('INDEX.md', exp.index);
      const file = exp.pages.find((x) => x.slug === 'priya');
      if (!file || file.page_id !== saved.page_id || file.type !== 'people') fail('the page file', exp.pages);
      if (!file.markdown.includes('- Approves all launch copy [Plan the Q4 launch with Priya]') || file.markdown.includes('⟦')) fail('the page markdown', file.markdown);
    });

    await ctx.step('the same token exports the Company layer → 200 {dir: company}', async () => {
      const company = (await world.owner.get(LAYER, { params: { projectId, layerKey: 'company' } })).status(200).json<MemoryLayer>();
      (await agent.client.get(EXPORT, { params: { projectId, layerId: company.layer_id } })).status(200).body().has('$.dir', 'company').has('$.pages', []);
    });

    await ctx.step("another channel's layer → 403 memory_layer_forbidden; an unknown layer → 404; a browser JWT → 403 session_token_required", async () => {
      (await agent.client.get(EXPORT, { params: { projectId, layerId: otherLayer.layer_id } })).status(403).body().has('$.code', 'memory_layer_forbidden');
      (await agent.client.get(EXPORT, { params: { projectId, layerId: randomUUID() } })).status(404);
      (await world.owner.get(EXPORT, { params: { projectId, layerId: channelLayer.layer_id } })).status(403).body().has('$.code', 'session_token_required');
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-8', meta(
  [R.layer, R.pages, R.page, R.history, FEATURES, SPACE_CREATE, 'GET /v1/drives', 'POST /v1/drives/:driveId/files/mkdir', 'PUT /v1/drives/:driveId/files/content', 'GET /v1/drives/:driveId/files', 'GET /v1/drives/:driveId/files/content'],
  { timeoutMs: 240_000 },
), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const projectId = project.id;
  const notesText = Array.from({ length: 200 }, (_, i) => `- Northwind rollout note ${String(i + 1).padStart(3, '0')}: the pilot team checked in.`).join('\n');
  const files: Record<string, string> = {
    'MEMORY.md': '# Index\n\n- decisions.md\n- notes.md\n',
    'decisions.md': '# Northwind launch decisions\n\nShip the Northwind beta on 2026-11-02.\n\n- Pricing stays at $49.\n',
    'notes.md': notesText,
  };
  let driveId = '';
  const folder = '/Company/Channels/launch/Memory';
  try {
    await world.setFeature('project_channels', true);
    // The channel exists before Files is on, so only this flow writes its Drive folders.
    const launch = await channel(world, 'Launch');
    const L = { params: { projectId, layerKey: launch.space_id } };
    await world.setFeature('volumes', true);

    await ctx.step('Files on: the project drive opens → 200 with one drive', async () => {
      const drives = (await world.owner.get('/v1/drives', { query: { projectId } })).status(200).json<{ drives: { driveId: string }[] }>().drives;
      if (drives.length !== 1) fail('project drives', drives);
      driveId = drives[0]!.driveId;
    });

    let storage = true;
    await ctx.step('three synthetic files go into the channel’s Drive Memory folder (MEMORY.md, decisions.md, a 10 KB notes.md), or the target has no drive storage (the API answers 503)', async () => {
      for (const dir of ['/Company', '/Company/Channels', '/Company/Channels/launch', folder]) {
        const r = await world.owner.post('/v1/drives/:driveId/files/mkdir', { path: dir }, { params: { driveId } });
        // No drive storage on this target: the API (not an edge: it sets x-request-id) answers 503.
        // The body carries no code, and the local profile masks the message as "Internal server error".
        if (r.statusCode === 503) {
          r.headerExists('x-request-id').body().has('$.status', 503);
          storage = false;
          return;
        }
        r.status([200, 409]);
      }
      if (Buffer.byteLength(notesText) < 10_000) fail('notes.md is not over 10 KB', Buffer.byteLength(notesText));
      for (const [name, text] of Object.entries(files)) {
        (await world.owner.put('/v1/drives/:driveId/files/content', text, { params: { driveId }, query: { path: `${folder}/${name}` }, raw: true })).status(200);
      }
    });

    let layerId = '';
    await ctx.step('the first read of the channel layer queues one memory-import job; imported_at is set when it finishes', async () => {
      layerId = (await world.owner.get(LAYER, L)).status(200).json<MemoryLayer>().layer_id;
      const done = await waitFor(
        async () => (await world.db.query<{ imported_at: Date | null; jobs: number; status: string | null }>(
          `SELECT l.imported_at,
                  (SELECT count(*)::int FROM kortix.job_queue WHERE queue = 'memory-import' AND job_key = $1::text) AS jobs,
                  (SELECT status FROM kortix.job_queue WHERE queue = 'memory-import' AND job_key = $1::text) AS status
             FROM kortix.memory_layers l WHERE l.layer_id = $1::uuid`,
          [layerId],
        )).rows[0],
        { until: (row) => !!row?.imported_at && row.status === 'done', timeoutMs: 60_000, intervalMs: 500, description: 'the memory import to finish' },
      );
      if (done!.jobs !== 1 || done!.status !== 'done') fail('import job', done);
    });

    if (!storage) {
      await ctx.step('without drive storage the import finishes with nothing imported: the layer lists no page', async () => {
        (await world.owner.get(PAGES, L)).status(200).body().has('$.pages', []);
      });
      return;
    }

    let pages: MemoryPageSummary[] = [];
    await ctx.step('the layer lists 2 imported pages: decisions "Northwind launch decisions" and note "notes"; MEMORY.md is not imported', async () => {
      pages = (await world.owner.get(PAGES, L)).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      const got = pages.map((x) => `${x.type}:${x.title}`).sort().join('|');
      if (got !== 'decisions:Northwind launch decisions|note:notes') fail('imported pages', pages);
      if (pages.some((x) => x.updated_by.kind !== 'system')) fail('import author', pages.map((x) => x.updated_by));
    });

    await ctx.step('the decisions page: summary from its first line, body without the heading, one import source labelled decisions.md, op import', async () => {
      const id = pages.find((x) => x.type === 'decisions')!.page_id;
      (await world.owner.get(PAGE, { params: { projectId, pageId: id } }))
        .status(200).body().schema(MemoryPageSchema)
        .has('$.summary', 'Ship the Northwind beta on 2026-11-02.')
        .has('$.body', 'Ship the Northwind beta on 2026-11-02.\n\n- Pricing stays at $49.\n\n⟦1⟧')
        .has('$.sources.length', 1).has('$.sources[0].kind', 'import').has('$.sources[0].label', 'decisions.md');
      (await world.owner.get(HISTORY, { params: { projectId, pageId: id } })).status(200).body().has('$.versions.length', 1).has('$.versions[0].op', 'import');
    });

    await ctx.step('the 10 KB notes.md is cut at a line break under the cap and ends with the Drive pointer', async () => {
      const id = pages.find((x) => x.type === 'note')!.page_id;
      const page = (await world.owner.get(PAGE, { params: { projectId, pageId: id } })).status(200).json<MemoryPage>();
      if (Buffer.byteLength(page.body) > 8192) fail('the cut body is over the cap', Buffer.byteLength(page.body));
      if (!/\n\n\(Imported in part; the full file is in Drive: \S*notes\.md\) ⟦1⟧$/.test(page.body)) fail('the Drive pointer', page.body.slice(-200));
      const kept = page.body.slice(0, page.body.indexOf('\n\n(Imported in part'));
      if (!notesText.startsWith(kept) || !notesText.slice(kept.length).startsWith('\n')) fail('the cut is not at a line break', kept.slice(-120));
    });

    await ctx.step('the Drive files are unchanged: all 3 still listed and read back byte for byte', async () => {
      const listed = (await world.owner.get('/v1/drives/:driveId/files', { params: { driveId }, query: { path: folder } }))
        .status(200).json<{ entries: { path: string }[] }>().entries.map((e) => e.path).sort();
      if (listed.join() !== Object.keys(files).map((name) => `${folder}/${name}`).sort().join()) fail('Drive listing', listed);
      for (const [name, text] of Object.entries(files)) {
        const read = (await world.owner.get('/v1/drives/:driveId/files/content', { params: { driveId }, query: { path: `${folder}/${name}`, download: 1 } })).status(200);
        if (read.text() !== text) fail(`${name} changed`, read.text().slice(0, 200));
      }
    });

    await ctx.step('the import runs once: a re-run of the finished job imports nothing, and imported_at does not move', async () => {
      const before = (await world.db.query<{ imported_at: Date; version: string }>('SELECT imported_at, version::text FROM kortix.memory_layers WHERE layer_id = $1', [layerId])).rows[0]!;
      await world.db.query(
        "UPDATE kortix.job_queue SET status = 'queued', attempts = 0, run_at = now(), locked_until = NULL WHERE queue = 'memory-import' AND job_key = $1",
        [layerId],
      );
      await waitFor(
        async () => (await world.db.query<{ status: string }>("SELECT status FROM kortix.job_queue WHERE queue = 'memory-import' AND job_key = $1", [layerId])).rows[0]?.status,
        { until: (status) => status === 'done', timeoutMs: 60_000, intervalMs: 500, description: 'the re-queued import job' },
      );
      const after = (await world.db.query<{ imported_at: Date; version: string }>('SELECT imported_at, version::text FROM kortix.memory_layers WHERE layer_id = $1', [layerId])).rows[0]!;
      if (after.imported_at.getTime() !== before.imported_at.getTime() || after.version !== before.version) fail('the import ran twice', { before, after });
      (await world.owner.get(PAGES, L)).status(200).body().has('$.pages.length', 2);
    });
  } finally {
    await world.setFeature('volumes', null).catch(() => undefined);
    await world.close();
  }
});

flow('MEMORY-9', meta([R.remember, R.note, R.page, R.changes, R.undo, R.pages, FEATURES, SPACE_CREATE, TOKEN_MINT]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const projectId = project.id;
  const p = { params: { projectId } };
  try {
    await world.setFeature('project_channels', true);
    const launch = await channel(world, 'Launch');
    const L = { params: { projectId, layerKey: launch.space_id } };
    const agent = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'project', firstPrompt: 'File the open notes' });
    const note = (await world.owner.post(NOTES, { text: 'Launch moves to Nov 19' }, L)).status(201).json<MemoryPage>();

    await ctx.step('remember with a live note’s title and no from_note_id → 409 title_taken naming the note; the note is not merged into', async () => {
      (await agent.client.post(REMEMBER, { title: 'Launch moves to Nov 19', type: 'decisions', fact: 'Launch is Nov 19' }, p))
        .status(409).body().has('$.code', 'title_taken').has('$.page_id', note.page_id);
      (await world.owner.get(PAGE, { params: { projectId, pageId: note.page_id } }))
        .status(200).body().has('$.type', 'note').has('$.version_no', 1).has('$.body', 'Launch moves to Nov 19 ⟦1⟧');
    });

    let filed: MemoryRememberResult;
    await ctx.step('remember with from_note_id and the note’s title → 200 a new decisions page (created, not merged); the note goes to the trash', async () => {
      filed = read<MemoryRememberResult>((await agent.client.post(REMEMBER, { title: 'Launch moves to Nov 19', type: 'decisions', fact: 'Launch is Nov 19', from_note_id: note.page_id }, p))
        .status(200), (b) => b.schema(MemoryRememberResultSchema).has('$.created', true).has('$.merged', false));
      if (filed.page_id === note.page_id) fail('the note itself became the page', filed);
      (await world.owner.get(PAGE, { params: { projectId, pageId: filed.page_id } })).status(200).body().has('$.type', 'decisions');
      (await world.owner.get(PAGE, { params: { projectId, pageId: note.page_id } })).status(200).body().has('$.can_edit', false);
      (await world.owner.get(LAYER, L)).status(200).body().has('$.counts.note', 0).has('$.counts.decisions', 1);
    });

    await ctx.step('Recent changes: the two newest rows are op file_note, one per page, with one change_id and the agent as author', async () => {
      const changes = read<{ changes: MemoryChange[] }>((await world.owner.get(CHANGES, { ...L, query: { limit: 2 } })).status(200), (b) => b.schema(MemoryChangeListSchema)).changes;
      const [a, b] = changes;
      if (a?.op !== 'file_note' || b?.op !== 'file_note' || a.change_id !== b.change_id) fail('the file_note pair', changes);
      if (new Set([a.page_id, b.page_id]).size !== 2 || ![a.page_id, b.page_id].includes(note.page_id)) fail('the pair pages', changes);
      if (a.author.kind !== 'agent' || a.author.agent !== 'kortix' || a.source?.session_id !== agent.sessionId) fail('the pair author', a);
    });

    await ctx.step('one undo of either row → 200 {pages: [the note]}: the note is live again and the filed page is in the trash', async () => {
      (await world.owner.post(UNDO, undefined, { params: { projectId, versionId: filed!.version_id } }))
        .status(200).body().schema(MemoryUndoResultSchema).has('$.pages.length', 1).has('$.pages[0].page_id', note.page_id).has('$.pages[0].type', 'note');
      (await world.owner.get(PAGE, { params: { projectId, pageId: filed!.page_id } })).status(200).body().has('$.can_edit', false);
      (await world.owner.get(LAYER, L)).status(200).body().has('$.counts.note', 1).has('$.counts.decisions', 0);
      const pair = (await world.owner.get(CHANGES, { ...L, query: { limit: 4 } })).status(200).json<{ changes: MemoryChange[] }>().changes;
      if (pair.map((c) => c.op).join() !== 'undo,undo,file_note,file_note' || pair.slice(2).some((c) => !c.undone)) fail('both file_note rows are undone', pair);
    });

    await ctx.step('from_note_id of an unknown note → 404, and nothing is saved', async () => {
      (await agent.client.post(REMEMBER, { title: 'Ghost', type: 'decisions', fact: 'x', from_note_id: randomUUID() }, p)).status(404);
      const listed = (await world.owner.get(PAGES, L)).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      if (listed.some((x) => x.title === 'Ghost')) fail('a page was saved', listed);
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-10', meta([R.remember, R.export, R.layer, R.page, R.changes, FEATURES, SPACE_CREATE, SPACE_DM, TOKEN_MINT]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { manifest: true });
  const projectId = project.id;
  const p = { params: { projectId } };
  try {
    await world.setFeature('project_channels', true);
    const launch = await channel(world, 'Launch');
    const member = await team.addMember('member');
    await team.grantProjectRole(projectId, member.userId!, 'member');
    const asMember = ctx.client.as(member);
    const dmId = (await world.owner.post(DM, { agent_name: 'kortix' }, p)).status(200).json<Space>().space_id;
    const dmThread = await thread(ctx, world, { spaceId: dmId, visibility: 'private', firstPrompt: 'Talk through my week' });
    const privateThread = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'private', firstPrompt: 'Draft the Northwind pricing memo' });
    const sharedThread = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'project', firstPrompt: 'Review the launch checklist' });

    let tone: MemoryRememberResult;
    await ctx.step('a DM thread remembers → the personal layer {scope: dm, key: the DM}, copy_path …/personal/playbooks/tone.md', async () => {
      tone = read<MemoryRememberResult>((await dmThread.client.post(REMEMBER, { title: 'Tone', type: 'playbooks', fact: 'Keep replies short' }, p))
        .status(200), (b) => b.schema(MemoryRememberResultSchema)
        .has('$.layer.scope', 'dm').has('$.layer.key', dmId).has('$.layer.name', 'kortix').has('$.copy_path', `${COPY}/personal/playbooks/tone.md`));
    });

    await ctx.step('from the DM thread: layer channel → 403 memory_layer_forbidden; layer company → 200 the Company layer', async () => {
      (await dmThread.client.post(REMEMBER, { title: 'Tone', type: 'playbooks', fact: 'x', layer: 'channel' }, p)).status(403).body().has('$.code', 'memory_layer_forbidden');
      (await dmThread.client.post(REMEMBER, { title: 'Office hours', type: 'playbooks', fact: 'Fridays 10:00', layer: 'company' }, p)).status(200).body().has('$.layer.scope', 'company');
    });

    await ctx.step('the other member cannot open the DM page: GET → 404 memory_not_found', async () => {
      (await asMember.get(PAGE, { params: { projectId, pageId: tone!.page_id } })).status(404).body().has('$.code', 'memory_not_found');
    });

    let memo: MemoryRememberResult;
    await ctx.step('a private channel thread writes the channel layer by default; layer dm from it → 403', async () => {
      memo = read<MemoryRememberResult>((await privateThread.client.post(REMEMBER, { title: 'Pricing', type: 'decisions', fact: 'Plans stay at $49' }, p))
        .status(200), (b) => b.has('$.layer.scope', 'channel').has('$.layer.key', launch.space_id));
      (await privateThread.client.post(REMEMBER, { title: 'Tone', type: 'playbooks', fact: 'x', layer: 'dm' }, p)).status(403).body().has('$.code', 'memory_layer_forbidden');
    });

    await ctx.step('the thread owner reads the page with the private thread named: source label = its title, session_id set', async () => {
      (await world.owner.get(PAGE, { params: { projectId, pageId: memo!.page_id } }))
        .status(200).body()
        .has('$.sources[0].kind', 'thread').has('$.sources[0].label', 'Draft the Northwind pricing memo')
        .has('$.sources[0].session_id', privateThread.sessionId).has('$.updated_source.session_id', privateThread.sessionId);
    });

    await ctx.step('another member reads the same page: the source is "a private thread" with no id, message or place; updated_source and the change source are null', async () => {
      (await asMember.get(PAGE, { params: { projectId, pageId: memo!.page_id } }))
        .status(200).body()
        .has('$.sources[0].kind', 'thread').has('$.sources[0].label', PRIVATE_THREAD)
        .has('$.sources[0].session_id', null).has('$.sources[0].message_id', null).has('$.sources[0].thread_href_hint', null)
        .has('$.updated_source', null);
      const changes = (await asMember.get(CHANGES, { params: { projectId, layerKey: launch.space_id } })).status(200).json<{ changes: MemoryChange[] }>().changes;
      const row = changes.find((c) => c.page_id === memo!.page_id);
      if (!row || row.source !== null) fail('the change source leaks the private thread', row);
    });

    const channelLayerId = memo!.layer.layer_id;
    await ctx.step('a project-visible thread exports the channel layer: the private source renders [a private thread], never its title', async () => {
      const exp = (await sharedThread.client.get(EXPORT, { params: { projectId, layerId: channelLayerId } })).status(200).json<MemoryLayerExport>();
      const file = exp.pages.find((x) => x.page_id === memo!.page_id);
      if (!file?.markdown.includes(`[${PRIVATE_THREAD}]`) || file.markdown.includes('Northwind pricing memo')) fail('the shared copy', file?.markdown);
    });

    await ctx.step('the private thread itself exports the channel layer with its own title as the label', async () => {
      const exp = (await privateThread.client.get(EXPORT, { params: { projectId, layerId: channelLayerId } })).status(200).json<MemoryLayerExport>();
      const file = exp.pages.find((x) => x.page_id === memo!.page_id);
      if (!file?.markdown.includes('[Draft the Northwind pricing memo]')) fail('the private copy', file?.markdown);
    });

    await ctx.step("the owner's private channel thread reads the owner's DM layer (export 200, dir personal); the project-visible thread → 403", async () => {
      const dmLayerId = tone!.layer.layer_id;
      const exp = read<MemoryLayerExport>((await privateThread.client.get(EXPORT, { params: { projectId, layerId: dmLayerId } }))
        .status(200), (b) => b.schema(MemoryLayerExportSchema).has('$.dir', 'personal'));
      if (!exp.index.includes('Tone')) fail('the personal INDEX.md', exp.index);
      (await sharedThread.client.get(EXPORT, { params: { projectId, layerId: dmLayerId } })).status(403).body().has('$.code', 'memory_layer_forbidden');
    });
  } finally {
    await world.close();
  }
});

/** The titles of `hits`, sorted: search ranks by relevance, so the flows compare sets. */
const titlesOf = (hits: readonly MemorySearchHit[]) => hits.map((hit) => hit.title).sort().join('|');

flow('MEMORY-11', meta([R.search, R.create, R.remove, FEATURES, SPACE_CREATE, SPACE_UPDATE, SPACE_DM, TOKEN_MINT]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { manifest: true });
  const projectId = project.id;
  const search = (client: Client, query: Record<string, string | number>) => client.get(SEARCH, { params: { projectId }, query });
  const hitsOf = (res: Res) => read<{ hits: MemorySearchHit[] }>(res.status(200), (b) => b.schema(MemorySearchResultSchema)).hits;
  const make = async (client: Client, layerKey: string, page: { type: string; title: string; summary?: string; body?: string }) =>
    (await client.post(PAGES, page, { params: { projectId, layerKey } })).status(201).json<MemoryPage>();
  try {
    await ctx.step('with project_channels off, GET /memory/search → 403 feature_disabled', async () => {
      (await search(world.owner, { q: 'Northwind' })).status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'project_channels');
    });

    await world.setFeature('project_channels', true);
    const member = await team.addMember('member');
    await team.grantProjectRole(projectId, member.userId!, 'member');
    await world.grantRun('kortix', member);
    const asMember = ctx.client.as(member);
    const launch = await channel(world, 'Launch');
    const other = await channel(world, 'Other');
    const old = await channel(world, 'Old');
    const ownerDm = (await world.owner.post(DM, { agent_name: 'kortix' }, { params: { projectId } })).status(200).json<Space>().space_id;
    const memberDm = (await asMember.post(DM, { agent_name: 'kortix' }, { params: { projectId } })).status(200).json<Space>().space_id;

    // One "Northwind" page in every layer kind, plus an unconfirmed, an archived-channel and a trashed one.
    let pricing: MemoryPage;
    let rumor: MemoryPage;
    let rate: MemoryPage;
    await ctx.step('seed pages that all mention Northwind: Company, #launch (one later unconfirmed), #other, #old (then archived), both DMs, one trashed', async () => {
      pricing = await make(world.owner, 'company', { type: 'decisions', title: 'Northwind pricing', body: 'Plans stay at $49 for Northwind.' });
      await make(world.owner, launch.space_id, { type: 'workstreams', title: 'Northwind launch', body: '- Ship the beta' });
      rumor = await make(world.owner, launch.space_id, { type: 'decisions', title: 'Northwind rumor', body: 'A partner may resell Northwind.' });
      await make(world.owner, other.space_id, { type: 'playbooks', title: 'Northwind support', body: 'Answer within a day.' });
      await make(world.owner, old.space_id, { type: 'decisions', title: 'Northwind archive', body: 'Retired plan.' });
      await make(world.owner, ownerDm, { type: 'playbooks', title: 'Northwind tone', body: 'Keep replies short.' });
      await make(asMember, memberDm, { type: 'people', title: 'Northwind contact', body: 'Mateo answers the phone.' });
      const draft = await make(world.owner, 'company', { type: 'decisions', title: 'Northwind draft', body: 'Not final.' });
      (await world.owner.del(PAGE, { params: { projectId, pageId: draft.page_id } })).status(200);
      rate = await make(world.owner, 'company', { type: 'decisions', title: 'Rate 5%_off', body: 'Promotion code rules.' });
      (await world.owner.patch(SPACE, { archived: true }, { params: { projectId, spaceId: old.space_id } })).status(200);
      // An unconfirmed page has no HTTP way in before P3 (outside content): set the status the way the P3 write will.
      await world.db.query("UPDATE kortix.memory_pages SET status = 'unconfirmed' WHERE page_id = $1", [rumor.page_id]);
    });

    await ctx.step('the owner searches "Northwind" → Company, both live channels (the unconfirmed page marked so) and the owner’s DM; never the member’s DM, the archived channel or the trash', async () => {
      const hits = hitsOf(await search(world.owner, { q: 'Northwind' }));
      if (titlesOf(hits) !== 'Northwind launch|Northwind pricing|Northwind rumor|Northwind support|Northwind tone') fail('the owner’s hits', hits);
      if (hits.find((h) => h.title === 'Northwind rumor')?.status !== 'unconfirmed') fail('the unconfirmed hit', hits);
      const tone = hits.find((h) => h.title === 'Northwind tone');
      if (tone?.scope !== 'dm' || tone.layer_key !== ownerDm || tone.layer_name !== 'kortix') fail('the DM hit', tone);
    });

    await ctx.step('a Company hit carries {layer_key: company, layer_name: Company, scope: company, type, summary, status: confirmed} and a body snippet', async () => {
      const hit = hitsOf(await search(world.owner, { q: 'Northwind', type: 'decisions' })).find((h) => h.page_id === pricing!.page_id);
      const want = { page_id: pricing!.page_id, layer_key: 'company', layer_name: 'Company', scope: 'company', type: 'decisions', title: 'Northwind pricing', summary: '', snippet: 'Plans stay at $49 for Northwind.', status: 'confirmed' };
      const keys = Object.keys(want).sort();
      if (!hit || JSON.stringify(hit, keys) !== JSON.stringify(want, keys)) fail('the Company hit', hit);
    });

    await ctx.step('the member searches "Northwind" → Company, both live channels and the member’s own DM; never the owner’s DM', async () => {
      const hits = hitsOf(await search(asMember, { q: 'Northwind' }));
      if (titlesOf(hits) !== 'Northwind contact|Northwind launch|Northwind pricing|Northwind rumor|Northwind support') fail('the member’s hits', hits);
    });

    await ctx.step('layer= narrows to one layer: the archived #old → its page; the member’s DM, asked by the owner → 404 memory_not_found', async () => {
      if (titlesOf(hitsOf(await search(world.owner, { q: 'Northwind', layer: old.space_id }))) !== 'Northwind archive') fail('layer=#old', 'wrong hits');
      if (titlesOf(hitsOf(await search(world.owner, { q: 'Northwind', layer: launch.space_id }))) !== 'Northwind launch|Northwind rumor') fail('layer=#launch', 'wrong hits');
      (await search(world.owner, { q: 'Northwind', layer: memberDm })).status(404).body().has('$.code', 'memory_not_found');
    });

    await ctx.step('type= filters and limit= caps: type=playbooks → #other and the DM page; limit=1 → one hit', async () => {
      if (titlesOf(hitsOf(await search(world.owner, { q: 'Northwind', type: 'playbooks' }))) !== 'Northwind support|Northwind tone') fail('type=playbooks', 'wrong hits');
      if (hitsOf(await search(world.owner, { q: 'Northwind', limit: 1 })).length !== 1) fail('limit=1', 'not one hit');
    });

    await ctx.step('% and _ in q match literally: "%_" → only "Rate 5%_off"; "%%" → no hit (unescaped, both would match every title)', async () => {
      const hits = hitsOf(await search(world.owner, { q: '%_' }));
      if (hits.length !== 1 || hits[0]!.page_id !== rate!.page_id) fail('q=%_', hits);
      if (hitsOf(await search(world.owner, { q: '%%' })).length !== 0) fail('q=%%', 'matched a title without %%');
    });

    await ctx.step('bad q, type or limit → 400 invalid_input: 1 character, 1 character inside spaces, 201 characters, a NUL, limit 0 or 21, an unknown type; 200 characters → 200', async () => {
      const refused: Record<string, string | number>[] = [
        { q: 'N' },
        { q: '  N  ' },
        { q: 'N'.repeat(201) },
        { q: 'North\u0000wind' },
        { q: 'Northwind', limit: 0 },
        { q: 'Northwind', limit: 21 },
        { q: 'Northwind', type: 'secrets' },
      ];
      for (const query of refused) {
        (await search(world.owner, query)).status(400).body().has('$.code', 'invalid_input');
      }
      (await search(world.owner, { q: 'N'.repeat(200) })).status(200).body().has('$.hits', []);
    });

    const agent = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'project', firstPrompt: 'Plan the Northwind launch' });

    await ctx.step('a #launch thread’s session token searches "Northwind" → only its layers (Company, #launch), confirmed pages only', async () => {
      const hits = hitsOf(await search(agent.client, { q: 'Northwind' }));
      if (titlesOf(hits) !== 'Northwind launch|Northwind pricing') fail('the thread’s hits', hits);
      if (hits.some((h) => h.status !== 'confirmed' || !['company', launch.space_id].includes(h.layer_key))) fail('the thread’s hit layers', hits);
    });

    await ctx.step('the session token naming a layer its thread does not read (#other, the owner’s DM) → 404 memory_not_found', async () => {
      for (const layer of [other.space_id, ownerDm]) {
        (await search(agent.client, { q: 'Northwind', layer })).status(404).body().has('$.code', 'memory_not_found');
      }
    });

    await ctx.step("a token bound to another project's thread → 403 on this project's search", async () => {
      const elsewhere = await team.project({ managedGit: true });
      const foreign = await thread(ctx, world, { projectId: elsewhere.id, spaceId: null, visibility: 'project', firstPrompt: 'Elsewhere' });
      (await search(foreign.client, { q: 'Northwind' })).status(403);
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-12', meta([R.usage, R.create, R.update, R.remove, FEATURES, SPACE_CREATE, SPACE_DM, TOKEN_MINT]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { manifest: true });
  const projectId = project.id;
  const usageOf = (client: Client, sessionId: string) => client.get(USAGE, { params: { projectId, sessionId } });
  try {
    const before = await thread(ctx, world, { spaceId: null, visibility: 'project', firstPrompt: 'Before the flag' });
    await ctx.step('with project_channels off, GET /sessions/:id/memory-usage → 403 feature_disabled', async () => {
      (await usageOf(world.owner, before.sessionId)).status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'project_channels');
    });

    await world.setFeature('project_channels', true);
    const member = await team.addMember('member');
    await team.grantProjectRole(projectId, member.userId!, 'member');
    const asMember = ctx.client.as(member);
    const launch = await channel(world, 'Launch');
    const dmId = (await world.owner.post(DM, { agent_name: 'kortix' }, { params: { projectId } })).status(200).json<Space>().space_id;
    const memo = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'private', firstPrompt: 'Draft the Northwind pricing memo' });
    const elsewhere = await thread(ctx, world, { spaceId: launch.space_id, visibility: 'private', firstPrompt: 'Another private thread' });

    await ctx.step('a thread before its first turn → 200 {loaded_at: null, layers: []}', async () => {
      (await usageOf(world.owner, memo.sessionId)).status(200).body().schema(MemoryUsageSchema).has('$.loaded_at', null).has('$.layers', []);
    });

    const p = (pageId: string) => ({ params: { projectId, pageId } });
    const page = (layerKey: string, body: { type: string; title: string }) =>
      world.owner.post(PAGES, body, { params: { projectId, layerKey } }).then((r) => r.status(201).json<MemoryPage>());
    const pricing = await page('company', { type: 'decisions', title: 'Pricing' });
    const launchPlan = await page(launch.space_id, { type: 'workstreams', title: 'Launch plan' });
    const priya = await page(launch.space_id, { type: 'people', title: 'Priya' });
    const tone = await page(dmId, { type: 'playbooks', title: 'Tone' });
    const loadedAt = '2026-10-20T09:30:00.000Z';
    const entry = (pg: MemoryPage) => ({ page_id: pg.page_id, type: pg.type, title: pg.title });

    await ctx.step('the thread’s first-turn record (as the turn hook writes it: Company, #launch and the owner’s DM, read-only in a private channel thread) is listed by layer for the owner', async () => {
      // The record is written on the sandbox proxy at the first prompt (MEMORY-13 proves that path); this flow seeds it.
      const layers = [
        { layer_id: pricing.layer_id, scope: 'company', name: 'Company', version: 1, page_ids: [pricing.page_id] },
        { layer_id: launchPlan.layer_id, scope: 'channel', name: '#launch', version: 2, page_ids: [launchPlan.page_id, priya.page_id] },
        { layer_id: tone.layer_id, scope: 'dm', name: 'kortix', version: 1, page_ids: [tone.page_id] },
      ];
      await world.db.query('INSERT INTO kortix.memory_thread_loads (session_id, first_loaded_at, layers) VALUES ($1, $2, $3::jsonb)', [memo.sessionId, loadedAt, JSON.stringify(layers)]);
      (await usageOf(world.owner, memo.sessionId))
        .status(200).body().schema(MemoryUsageSchema)
        .has('$.loaded_at', loadedAt)
        .has('$.layers', [
          { layer_key: 'company', scope: 'company', name: 'Company', pages: [entry(pricing)] },
          { layer_key: launch.space_id, scope: 'channel', name: '#launch', pages: [entry(launchPlan), entry(priya)] },
          { layer_key: dmId, scope: 'dm', name: 'kortix', pages: [entry(tone)] },
        ]);
    });

    await ctx.step('a page renamed since shows its current title; a page trashed since is left out, and a layer left with no page is left out', async () => {
      (await world.owner.patch(PAGE, { base_version: 1, title: 'Launch plan v2' }, p(launchPlan.page_id))).status(200);
      (await world.owner.del(PAGE, p(priya.page_id))).status(200);
      (await world.owner.del(PAGE, p(pricing.page_id))).status(200);
      (await usageOf(world.owner, memo.sessionId))
        .status(200).body()
        .has('$.loaded_at', loadedAt)
        .has('$.layers', [
          { layer_key: launch.space_id, scope: 'channel', name: '#launch', pages: [{ ...entry(launchPlan), title: 'Launch plan v2' }] },
          { layer_key: dmId, scope: 'dm', name: 'kortix', pages: [entry(tone)] },
        ]);
    });

    await ctx.step('another member cannot open the private thread or an unknown one → 404 session_not_found', async () => {
      (await usageOf(asMember, memo.sessionId)).status(404).body().has('$.code', 'session_not_found');
      (await usageOf(asMember, elsewhere.sessionId)).status(404).body().has('$.code', 'session_not_found');
      (await usageOf(world.owner, randomUUID())).status(404).body().has('$.code', 'session_not_found');
    });

    await ctx.step('once the thread is project-visible the member opens it: #launch is listed, the owner’s DM layer (its titles) is not; the owner still sees it', async () => {
      // Sharing only flips `visibility`; set it directly, since this thread has no box for the sharing route to update.
      await world.db.query("UPDATE kortix.project_sessions SET visibility = 'project' WHERE session_id = $1", [memo.sessionId]);
      const seen = read<MemoryUsage>((await usageOf(asMember, memo.sessionId)).status(200), (b) => b.schema(MemoryUsageSchema).has('$.loaded_at', loadedAt));
      if (seen.layers.map((l) => l.layer_key).join() !== launch.space_id || JSON.stringify(seen).includes('Tone')) fail('the member’s usage', seen);
      (await usageOf(world.owner, memo.sessionId)).status(200).body().has('$.layers.length', 2).has('$.layers[1].layer_key', dmId);
    });
  } finally {
    await world.close();
  }
});

/** Until no turn runs and the transcript holds an ended assistant reply: the session's first turn is over. */
async function firstTurnEnded(ctx: FlowContext, projectId: string, sessionId: string): Promise<void> {
  await waitFor(
    async () => ({ turn: await readTurn(ctx, projectId, sessionId), transcript: await readTranscript(ctx, projectId, sessionId) }),
    {
      until: ({ turn, transcript }) =>
        turn.turns.length === 0 && transcript.messages.some((m) => m.role === 'assistant' && (Boolean(m.completed) || Boolean(m.error))),
      timeoutMs: 240_000,
      intervalMs: 2_000,
      description: `the first turn of ${sessionId} to end`,
      retryOnError: isKe2eRetryableError,
    },
  );
}

/** A thread made through the session route, booted, its first prompt answered. */
async function bootedThread(ctx: FlowContext, world: AgentPrincipalsWorld, body: Record<string, unknown>): Promise<string> {
  const r = await world.owner.post(SESSIONS, body, { params: { projectId: world.projectId } });
  // 202 is the accepted envelope of a create the API finishes in the background; both name the session.
  r.status([201, 202]);
  const sessionId = r.json<{ session_id: string | null }>().session_id;
  if (!sessionId) fail('the session create named no session', r.text());
  ctx.track('session', sessionId, { projectId: world.projectId });
  await waitForSessionReady(ctx, world.projectId, sessionId);
  await firstTurnEnded(ctx, world.projectId, sessionId);
  return sessionId;
}

flow(
  'MEMORY-13',
  meta(
    [
      R.usage,
      R.create,
      FEATURES,
      SPACE_CREATE,
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/turn',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    ],
    // Needs a booted box: the turn hook runs on the sandbox proxy. Two boots, a cold image can take ~7 min.
    { requires: ['database', 'sandbox', 'funded'], timeoutMs: 1_500_000 },
  ),
  async (ctx) => {
    // What the agent receives (`memory_layers` and the page list as `system` on the Kortix prompt body, a
    // client-sent `system` dropped) is not observable over REST: apps/api turn-context.test.ts and
    // integration-memory-turn-search.test.ts pin the body; this flow proves the "Used memory" record.
    const { project, world } = await openWorld(ctx, { manifest: true });
    const projectId = project.id;
    const usageOf = (sessionId: string) => world.owner.get(USAGE, { params: { projectId, sessionId } });
    try {
      // The flag is on before any prompt: turn starts cache the flag per project for up to 30 s.
      await world.setFeature('project_channels', true);
      await world.fund();
      const launch = await channel(world, 'Launch');
      const make = (layerKey: string, body: { type: string; title: string; summary: string }) =>
        world.owner.post(PAGES, body, { params: { projectId, layerKey } }).then((r) => r.status(201).json<MemoryPage>());
      const pricing = await make('company', { type: 'decisions', title: 'Pricing', summary: 'Plans stay at $49' });
      const plan = await make(launch.space_id, { type: 'workstreams', title: 'Launch plan', summary: 'Beta ships Nov 2' });
      const priya = await make(launch.space_id, { type: 'people', title: 'Priya', summary: 'Approves launch copy' });

      let sessionId = '';
      let first: MemoryUsage;
      await ctx.step('the first prompt of a #launch thread → memory-usage lists 3 pages in 2 layers: Company (Pricing) and #launch (Launch plan, Priya)', async () => {
        sessionId = await bootedThread(ctx, world, { space_id: launch.space_id, initial_prompt: 'Reply with the single word OK.' });
        // The record is written off the turn's path: poll briefly.
        first = await waitFor(async () => (await usageOf(sessionId)).status(200).json<MemoryUsage>(), {
          until: (u) => u.loaded_at !== null,
          timeoutMs: 30_000,
          intervalMs: 1_000,
          description: 'the first-turn memory record',
        });
        const got = first.layers.map((l) => `${l.layer_key}:${l.pages.map((pg) => pg.page_id).sort().join()}`).sort().join('|');
        const want = [`company:${pricing.page_id}`, `${launch.space_id}:${[plan.page_id, priya.page_id].sort().join()}`].sort().join('|');
        if (got !== want) fail('the first-turn usage', first);
        (await usageOf(sessionId)).status(200).body().schema(MemoryUsageSchema);
      });

      await ctx.step('a page added later and a second turn change nothing: same loaded_at, same 3 pages', async () => {
        await make(launch.space_id, { type: 'decisions', title: 'Discounts', summary: 'No discounts in Q4' });
        const previous = (await readTurn(ctx, projectId, sessionId)).last_ended?.turn_token;
        await sendPrompt(ctx, projectId, sessionId, 'Reply with the single word OK again.');
        await waitForTurn(ctx, projectId, sessionId, endedAfter(previous), 'the second turn to end');
        (await usageOf(sessionId)).status(200).body().has('$.loaded_at', first!.loaded_at).has('$.layers', first!.layers);
      });

      await ctx.step('a thread that ran its first turn in no space (flag off) has no record once the flag is on again: {loaded_at: null, layers: []}', async () => {
        await world.setFeature('project_channels', false);
        const plain = await bootedThread(ctx, world, { initial_prompt: 'Reply with the single word OK.' });
        await world.setFeature('project_channels', true);
        (await usageOf(plain)).status(200).body().has('$.loaded_at', null).has('$.layers', []);
      });
    } finally {
      await world.close();
    }
  },
);
