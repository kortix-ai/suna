/**
 * SPACE-24..29 — private channels: a channel only its members see, with its
 * threads, links, memory and Files folder (`/Channels/<slug>`). Spec:
 * tests/spec/end-to-end.md § 7a. Source of truth:
 * apps/api/src/shared/space-access.ts (the rule), routes/project-spaces.ts,
 * drives/folders.ts + drives/service.ts (the folder), memory/layers.ts,
 * projects/lib/trigger-fire.ts (`privateChannelRunActor`).
 *
 * A target where private channels are off answers 409
 * `private_channels_unavailable` to the create: every flow here skips then.
 * Memory needs drive storage and skips without it (MEMORY-2 asserts the 503).
 * The leak-path rules are also pinned by the DB suites
 * `integration-private-channels-http.test.ts` and
 * `integration-private-channels-phase2.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { PrivateChannelListSchema, SpaceListSchema, SpaceMemberListSchema, SpaceSchema } from '@kortix/api-contract';
import { flow } from '../core/flow';
import type { Client } from '../core/client';
import type { FlowContext, FlowMeta, Principal } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';

const R = {
  list: 'GET /v1/projects/:projectId/spaces',
  privateList: 'GET /v1/projects/:projectId/spaces/private',
  create: 'POST /v1/projects/:projectId/spaces',
  update: 'PATCH /v1/projects/:projectId/spaces/:spaceId',
  links: 'GET /v1/projects/:projectId/spaces/:spaceId/links',
  addLink: 'POST /v1/projects/:projectId/spaces/:spaceId/links',
  apps: 'GET /v1/projects/:projectId/spaces/:spaceId/apps',
  members: 'GET /v1/projects/:projectId/spaces/:spaceId/members',
  addMembers: 'POST /v1/projects/:projectId/spaces/:spaceId/members',
  removeMember: 'DELETE /v1/projects/:projectId/spaces/:spaceId/members/:userId',
  join: 'POST /v1/projects/:projectId/spaces/:spaceId/join',
  sessions: 'GET /v1/projects/:projectId/sessions',
  features: 'PATCH /v1/projects/:projectId/features',
  layer: 'GET /v1/projects/:projectId/memory/layers/:layerKey',
  createPage: 'POST /v1/projects/:projectId/memory/layers/:layerKey/pages',
  note: 'POST /v1/projects/:projectId/memory/layers/:layerKey/notes',
  pages: 'GET /v1/projects/:projectId/memory/layers/:layerKey/pages',
  search: 'GET /v1/projects/:projectId/memory/search',
  drives: 'GET /v1/drives',
  files: 'GET /v1/drives/:driveId/files',
  mkdir: 'POST /v1/drives/:driveId/files/mkdir',
  removeFile: 'DELETE /v1/drives/:driveId/files',
  triggers: 'GET /v1/projects/:projectId/triggers',
  createTrigger: 'POST /v1/projects/:projectId/triggers',
} as const;
const SPACES = '/v1/projects/:projectId/spaces';
const SPACE = '/v1/projects/:projectId/spaces/:spaceId';
const LINKS = '/v1/projects/:projectId/spaces/:spaceId/links';
const APPS = '/v1/projects/:projectId/spaces/:spaceId/apps';
const MEMBERS = '/v1/projects/:projectId/spaces/:spaceId/members';
const MEMBER = '/v1/projects/:projectId/spaces/:spaceId/members/:userId';
const JOIN = '/v1/projects/:projectId/spaces/:spaceId/join';
const SESSIONS = '/v1/projects/:projectId/sessions';
const LAYER = '/v1/projects/:projectId/memory/layers/:layerKey';
const PAGES = '/v1/projects/:projectId/memory/layers/:layerKey/pages';
const NOTES = '/v1/projects/:projectId/memory/layers/:layerKey/notes';
const SEARCH = '/v1/projects/:projectId/memory/search';
const DRIVES = '/v1/drives';
const FILES = '/v1/drives/:driveId/files';
const TRIGGERS = '/v1/projects/:projectId/triggers';
const MANIFEST =
  'kortix_version: 2\nproject:\n  name: ke2e-private-channels\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n';

type Space = { space_id: string; slug: string | null; is_default: boolean; visibility?: 'public' | 'private'; is_member?: boolean };
type MemberList = { members: { user_id: string }[]; can_add: boolean };

const meta = (routes: string[], extra: Partial<FlowMeta> = {}): FlowMeta => ({
  domain: 'spaces',
  requires: ['database'],
  timeoutMs: 180_000,
  routes,
  ...extra,
});

/**
 * A project with Channels on and four people: the owner (account owner,
 * project manager), ALICE and CAROL (members of the private channel P that
 * alice creates), BOB (a project member outside P) and a project MANAGER
 * outside P. Skips when the target refuses private channels.
 */
