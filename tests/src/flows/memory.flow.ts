/**
 * MEMORY-1..6, 12, 16 — Memory: the Markdown files of the project's Drive,
 * read and edited as pages over `/v1/projects/:projectId/memory/*`, "Used
 * memory" (`/sessions/:sessionId/memory-usage`) and Channels onboarding
 * (`/onboarding/channels`, MEMORY-16). Spec: tests/spec/end-to-end.md § 7b.
 * Source of truth: apps/api/src/memory/ and
 * apps/api/src/projects/routes/project-memory.ts; shapes in
 * packages/api-contract/src/memory.ts. Pure rules (front-matter, page
 * mapping, history runs, the turn list) are pinned by the unit tests next to
 * them and by `integration-memory-turn-search.test.ts` (a fake volume).
 *
 * Memory needs drive storage. The local profile has none: every route that
 * reads or writes a folder answers 503 `drive_storage_unavailable`, which
 * MEMORY-2 asserts; the refusals that come before storage (flags, ACL, input)
 * run everywhere. MEMORY-4 and MEMORY-5 need storage and skip without it;
 * MEMORY-4 is tagged `deployed`, so the release suite runs it on staging.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  ChannelsOnboardingSchema,
  MemoryDeleteResultSchema,
  MemoryLayerSchema,
  MemoryPageListSchema,
  MemoryPageSchema,
  MemorySearchResultSchema,
  MemoryUsageSchema,
  MemoryVersionListSchema,
  SpaceListSchema,
  type ChannelsOnboarding,
  type MemoryLayer,
  type MemoryPage,
  type MemoryPageSummary,
  type MemoryVersion,
  type SpaceList,
} from '@kortix/api-contract';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { Client, Res } from '../core/client';
import type { BodyAssert } from '../core/expect';
import type { FlowContext, FlowMeta } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';

const R = {
  layer: 'GET /v1/projects/:projectId/memory/layers/:layerKey',
  pages: 'GET /v1/projects/:projectId/memory/layers/:layerKey/pages',
  create: 'POST /v1/projects/:projectId/memory/layers/:layerKey/pages',
  note: 'POST /v1/projects/:projectId/memory/layers/:layerKey/notes',
  page: 'GET /v1/projects/:projectId/memory/pages/:pageId',
  update: 'PATCH /v1/projects/:projectId/memory/pages/:pageId',
  remove: 'DELETE /v1/projects/:projectId/memory/pages/:pageId',
  history: 'GET /v1/projects/:projectId/memory/pages/:pageId/history',
  search: 'GET /v1/projects/:projectId/memory/search',
  usage: 'GET /v1/projects/:projectId/sessions/:sessionId/memory-usage',
} as const;
const FEATURES = 'PATCH /v1/projects/:projectId/features';
const SPACE_CREATE = 'POST /v1/projects/:projectId/spaces';
const SPACE_UPDATE = 'PATCH /v1/projects/:projectId/spaces/:spaceId';
const SPACE_DM = 'POST /v1/projects/:projectId/spaces/dm';
const TOKEN_MINT = 'POST /v1/projects/:projectId/cli-token';
const DRIVE_LIST = 'GET /v1/drives';
const DRIVE_FILES = 'GET /v1/drives/:driveId/files';
const DRIVE_READ = 'GET /v1/drives/:driveId/files/content';
const DRIVE_WRITE = 'PUT /v1/drives/:driveId/files/content';
/** `hasStorage` probes with a folder made and removed. */
const STORAGE_PROBE = ['GET /v1/drives', 'POST /v1/drives/:driveId/files/mkdir', 'DELETE /v1/drives/:driveId/files'];
const RESOURCE_GRANTS = 'POST /v1/projects/:projectId/resource-grants';

const LAYER = '/v1/projects/:projectId/memory/layers/:layerKey';
const PAGES = '/v1/projects/:projectId/memory/layers/:layerKey/pages';
const NOTES = '/v1/projects/:projectId/memory/layers/:layerKey/notes';
const PAGE = '/v1/projects/:projectId/memory/pages/:pageId';
const HISTORY = '/v1/projects/:projectId/memory/pages/:pageId/history';
const SEARCH = '/v1/projects/:projectId/memory/search';
const USAGE = '/v1/projects/:projectId/sessions/:sessionId/memory-usage';
const SPACES = '/v1/projects/:projectId/spaces';
const SPACE = '/v1/projects/:projectId/spaces/:spaceId';
const DM = '/v1/projects/:projectId/spaces/dm';
/** Routes the files model removed: each answers 404 (no handler). */
const REMOVED = [
  ['POST', '/v1/projects/:projectId/memory/remember'],
  ['GET', '/v1/projects/:projectId/memory/layers/:layerKey/export'],
  ['POST', '/v1/projects/:projectId/memory/pages/:pageId/confirm'],
  ['POST', '/v1/projects/:projectId/memory/pages/:pageId/restore'],
  ['GET', '/v1/projects/:projectId/memory/layers/:layerKey/changes'],
  ['POST', '/v1/projects/:projectId/memory/versions/:versionId/undo'],
] as const;