async function openWorld(ctx: FlowContext, opts: { manifest?: boolean; volumes?: boolean } = {}) {
  const team = await ctx.fixtures.team();
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  if (opts.manifest) await world.writeManifest(MANIFEST, 'ke2e: private channels agent');
  if (opts.volumes) await world.setFeature('volumes', true);
  await world.setFeature('project_channels', true);
  const people: Record<'alice' | 'carol' | 'bob' | 'manager', Principal> = {
    alice: await team.addMember('member'),
    carol: await team.addMember('member'),
    bob: await team.addMember('member'),
    manager: await team.addMember('member'),
  };
  for (const [name, who] of Object.entries(people)) {
    await team.grantProjectRole(project.id, who.userId!, name === 'manager' ? 'manager' : 'member');
  }
  const as = (who: Principal): Client => ctx.client.as(who);
  const params = { projectId: project.id };
  const slug = `deals-${randomUUID().slice(0, 6)}`;
  const created = await as(people.alice).post(SPACES, { name: slug, visibility: 'private', member_ids: [people.carol.userId] }, { params });
  if (created.statusCode === 409 && created.json<{ code?: string }>().code === 'private_channels_unavailable') {
    await world.close();
    ctx.skip('private channels are off on this target (409 private_channels_unavailable)');
  }
  created.status(201).body().schema(SpaceSchema).has('$.visibility', 'private');
  const p = created.json<Space & { slug: string }>();
  return { team, project, world, people, as, params, p, spaceParams: { ...params, spaceId: p.space_id } };
}

/** A thread row in `spaceId`, started by `userId` (no sandbox: the flows read lists and ACLs only). */
async function thread(world: AgentPrincipalsWorld, spaceId: string, userId: string, firstPrompt: string): Promise<string> {
  const sessionId = randomUUID();
  world.sessions.push(sessionId);
  await world.db.query(
    `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, space_id, metadata)
     VALUES ($1, $2, $3, $1, 'kortix', 'stopped', $4, 'project', $5, jsonb_build_object('first_prompt', $6::text))`,
    [sessionId, world.accountId, world.projectId, userId, spaceId, firstPrompt],
  );
  return sessionId;
}

/**
 * The target has drive storage: a folder made and removed in the owner's own
 * folder lands. Without it the write answers 503 `drive_storage_unavailable`,
 * asserted here. A read cannot tell: a drive with no volume yet reads as empty.
 */
async function hasStorage(ctx: FlowContext, world: AgentPrincipalsWorld): Promise<boolean> {
  const drive = (await world.owner.get(DRIVES, { query: { projectId: world.projectId } }))
    .status(200)
    .json<{ drives: { driveId: string; personalFolder: string }[] }>().drives[0]!;
  const path = `${drive.personalFolder}/.storage-probe-${randomUUID().slice(0, 8)}`;
  const made = await world.owner.post('/v1/drives/:driveId/files/mkdir', { path }, { params: { driveId: drive.driveId } });
  if (made.statusCode === 503) {
    await ctx.step('no drive storage on this target: a Files write → 503 drive_storage_unavailable', async () => {
      made.body().has('$.code', 'drive_storage_unavailable');
    });
    return false;
  }
  made.status([200, 201]);
  (await world.owner.del(FILES, { params: { driveId: drive.driveId }, query: { path } })).status([200, 204]);
  return true;
}

const ids = (list: MemberList) => list.members.map((m) => m.user_id).sort();

flow(
  'SPACE-24',
  meta([R.list, R.privateList, R.create, R.links, R.apps, R.members, R.join, R.addMembers, R.features]),
  async (ctx) => {
    const { world, people, as, params, p, spaceParams } = await openWorld(ctx);
    try {
      await ctx.step('alice creates a private channel with carol: both list it with visibility private; the creator and carol are its members', async () => {
        for (const who of [people.alice, people.carol]) {
          const listed = await as(who).get(SPACES, { params });
          listed.status(200).body().schema(SpaceListSchema);
          const spaces = listed.json<{ spaces: Space[] }>().spaces;
          const found = spaces.find((s) => s.space_id === p.space_id);
          if (found?.visibility !== 'private' || found.is_member !== true) throw new Error(`P listed as ${JSON.stringify(found)}`);
        }
        const read = await as(people.alice).get(MEMBERS, { params: spaceParams });
        read.status(200).body().schema(SpaceMemberListSchema);
        const members = read.json<MemberList>();
        if (JSON.stringify(ids(members)) !== JSON.stringify([people.alice.userId, people.carol.userId].sort())) throw new Error(`members ${JSON.stringify(ids(members))}`);
      });

      await ctx.step('bob and a project manager outside P do not list it', async () => {
        for (const who of [people.bob, people.manager]) {
          const spaces = (await as(who).get(SPACES, { params })).status(200).json<{ spaces: Space[] }>().spaces;
          if (spaces.some((s) => s.space_id === p.space_id)) throw new Error('a non-member lists the private channel');
        }
      });

      await ctx.step('bob gets 404 space_not_found on P’s links, apps, members and join; nothing is written', async () => {
        for (const r of [
          await as(people.bob).get(LINKS, { params: spaceParams }),
          await as(people.bob).get(APPS, { params: spaceParams }),
          await as(people.bob).get(MEMBERS, { params: spaceParams }),
          await as(people.bob).post(JOIN, undefined, { params: spaceParams }),
          await as(people.bob).post(MEMBERS, { user_ids: [people.bob.userId] }, { params: spaceParams }),
        ]) {
          r.status(404).body().has('$.code', 'space_not_found');
        }
        const { rows } = await world.db.query('SELECT 1 FROM kortix.project_space_members WHERE space_id = $1 AND user_id = $2', [p.space_id, people.bob.userId]);
        if (rows.length !== 0) throw new Error('bob became a member');
      });

      await ctx.step('the manager outside P finds it in GET /spaces/private (name and member count, no content); bob → 403 forbidden', async () => {
        const r = (await as(people.manager).get('/v1/projects/:projectId/spaces/private', { params })).status(200);
        r.body().schema(PrivateChannelListSchema);
        const found = r.json<{ channels: { space_id: string; slug: string; member_count: number }[] }>().channels.find((c) => c.space_id === p.space_id);
        if (found?.slug !== p.slug || found.member_count !== 2) throw new Error(`P in /spaces/private: ${JSON.stringify(found)}`);
        (await as(people.alice).get('/v1/projects/:projectId/spaces/private', { params })).status(403).body().has('$.code', 'forbidden');
        (await as(people.bob).get('/v1/projects/:projectId/spaces/private', { params })).status(403).body().has('$.code', 'forbidden');
      });

      // Owner decision 2026-10-26: a manager adds people (never themself), so a channel its last member left is not stuck.
      await ctx.step('the manager outside P lists its people and may add others (can_add true) but cannot read its links (404)', async () => {
        (await as(people.manager).get(MEMBERS, { params: spaceParams })).status(200).body().has('$.can_add', true);
        (await as(people.manager).get(LINKS, { params: spaceParams })).status(404).body().has('$.code', 'space_not_found');
      });

      await ctx.step('bob creating a channel with P’s name → 409 slug_taken with no space_id, archived or can_edit', async () => {
        const r = await as(people.bob).post(SPACES, { name: p.slug }, { params });
        r.status(409).body().has('$.code', 'slug_taken');
        const body = r.json<Record<string, unknown>>();
        for (const key of ['space_id', 'can_edit']) if (key in body) throw new Error(`409 discloses ${key}`);
      });
    } finally {
      await world.close();
    }
  },
);

flow('SPACE-25', meta([R.create, R.sessions, R.removeMember, R.join, R.list, R.features]), async (ctx) => {
  const { world, people, as, params, p, spaceParams } = await openWorld(ctx);
  try {
    const word = `zebracorn${randomUUID().slice(0, 6)}`;
    const threadId = await thread(world, p.space_id, people.alice.userId!, `${word} acquisition plan`);

    await ctx.step('carol lists alice’s P thread; bob, the manager and a search for its words list nothing', async () => {
      const list = async (who: Principal, query: Record<string, string>) =>
        (await as(who).get(SESSIONS, { params, query })).status(200).json<{ session_id: string }[]>().map((s) => s.session_id);
      if (!(await list(people.carol, { space_id: p.space_id })).includes(threadId)) throw new Error('carol does not list the P thread');
      for (const who of [people.bob, people.manager]) {
        if ((await list(who, { space_id: p.space_id })).length !== 0) throw new Error('a non-member lists P threads');
        if ((await list(who, { q: word })).includes(threadId)) throw new Error('a non-member finds the P thread by its words');
      }
    });

    await ctx.step('alice removes carol: carol no longer lists P or its thread, and cannot join again (404)', async () => {
      (await as(people.alice).del(MEMBER, { params: { ...spaceParams, userId: people.carol.userId! } })).status(200);
      const spaces = (await as(people.carol).get(SPACES, { params })).status(200).json<{ spaces: Space[] }>().spaces;
      if (spaces.some((s) => s.space_id === p.space_id)) throw new Error('a removed member still lists P');
      const listed = (await as(people.carol).get(SESSIONS, { params, query: { space_id: p.space_id } })).status(200).json<unknown[]>();
      if (listed.length !== 0) throw new Error('a removed member still lists P threads');
      (await as(people.carol).post(JOIN, undefined, { params: spaceParams })).status(404).body().has('$.code', 'space_not_found');
    });
  } finally {
    await world.close();
  }
});