/** A credential shape the secret check refuses, built at run time so no scanner reads a key here. Synthetic: it opens nothing. */
const FAKE_KEY = ['sk', 'proj', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('-');

const meta = (routes: string[], extra: Partial<FlowMeta> = {}): FlowMeta => ({
  domain: 'memory',
  requires: ['database'],
  timeoutMs: 180_000,
  routes,
  ...extra,
});

/** A team project with Files on (the `volumes` flag): memory is gated on Files. */
async function openWorld(ctx: FlowContext, opts: { channels?: boolean } = {}) {
  const team = await ctx.fixtures.team();
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  await world.setFeature('volumes', true);
  if (opts.channels) await world.setFeature('project_channels', true);
  return { team, project, world };
}

type Space = { space_id: string; slug: string | null };

async function channel(world: AgentPrincipalsWorld, name: string): Promise<Space> {
  return (await world.owner.post(SPACES, { name }, { params: { projectId: world.projectId } })).status(201).json<Space>();
}

/** An agent's thread: a session row and a project token bound to it (what an agent's `KORTIX_TOKEN` is). `world.close()` deletes both. */
async function thread(ctx: FlowContext, world: AgentPrincipalsWorld, spaceId: string | null): Promise<{ sessionId: string; client: Client }> {
  const sessionId = randomUUID();
  world.sessions.push(sessionId);
  await world.db.query(
    `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, space_id)
     VALUES ($1, $2, $3, $1, 'kortix', 'stopped', $4, 'project', $5)`,
    [sessionId, world.accountId, world.projectId, world.ownerUserId, spaceId],
  );
  // A session credential needs a live sandbox lease (`validateAccountToken`); `world.close()` deletes it.
  await world.db.query(
    `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
     VALUES ($1::uuid, $1, $2, $3, 'active')`,
    [sessionId, world.accountId, world.projectId],
  );
  const minted = (await world.owner.post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('memory') }, { params: { projectId: world.projectId } }))
    .status(201)
    .json<{ token_id: string; secret_key: string }>();
  world.tokens.push(minted.token_id);
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

/**
 * The target has drive storage: a write lands (a folder made and removed in
 * the owner's own folder), not 503 `drive_storage_unavailable`. A read cannot
 * tell: a drive with no volume yet reads as empty on every target.
 */
async function hasStorage(world: AgentPrincipalsWorld): Promise<boolean> {
  const { driveId, personalFolder } = await driveOf(world.owner, world.projectId);
  const path = `${personalFolder}/.storage-probe-${randomUUID().slice(0, 8)}`;
  const r = await world.owner.post('/v1/drives/:driveId/files/mkdir', { path }, { params: { driveId } });
  if (r.statusCode === 503) {
    r.body().has('$.code', 'drive_storage_unavailable');
    return false;
  }
  r.status([200, 201]);
  // A new folder on Platinum storage is not empty to a plain delete; remove it as the web UI does.
  (await world.owner.del('/v1/drives/:driveId/files', { params: { driveId }, query: { path, recursive: 'true' } })).status([200, 204]);
  return true;
}

/** Without drive storage a Files write answers 503: the flow asserts that and ends (a local profile never skips). */
async function noStorage(ctx: FlowContext, world: AgentPrincipalsWorld): Promise<void> {
  await ctx.step('no drive storage on this target: a Files write → 503 drive_storage_unavailable', async () => {
    const { driveId, personalFolder } = await driveOf(world.owner, world.projectId);
    (await world.owner.put('/v1/drives/:driveId/files/content', '# x\n', {
      params: { driveId }, query: { path: `${personalFolder}/Memory/probe.md` }, headers: { 'content-type': 'application/octet-stream' }, raw: true,
    })).status(503).body().has('$.code', 'drive_storage_unavailable');
  });
}

/** The project drive's id and the caller's own folder. */
async function driveOf(client: Client, projectId: string): Promise<{ driveId: string; personalFolder: string }> {
  const drive = (await client.get('/v1/drives', { query: { projectId } })).status(200).json<{ drives: { driveId: string; personalFolder: string }[] }>().drives[0];
  if (!drive) fail('no project drive', null);
  return drive;
}