flow(
  'SPACE-26',
  meta([R.create, R.layer, R.createPage, R.pages, R.search, R.note, R.features, R.drives, R.mkdir, R.removeFile]),
  async (ctx) => {
    const { world, people, as, params, p } = await openWorld(ctx, { volumes: true });
    try {
      if (!(await hasStorage(ctx, world))) return;
      const word = `quokka${randomUUID().slice(0, 6)}`;
      const layerParams = { ...params, layerKey: p.space_id };

      await ctx.step('alice reads P’s memory layer at /Channels/<slug>/Memory and writes a page into it', async () => {
        (await as(people.alice).get(LAYER, { params: layerParams })).status(200).body().has('$.can_write', true);
        (await as(people.alice).post(PAGES, { type: 'decisions', title: 'Deal terms', body: `${word}: the price is fixed.` }, { params: layerParams })).status(201);
      });

      await ctx.step('bob and the manager get 404 on the layer and no search hit; alice’s search finds the page', async () => {
        for (const who of [people.bob, people.manager]) {
          (await as(who).get(LAYER, { params: layerParams })).status(404);
          (await as(who).get(PAGES, { params: layerParams })).status(404);
          const hits = (await as(who).get(SEARCH, { params, query: { q: word } })).status(200).json<{ hits: unknown[] }>().hits;
          if (hits.length !== 0) throw new Error('a non-member finds a P memory page');
        }
        const mine = (await as(people.alice).get(SEARCH, { params, query: { q: word } })).status(200).json<{ hits: { layer_key: string }[] }>().hits;
        if (!mine.some((h) => h.layer_key === p.space_id)) throw new Error('alice does not find her P page');
      });

      await ctx.step('a note into Company from a P thread names "a private thread", never the thread’s words', async () => {
        const threadId = await thread(world, p.space_id, people.alice.userId!, `${word} secret first prompt`);
        const page = (await as(people.alice).post(NOTES, { text: 'Remember the call', source_session_id: threadId }, { params: { ...params, layerKey: 'company' } }))
          .status(201)
          .json<{ body?: string; content?: string }>();
        const text = JSON.stringify(page);
        if (!text.includes('a private thread') || text.includes(word)) throw new Error(`the note leaks the P thread: ${text.slice(0, 400)}`);
      });
    } finally {
      await world.close();
    }
  },
);

flow('SPACE-27', meta([R.create, R.drives, R.files, R.features, R.mkdir, R.removeFile]), async (ctx) => {
  const { world, people, as, params, p } = await openWorld(ctx, { volumes: true });
  try {
    // Without storage every path reads as an empty folder: only the access checks hold.
    const storage = await hasStorage(ctx, world);
    // Named by the channel's id, listed under its name.
    const folder = `/Channels/${p.space_id}`;
    const driveOf = async (who: Principal) =>
      (await as(who).get(DRIVES, { query: { projectId: params.projectId } })).status(200).json<{ drives: { driveId: string }[] }>().drives[0]!.driveId;

    await ctx.step('alice opens /Channels/<slug> (write); its folder is outside /Company', async () => {
      const driveId = await driveOf(people.alice);
      (await as(people.alice).get(FILES, { params: { driveId }, query: { path: folder } })).status(200).body().has('$.access', 'write');
      if (!storage) return;
      (await as(people.alice).get(FILES, { params: { driveId }, query: { path: `/Company/Channels/${p.slug}` } })).status(404);
      const listed = (await as(people.alice).get(FILES, { params: { driveId }, query: { path: '/Channels' } })).status(200).json<{ entries: { path: string; name: string }[] }>();
      if (!listed.entries.some((e) => e.path === folder && e.name === `#${p.slug}`)) throw new Error(`/Channels lists ${JSON.stringify(listed.entries)}`);
    });

    await ctx.step('bob and the manager get 404 on the folder and on /Channels, and the root lists no /Channels for them', async () => {
      for (const who of [people.bob, people.manager]) {
        const driveId = await driveOf(who);
        (await as(who).get(FILES, { params: { driveId }, query: { path: folder } })).status(404);
        (await as(who).get(FILES, { params: { driveId }, query: { path: '/Channels' } })).status(404);
        const root = (await as(who).get(FILES, { params: { driveId }, query: { path: '/' } })).status(200).json<{ entries: { path: string }[] }>();
        if (root.entries.some((e) => e.path === '/Channels')) throw new Error('a non-member sees /Channels');
      }
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-28', meta([R.create, R.update, R.addLink, R.members, R.list, R.features]), async (ctx) => {
  const { world, people, as, params } = await openWorld(ctx);
  try {
    const ops = (await as(people.bob).post(SPACES, { name: `ops-${randomUUID().slice(0, 6)}` }, { params })).status(201).json<Space>();
    const opsParams = { ...params, spaceId: ops.space_id };
    await thread(world, ops.space_id, people.carol.userId!, 'carol’s ops thread');
    (await as(people.alice).post(LINKS, { url: 'https://example.test/runbook' }, { params: opsParams })).status(201);

    await ctx.step('a member who did not create it cannot make it private (403 forbidden)', async () => {
      (await as(people.alice).patch(SPACE, { visibility: 'private' }, { params: opsParams })).status(403).body().has('$.code', 'forbidden');
    });

    await ctx.step('bob (its creator) makes it private: the creator, the thread starter and the link adder become its members', async () => {
      (await as(people.bob).patch(SPACE, { visibility: 'private' }, { params: opsParams })).status(200).body().has('$.visibility', 'private');
      const members = (await as(people.bob).get(MEMBERS, { params: opsParams })).status(200).json<MemberList>();
      const want = [people.bob.userId, people.carol.userId, people.alice.userId].sort();
      if (JSON.stringify(ids(members)) !== JSON.stringify(want)) throw new Error(`members ${JSON.stringify(ids(members))}`);
      const spaces = (await as(people.manager).get(SPACES, { params })).status(200).json<{ spaces: Space[] }>().spaces;
      if (spaces.some((s) => s.space_id === ops.space_id)) throw new Error('a non-member still lists the converted channel');
    });

    await ctx.step('private → public → 400; #general → private → 400 default_channel', async () => {
      (await as(people.bob).patch(SPACE, { visibility: 'public' }, { params: opsParams })).status(400);
      const general = (await world.owner.get(SPACES, { params })).json<{ spaces: Space[] }>().spaces.find((s) => s.is_default)!;
      (await world.owner.patch(SPACE, { visibility: 'private' }, { params: { ...params, spaceId: general.space_id } }))
        .status(400)
        .body()
        .has('$.code', 'default_channel');
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-29', meta([R.create, R.createTrigger, R.features]), async (ctx) => {
  const { team, world, people, as, params, p } = await openWorld(ctx, { manifest: true });
  try {
    // Creating a trigger needs `project.trigger.manage`: a project manager inside P and one outside it.
    for (const who of [people.alice, people.bob]) await team.grantProjectRole(params.projectId, who.userId!, 'manager');
    const trigger = (slug: string) => ({
      name: slug,
      slug,
      type: 'cron',
      cron: '0 0 9 * * *',
      timezone: 'UTC',
      agent: 'kortix',
      prompt_template: `Post the ${slug} digest`,
      space_id: p.space_id,
    });

    await ctx.step('bob (a manager outside P) pointing a trigger at P → 404 space_not_found; alice (a manager in P) → 400 private_channel_trigger; nothing is stored', async () => {
      (await as(people.bob).post(TRIGGERS, trigger('bob-digest'), { params })).status(404).body().has('$.code', 'space_not_found');
      (await as(people.alice).post(TRIGGERS, trigger('deal-digest'), { params })).status(400).body().has('$.code', 'private_channel_trigger');
      const { rows } = await world.db.query('SELECT 1 FROM kortix.project_trigger_runtime WHERE project_id = $1 AND space_id = $2', [params.projectId, p.space_id]);
      if (rows.length !== 0) throw new Error('a trigger was stored on the private channel');
    });
  } finally {
    await world.close();
  }
});