/** Every file under `/` the caller sees, path → sha256 of its bytes (the Files listing hides `.keep` markers). */
async function checksums(client: Client, driveId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    const entries = (await client.get('/v1/drives/:driveId/files', { params: { driveId }, query: { path } })).status(200).json<{ entries: { path: string; type: string }[] }>().entries;
    for (const entry of entries) {
      if (entry.type === 'dir') await walk(entry.path);
      else if (entry.type === 'file') {
        const bytes = (await client.get('/v1/drives/:driveId/files/content', { params: { driveId }, query: { path: entry.path } })).status(200).text();
        out[entry.path] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  };
  await walk('/');
  return out;
}

const changed = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((path) => a[path] !== b[path]);

// ─────────────────────────────────────────────────────────────────────────────

flow('MEMORY-1', meta([...Object.values(R), FEATURES, TOKEN_MINT]), async (ctx) => {
  const team = await ctx.fixtures.team();
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  const projectId = project.id;
  const id = randomUUID();
  const everyRoute = (client: Client) =>
    Promise.all([
      client.get(LAYER, { params: { projectId, layerKey: 'company' } }),
      client.get(PAGES, { params: { projectId, layerKey: 'company' } }),
      client.post(PAGES, { type: 'people', title: 'Priya' }, { params: { projectId, layerKey: 'company' } }),
      client.post(NOTES, { text: 'Launch moves to Nov 19' }, { params: { projectId, layerKey: 'company' } }),
      client.get(PAGE, { params: { projectId, pageId: id } }),
      client.patch(PAGE, { base_version: 1, body: 'x' }, { params: { projectId, pageId: id } }),
      client.del(PAGE, { params: { projectId, pageId: id } }),
      client.get(HISTORY, { params: { projectId, pageId: id } }),
      client.get(SEARCH, { params: { projectId }, query: { q: 'Pricing' } }),
    ]);
  try {
    await ctx.step('with Files (volumes) off, every memory route → 403 {code: feature_disabled, feature: drives}', async () => {
      await world.setFeature('volumes', false);
      for (const r of await everyRoute(world.owner)) r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'drives');
    });

    await ctx.step('an anonymous caller → 401; a non-member → 403/404', async () => {
      (await ctx.client.as(ctx.P.ANON).get(LAYER, { params: { projectId, layerKey: 'company' } })).status(401);
      (await ctx.client.as(ctx.P.NONMEMBER).get(LAYER, { params: { projectId, layerKey: 'company' } })).status([403, 404]);
    });

    await ctx.step('Files on and project_channels off: the memory routes are not gated on Channels (never 403 feature_disabled)', async () => {
      await world.setFeature('volumes', true);
      const r = await world.owner.get(LAYER, { params: { projectId, layerKey: 'company' } });
      if (r.statusCode === 403) fail('memory is gated on project_channels', r.text());
      r.status([200, 503]);
    });

    await ctx.step('the routes of the page store are gone: remember, export, confirm, restore, Recent changes and undo → 404', async () => {
      for (const [method, path] of REMOVED) {
        const params = { projectId, layerKey: 'company', pageId: id, versionId: id };
        const r = method === 'GET' ? await world.owner.get(path, { params }) : await world.owner.post(path, {}, { params });
        r.status(404);
      }
    });

    await ctx.step('an agent’s session token on every memory route → 403 {code: use_files}: agents use their /drives mounts', async () => {
      const agent = await thread(ctx, world, null);
      for (const r of await everyRoute(agent.client)) r.status(403).body().has('$.code', 'use_files');
      (await agent.client.get(USAGE, { params: { projectId, sessionId: agent.sessionId } })).status(403).body().has('$.code', 'use_files');
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-2', meta([R.layer, R.pages, R.create, R.note, R.page, R.update, R.remove, R.history, FEATURES, SPACE_CREATE, SPACE_DM, ...STORAGE_PROBE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { channels: true });
  const projectId = project.id;
  try {
    const launch = await channel(world, 'Launch');
    const member = await team.addMember('member');
    await team.grantProjectRole(projectId, member.userId!, 'member');
    const asMember = ctx.client.as(member);
    const dmId = (await world.owner.post(DM, { agent_name: 'kortix' }, { params: { projectId } })).status(200).json<Space>().space_id;
    const storage = await hasStorage(world);

    await ctx.step('a malformed layer key and an unknown space id → 404 memory_not_found', async () => {
      for (const layerKey of ['not-a-uuid', randomUUID()]) (await world.owner.get(LAYER, { params: { projectId, layerKey } })).status(404).body().has('$.code', 'memory_not_found');
    });

    await ctx.step("another member on the owner's DM layer: read, list, create and note → 404 memory_not_found (never 403)", async () => {
      const params = { projectId, layerKey: dmId };
      (await asMember.get(LAYER, { params })).status(404).body().has('$.code', 'memory_not_found');
      (await asMember.get(PAGES, { params })).status(404).body().has('$.code', 'memory_not_found');
      (await asMember.post(PAGES, { type: 'people', title: 'Intruder' }, { params })).status(404);
      (await asMember.post(NOTES, { text: 'x' }, { params })).status(404);
    });

    await ctx.step("page ids that name the owner's DM, or escape a folder, → 404 for the member on read, edit, history and delete", async () => {
      const pageIds = [
        Buffer.from(`${dmId}\npreferences.md`).toString('base64url'),
        Buffer.from('company\n../../Users/x/Memory/preferences.md').toString('base64url'),
        'not base64!',
      ];
      for (const pageId of pageIds) {
        const p = { params: { projectId, pageId } };
        (await asMember.get(PAGE, p)).status(404);
        (await asMember.patch(PAGE, { base_version: 1, body: 'x' }, p)).status(404);
        (await asMember.get(HISTORY, p)).status(404);
        (await asMember.del(PAGE, p)).status(404);
      }
    });

    if (!storage) {
      await ctx.step('no drive storage on this target: a note in the Company, channel and DM layers → 503 drive_storage_unavailable', async () => {
        for (const layerKey of ['company', launch.space_id, dmId]) {
          (await world.owner.post(NOTES, { text: 'Launch moves to Nov 19' }, { params: { projectId, layerKey } })).status(503).body().has('$.code', 'drive_storage_unavailable');
        }
      });
      return;
    }

    await ctx.step('the layers name their folders: /Company/Memory, the channel’s Memory folder, the owner’s Memory folder with agent folder kortix', async () => {
      const { personalFolder } = await driveOf(world.owner, projectId);
      read<MemoryLayer>((await world.owner.get(LAYER, { params: { projectId, layerKey: 'company' } })).status(200), (b) =>
        b.schema(MemoryLayerSchema).has('$.folder', '/Company/Memory').has('$.agent_folder', null).has('$.can_write', true));
      (await world.owner.get(LAYER, { params: { projectId, layerKey: launch.space_id } })).status(200).body().has('$.folder', '/Company/Channels/launch/Memory');
      (await world.owner.get(LAYER, { params: { projectId, layerKey: dmId } })).status(200).body()
        .has('$.folder', `${personalFolder}/Memory`).has('$.agent_folder', `${personalFolder}/Memory/kortix`);
    });

    await ctx.step('every member reads and writes Company and channel memory', async () => {
      (await asMember.get(LAYER, { params: { projectId, layerKey: 'company' } })).status(200).body().has('$.can_write', true);
      (await asMember.post(PAGES, { type: 'people', title: 'Priya' }, { params: { projectId, layerKey: launch.space_id } })).status(201).body().has('$.can_delete', true);
    });

    await ctx.step('archive #launch → its layer reads {read_only: true, can_write: false}; create, note, edit and delete → 409 layer_read_only', async () => {
      const page = (await world.owner.get(PAGES, { params: { projectId, layerKey: launch.space_id } })).status(200).json<{ pages: MemoryPageSummary[] }>().pages[0]!;
      (await world.owner.patch(SPACE, { archived: true }, { params: { projectId, spaceId: launch.space_id } })).status(200);
      (await world.owner.get(LAYER, { params: { projectId, layerKey: launch.space_id } })).status(200).body().has('$.read_only', true).has('$.can_write', false);
      (await world.owner.post(PAGES, { type: 'other', title: 'Late' }, { params: { projectId, layerKey: launch.space_id } })).status(409).body().has('$.code', 'layer_read_only');
      (await world.owner.post(NOTES, { text: 'late' }, { params: { projectId, layerKey: launch.space_id } })).status(409).body().has('$.code', 'layer_read_only');
      const full = (await world.owner.get(PAGE, { params: { projectId, pageId: page.page_id } })).status(200).json<MemoryPage>();
      (await world.owner.patch(PAGE, { base_version: full.version_no, body: 'x' }, { params: { projectId, pageId: page.page_id } })).status(409).body().has('$.code', 'layer_read_only');
      (await world.owner.del(PAGE, { params: { projectId, pageId: page.page_id } })).status(409).body().has('$.code', 'layer_read_only');
      (await world.owner.patch(SPACE, { archived: false }, { params: { projectId, spaceId: launch.space_id } })).status(200);
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-3', meta([R.create, R.update, R.note, R.search, FEATURES]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const projectId = project.id;
  const layer = { params: { projectId, layerKey: 'company' } };
  const page = { params: { projectId, pageId: Buffer.from('company\nx.md').toString('base64url') } };
  try {
    await ctx.step('a create the schema refuses → 400 invalid_input: type note, a 121-character title, a two-line summary, an unknown field', async () => {
      for (const body of [
        { type: 'note', title: 'x' },
        { type: 'people', title: 'x'.repeat(121) },
        { type: 'people', title: 'x', summary: 'one\ntwo' },
        { type: 'people', title: 'x', owner: 'me' },
      ]) (await world.owner.post(PAGES, body, layer)).status(400).body().has('$.code', 'invalid_input');
    });

    await ctx.step('an edit is the body only: a title, type or summary, or no body → 400 invalid_input', async () => {
      for (const body of [{ base_version: 1, body: 'x', title: 'New' }, { base_version: 1, body: 'x', type: 'people' }, { base_version: 1, body: 'x', summary: 's' }, { base_version: 1 }]) {
        (await world.owner.patch(PAGE, body, page)).status(400).body().has('$.code', 'invalid_input');
      }
    });

    await ctx.step('a note of 1,001 characters or blank → 400; search q of 1 character, 201, or limit 21 → 400', async () => {
      (await world.owner.post(NOTES, { text: 'x'.repeat(1001) }, layer)).status(400).body().has('$.code', 'invalid_input');
      (await world.owner.post(NOTES, { text: '   ' }, layer)).status(400);
      for (const query of [{ q: 'x' }, { q: 'x'.repeat(201) }, { q: 'pricing', limit: '21' }]) {
        (await world.owner.get(SEARCH, { params: { projectId }, query })).status(400).body().has('$.code', 'invalid_input');
      }
    });
  } finally {
    await world.close();
  }
});

flow(
  'MEMORY-4',
  meta([R.layer, R.pages, R.create, R.note, R.page, R.update, R.remove, R.history, R.search, FEATURES, DRIVE_LIST, DRIVE_FILES, DRIVE_READ, DRIVE_WRITE, ...STORAGE_PROBE], { tags: ['deployed'] }),
  async (ctx) => {
    const { project, world } = await openWorld(ctx);
    const projectId = project.id;
    try {
      if (!(await hasStorage(world))) return await noStorage(ctx, world);
      const { driveId } = await driveOf(world.owner, projectId);
      const layer = { params: { projectId, layerKey: 'company' } };
      const pageOf = (pageId: string) => ({ params: { projectId, pageId } });

      let before: Record<string, string> = {};
      await ctx.step('a file already in /Company/Memory (written through Files) is a page in place: listed, read, nothing written', async () => {
        (await world.owner.put('/v1/drives/:driveId/files/content', '# Launch plan\n\nShip on 2026-11-02, pricing at $49.\n', {
          params: { driveId }, query: { path: '/Company/Memory/launch-plan.md' }, headers: { 'content-type': 'application/octet-stream' }, raw: true,
        })).status(200);
        before = await checksums(world.owner, driveId);
        const pages = read<{ pages: MemoryPageSummary[] }>((await world.owner.get(PAGES, layer)).status(200), (b) => b.schema(MemoryPageListSchema)).pages;
        const launch = pages.find((p) => p.path === '/Company/Memory/launch-plan.md');
        if (!launch || launch.title !== 'Launch plan' || launch.type !== 'other') fail('the file is not a page', pages);
        (await world.owner.get(PAGE, pageOf(launch.page_id))).status(200).body().has('$.body', 'Ship on 2026-11-02, pricing at $49.\n');
        if (changed(before, await checksums(world.owner, driveId)).length) fail('a read changed Files', changed(before, await checksums(world.owner, driveId)));
      });

      let created: MemoryPage;
      await ctx.step('create → 201: decisions/pricing.md with front-matter and a # title; the same title again → 409 title_taken with page_id', async () => {
        created = read<MemoryPage>((await world.owner.post(PAGES, { type: 'decisions', title: 'Pricing', summary: 'Stays at $49', body: 'We charge $49 per seat.' }, layer)).status(201), (b) =>
          b.schema(MemoryPageSchema).has('$.path', '/Company/Memory/decisions/pricing.md').has('$.type', 'decisions').has('$.updated_by.kind', 'person'));
        const file = (await world.owner.get('/v1/drives/:driveId/files/content', { params: { driveId }, query: { path: created.path } })).status(200).text();
        if (!file.startsWith('---\nsummary: Stays at $49\nupdated_by: ') || !file.endsWith('---\n# Pricing\n\nWe charge $49 per seat.\n')) fail('the file', file);
        (await world.owner.post(PAGES, { type: 'decisions', title: 'pricing' }, layer)).status(409).body().has('$.code', 'title_taken').has('$.page_id', created.page_id);
      });

      await ctx.step('a body over 262,144 bytes → 413 page_too_large; a key shape → 422 secret_detected, not echoed', async () => {
        (await world.owner.post(PAGES, { type: 'other', title: 'Big', body: 'x'.repeat(262_145) }, layer)).status(413).body().has('$.code', 'page_too_large');
        const r = (await world.owner.post(PAGES, { type: 'other', title: 'Key', body: `key ${FAKE_KEY}` }, layer)).status(422);
        r.body().has('$.code', 'secret_detected');
        if (r.text().includes(FAKE_KEY)) fail('the refusal echoed the secret', r.text());
      });

      let edited: MemoryPage;
      await ctx.step('edit the body → 200, title and front-matter kept; a stale base_version → 409 version_conflict', async () => {
        edited = (await world.owner.patch(PAGE, { base_version: created!.version_no, body: 'We charge $59 per seat.' }, pageOf(created!.page_id))).status(200).json<MemoryPage>();
        if (edited.body !== 'We charge $59 per seat.\n' || edited.title !== 'Pricing' || edited.summary !== 'Stays at $49') fail('the edit', edited);
        (await world.owner.patch(PAGE, { base_version: created!.version_no, body: 'stale' }, pageOf(created!.page_id))).status(409).body().has('$.code', 'version_conflict');
      });

      await ctx.step('history from Drive commits → 2 versions newest first: update, then create', async () => {
        const versions = read<{ versions: MemoryVersion[] }>((await world.owner.get(HISTORY, pageOf(created!.page_id))).status(200), (b) => b.schema(MemoryVersionListSchema)).versions;
        const shape = versions.map((v) => [v.op, v.snapshot.body]);
        if (JSON.stringify(shape) !== JSON.stringify([['update', 'We charge $59 per seat.\n'], ['create', 'We charge $49 per seat.\n']])) fail('history', shape);
      });

      await ctx.step('a note → 201: one line appended to Notes.md, listed first; search finds the pre-existing file', async () => {
        (await world.owner.post(NOTES, { text: 'Launch moves to Nov 19' }, layer)).status(201).body().has('$.type', 'note').has('$.path', '/Company/Memory/Notes.md');
        read((await world.owner.get(PAGES, layer)).status(200), (b) => b.schema(MemoryPageListSchema).has('$.pages[0].title', 'Notes'));
        const hits = read<{ hits: { title: string }[] }>((await world.owner.get(SEARCH, { params: { projectId }, query: { q: 'ship on' } })).status(200), (b) => b.schema(MemorySearchResultSchema)).hits;
        if (!hits.some((h) => h.title === 'Launch plan')) fail('search', hits);
      });

      await ctx.step('delete → 200; the page → 404 and the file is gone from Files (no trash)', async () => {
        read((await world.owner.del(PAGE, pageOf(created!.page_id))).status(200), (b) => b.schema(MemoryDeleteResultSchema));
        (await world.owner.get(PAGE, pageOf(created!.page_id))).status(404);
        if ((await checksums(world.owner, driveId))[created!.path]) fail('the deleted file is still in Files', created!.path);
      });
    } finally {
      await world.close();
    }
  },
);

flow('MEMORY-5', meta([R.layer, R.pages, FEATURES, DRIVE_LIST, DRIVE_FILES, DRIVE_READ, DRIVE_WRITE, SPACE_CREATE, SPACE_DM, ...STORAGE_PROBE]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const projectId = project.id;
  try {
    if (!(await hasStorage(world))) return await noStorage(ctx, world);
    const { driveId, personalFolder } = await driveOf(world.owner, projectId);
    const put = async (path: string, text: string) =>
      (await world.owner.put('/v1/drives/:driveId/files/content', text, { params: { driveId }, query: { path }, headers: { 'content-type': 'application/octet-stream' }, raw: true })).status(200);
    await put('/Company/Memory/launch-plan.md', '# Launch plan\n');
    await put(`${personalFolder}/Memory/preferences.md`, '# Preferences\n\nShort answers.\n');
    let before: Record<string, string> = {};

    await ctx.step('project_channels on: Company and the DM layer list the files already in Drive, in place', async () => {
      await world.setFeature('project_channels', true);
      const dmId = (await world.owner.post(DM, { agent_name: 'kortix' }, { params: { projectId } })).status(200).json<Space>().space_id;
      const company = (await world.owner.get(PAGES, { params: { projectId, layerKey: 'company' } })).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      const dm = (await world.owner.get(PAGES, { params: { projectId, layerKey: dmId } })).status(200).json<{ pages: MemoryPageSummary[] }>().pages;
      if (!company.some((p) => p.path === '/Company/Memory/launch-plan.md') || !dm.some((p) => p.path === `${personalFolder}/Memory/preferences.md`)) fail('pages', { company, dm });
      before = await checksums(world.owner, driveId);
    });

    await ctx.step('project_channels off: no file is moved, copied, renamed or deleted (sha256 of every file the owner sees), and memory still reads', async () => {
      await world.setFeature('project_channels', false);
      // The toggle effect runs behind the PATCH response: read Files three times over ~4.5 s.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const diff = changed(before, await checksums(world.owner, driveId));
        if (diff.length) fail('files changed on turn-off', diff);
      }
      (await world.owner.get(PAGES, { params: { projectId, layerKey: 'company' } })).status(200);
    });

    await ctx.step('project_channels on again: still no file changed', async () => {
      await world.setFeature('project_channels', true);
      const diff = changed(before, await checksums(world.owner, driveId));
      if (diff.length) fail('files changed on turn-on', diff);
    });
  } finally {
    await world.close();
  }
});

flow('MEMORY-12', meta([R.usage, FEATURES, SPACE_CREATE, TOKEN_MINT]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { channels: true });
  const projectId = project.id;
  try {
    const launch = await channel(world, 'Launch');
    const agent = await thread(ctx, world, launch.space_id);
    const member = await team.addMember('member');
    await team.grantProjectRole(projectId, member.userId!, 'member');

    await ctx.step('"Used memory" before the thread’s first turn → 200 {loaded_at: null, layers: []}', async () => {
      read<unknown>((await world.owner.get(USAGE, { params: { projectId, sessionId: agent.sessionId } })).status(200), (b) =>
        b.schema(MemoryUsageSchema).has('$.loaded_at', null).has('$.layers', []));
    });

    await ctx.step('an unknown thread → 404 session_not_found', async () => {
      (await world.owner.get(USAGE, { params: { projectId, sessionId: randomUUID() } })).status(404).body().has('$.code', 'session_not_found');
    });
  } finally {
    await world.close();
  }
});

const FEATURES_PATH = '/v1/projects/:projectId/features';
const ONBOARDING = '/v1/projects/:projectId/onboarding/channels';
const MARKS = '/v1/projects/:projectId/onboarding/channels/marks';
const ONBOARDING_ROUTES = ['GET /v1/projects/:projectId/onboarding/channels', 'POST /v1/projects/:projectId/onboarding/channels/marks'];
const SPACE_LIST = 'GET /v1/projects/:projectId/spaces';

/**
 * Channels onboarding. The flag's toggle effect runs
 * behind the PATCH response, so every step after a toggle polls for the
 * effect's result with a bounded wait.
 */
flow(
  'MEMORY-16',
  meta([...ONBOARDING_ROUTES, FEATURES, SPACE_LIST, SPACE_CREATE, SPACE_DM, R.note, RESOURCE_GRANTS]),
  async (ctx) => {
    const { team, project, world } = await openWorld(ctx);
    const projectId = project.id;
    const params = { projectId };
    const member = await team.addMember('member');
    await team.grantProjectRole(projectId, member.userId!, 'member');
    // A DM runs its agent: the member needs the agent's run grant to open one.
    await world.grantRun('kortix', member);
    // An account member with no access to this project: never on its roster.
    const outsider = await team.addMember('member');
    const asMember = ctx.client.as(member);
    const stateOf = async (client: Client) => read<ChannelsOnboarding>((await client.get(ONBOARDING, { params })).status(200), (b) => b.schema(ChannelsOnboardingSchema));
    const mark = (client: Client, value: string) => client.post(MARKS, { mark: value }, { params });
    const closed = { visible: true, create_channel: false, remember: false, open_dm: false };
    /** A session started while Channels is off: no space. `world.close()` deletes it. */
    const offSession = async () => {
      const sessionId = randomUUID();
      world.sessions.push(sessionId);
      await world.db.query(
        `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility)
         VALUES ($1, $2, $3, $1, 'kortix', 'stopped', $4, 'project')`,
        [sessionId, world.accountId, projectId, world.ownerUserId],
      );
      return sessionId;
    };
    /** The toggle effect filed `sessionId` into `#general`: poll the row, at most 30 s. */
    const filedIntoGeneral = (sessionId: string) =>
      waitFor(
        async () =>
          (
            await world.db.query<{ filed: boolean }>(
              `SELECT s.space_id IS NOT NULL AND s.space_id = g.space_id AS filed
                 FROM kortix.project_sessions s
                 LEFT JOIN kortix.project_spaces g ON g.project_id = s.project_id AND g.is_default
                WHERE s.session_id = $1`,
              [sessionId],
            )
          ).rows[0]?.filed === true,
        { until: Boolean, timeoutMs: 30_000, intervalMs: 250, description: 'the toggle effect to file the session into #general' },
      );
    const channelsMeta = async () =>
      (await world.db.query<{ channels: unknown }>("SELECT metadata->'channels' AS channels FROM kortix.projects WHERE project_id = $1", [projectId])).rows[0]?.channels ?? null;
    const introMarks = async () =>
      (await world.db.query<{ user_id: string }>("SELECT user_id FROM kortix.project_user_marks WHERE project_id = $1 AND mark = 'channels_intro'", [projectId])).rows.map((r) => r.user_id);
    try {
      await ctx.step('with project_channels off, GET /onboarding/channels and POST …/marks → 403 feature_disabled', async () => {
        for (const r of [await world.owner.get(ONBOARDING, { params }), await mark(world.owner, 'channels_intro')]) {
          r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'project_channels');
        }
      });

      await ctx.step('D7: a project member turning project_channels on → 403 and the flag stays off', async () => {
        (await asMember.patch(FEATURES_PATH, { feature: 'project_channels', enabled: true }, { params })).status(403);
        (await world.owner.get(ONBOARDING, { params })).status(403).body().has('$.code', 'feature_disabled');
      });

      const firstOff = await offSession();
      await ctx.step('the first turn-on by the owner files the session started while off into #general, records no "turned on again" line and marks no intro', async () => {
        await world.setFeature('project_channels', true);
        await filedIntoGeneral(firstOff);
        (await world.owner.get(SPACES, { params })).status(200).body().schema(SpaceListSchema).has('$.general_notice', undefined);
        if ((await channelsMeta()) !== null) fail('a first turn-on recorded metadata.channels', await channelsMeta());
        if ((await introMarks()).length !== 0) fail('a first turn-on marked intros', await introMarks());
      });

      await ctx.step('a new member: {intro_seen: false, get_started: {visible: true, every row false}}; so is the owner', async () => {
        (await asMember.get(ONBOARDING, { params })).status(200).body().has('$.intro_seen', false).has('$.get_started', closed);
        (await world.owner.get(ONBOARDING, { params })).status(200).body().has('$.intro_seen', false).has('$.get_started', closed);
      });

      await ctx.step('marks: channels_intro → 204, again → 204 (idempotent), an unknown mark → 400; the member reads intro_seen true, the owner still false', async () => {
        (await mark(asMember, 'channels_intro')).status(204);
        (await mark(asMember, 'channels_intro')).status(204);
        (await mark(asMember, 'tour')).status(400);
        if ((await stateOf(asMember)).intro_seen !== true) fail('the member’s intro mark', await stateOf(asMember));
        if ((await stateOf(world.owner)).intro_seen !== false) fail('one member’s mark changed the owner’s state', await stateOf(world.owner));
      });

      await ctx.step('each fact flips its own row: a channel created, then a note saved in #general, then a DM opened; all three hide the block', async () => {
        (await asMember.post(SPACES, { name: 'Onboarding' }, { params })).status(201);
        (await asMember.get(ONBOARDING, { params })).status(200).body().has('$.get_started', { visible: true, create_channel: true, remember: false, open_dm: false });
        const general = (await world.owner.get(SPACES, { params })).status(200).json<{ spaces: (Space & { is_default: boolean })[] }>().spaces.find((s) => s.is_default);
        if (!general) fail('no #general', null);
        // A note in #general's memory is a Drive write; a target without drive storage answers 503 and the member records the row's mark instead.
        const note = await asMember.post(NOTES, { text: 'Launch moves to Monday' }, { params: { projectId, layerKey: general.space_id } });
        if (note.statusCode === 503) (await mark(asMember, 'get_started.remember')).status(204);
        else note.status(201);
        (await asMember.get(ONBOARDING, { params })).status(200).body().has('$.get_started', { visible: true, create_channel: true, remember: true, open_dm: false });
        (await asMember.post(DM, { agent_name: 'kortix' }, { params })).status(200);
        (await asMember.get(ONBOARDING, { params })).status(200).body().has('$.get_started', { visible: false, create_channel: true, remember: true, open_dm: true });
        // The member's facts are the member's: the owner's rows stay open.
        (await world.owner.get(ONBOARDING, { params })).status(200).body().has('$.get_started', closed);
      });

      await ctx.step('the owner dismisses "Get started" → 204; visible false with every row still false', async () => {
        (await mark(world.owner, 'get_started.dismissed')).status(204);
        (await world.owner.get(ONBOARDING, { params })).status(200).body().has('$.get_started', { ...closed, visible: false });
      });

      await ctx.step('D7: a project member turning project_channels off → 403 and Channels stays on', async () => {
        (await asMember.patch(FEATURES_PATH, { feature: 'project_channels', enabled: false }, { params })).status(403);
        (await asMember.get(ONBOARDING, { params })).status(200);
      });

      let secondOff = '';
      await ctx.step('flag off → both onboarding routes 403 feature_disabled; a session started now has no space', async () => {
        await world.setFeature('project_channels', false);
        for (const r of [await asMember.get(ONBOARDING, { params }), await mark(asMember, 'get_started.dm')]) r.status(403).body().has('$.code', 'feature_disabled');
        secondOff = await offSession();
      });

      await ctx.step('turned on again: the session moves into #general, GET /spaces carries general_notice {kind: reenabled, count: 1}, and the owner’s intro is marked seen', async () => {
        await world.setFeature('project_channels', true);
        await filedIntoGeneral(secondOff);
        const owner = await waitFor(() => stateOf(world.owner), {
          until: (s) => s.intro_seen,
          timeoutMs: 30_000,
          intervalMs: 250,
          description: 'the turn-on-again effect to mark the intros',
        });
        if (owner.intro_seen !== true) fail('owner intro', owner);
        const list = read<SpaceList>((await world.owner.get(SPACES, { params })).status(200), (b) => b.schema(SpaceListSchema).has('$.general_notice.kind', 'reenabled').has('$.general_notice.count', 1));
        const recorded = (await channelsMeta()) as { reenabled_at?: string; reenabled_count?: number } | null;
        if (recorded?.reenabled_count !== 1 || list.general_notice?.at !== recorded.reenabled_at) fail('metadata.channels', { recorded, notice: list.general_notice });
      });

      await ctx.step('the intro is marked for project members only: the owner and the member, never the account member without project access', async () => {
        const marked = await introMarks();
        for (const userId of [world.ownerUserId, member.userId!]) if (!marked.includes(userId)) fail('a project member has no intro mark', { userId, marked });
        if (marked.includes(outsider.userId!)) fail('an account member without project access got an intro mark', marked);
        (await ctx.client.as(outsider).get(ONBOARDING, { params })).status([403, 404]);
      });
    } finally {
      await world.close();
    }
  },
);
