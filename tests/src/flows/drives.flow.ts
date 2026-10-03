/**
 * Drives (`/v1/drives`). Maps to spec §10b (DRIVE-1, DRIVE-2). A team account
 * with OWNER as owner and a synthesized plain member; every drive the flow
 * creates is deleted in `finally`. Drive is a per-project feature flag that
 * exists only where drive storage does: on a target without it the flag stays
 * off, the project listing answers 403 `feature_disabled`, and every write
 * answers 503 `drive_storage_unavailable`, which DRIVE-1 asserts instead of
 * the file lifecycle.
 */
import { flow } from '../core/flow';

const FILE_ROUTES = [
  'GET /v1/drives/:driveId/files',
  'GET /v1/drives/:driveId/files/content',
  'PUT /v1/drives/:driveId/files/content',
  'POST /v1/drives/:driveId/files/mkdir',
  'POST /v1/drives/:driveId/files/move',
  'DELETE /v1/drives/:driveId/files',
  'GET /v1/drives/:driveId/versions',
  'POST /v1/drives/:driveId/restore',
];

flow(
  'DRIVE-1',
  {
    domain: 'drives',
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'GET /v1/drives',
      'POST /v1/drives',
      'PATCH /v1/drives/:driveId',
      'DELETE /v1/drives/:driveId',
      'GET /v1/drives/:driveId/grants',
      'POST /v1/drives/:driveId/grants',
      'DELETE /v1/drives/:driveId/grants',
      'DELETE /v1/drives/:driveId/grants/:grantId',
      'GET /v1/drives/:driveId/conflicts',
      'POST /v1/drives/:driveId/conflicts/:conflictId/dismiss',
      ...FILE_ROUTES,
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    let ownerDriveId = '';
    let companyId = '';
    let flagOn = false;
    const drive = (driveId: string) => ({ params: { driveId } });
    // With the flag on, the project listing; without it, the account listing.
    const listFor = (as: typeof owner) =>
      as.get('/v1/drives', { query: flagOn ? { projectId: project.id } : { account_id: team.id } });

    try {
      await ctx.step('ANON cannot list drives → 401', async () => {
        (await ctx.client.as(ctx.P.ANON).get('/v1/drives')).status(401);
      });

      await ctx.step("Drive is off by default: the project's listing → 403 feature_disabled", async () => {
        (await owner.get('/v1/drives', { query: { projectId: project.id } }))
          .status(403)
          .body()
          .has('$.code', 'feature_disabled')
          .has('$.feature', 'drives');
      });

      await ctx.step('OWNER turns the drives flag on; it reads back on wherever drive storage exists', async () => {
        const r = await owner.patch(
          '/v1/projects/:projectId/features',
          { feature: 'drives', enabled: true },
          { params: { projectId: project.id } },
        );
        r.status(200);
        flagOn = r.json<{ experimental: Record<string, boolean> }>().experimental.drives === true;
        if (!flagOn) (await owner.get('/v1/drives', { query: { projectId: project.id } })).status(403);
      });

      await ctx.step('OWNER lists drives → 200 with one default personal drive they manage, created once', async () => {
        const first = await listFor(owner);
        first.status(200);
        const mine = first.json<{ drives: any[] }>().drives.filter((d) => d.kind === 'personal');
        if (mine.length !== 1) throw new Error(`expected one personal drive, got ${mine.length}`);
        ownerDriveId = mine[0].driveId;
        if (
          !mine[0].isDefault ||
          mine[0].mountPath !== '/drives/me' ||
          mine[0].accountId !== team.id ||
          mine[0].access !== 'manage'
        ) {
          throw new Error(`unexpected default drive ${JSON.stringify(mine[0])}`);
        }
        const again = await listFor(owner);
        again.status(200);
        const ids = again.json<{ drives: any[] }>().drives.filter((d) => d.kind === 'personal').map((d) => d.driveId);
        if (ids.length !== 1 || ids[0] !== ownerDriveId) throw new Error('a second list created another default drive');
      });

      await ctx.step("a member sees only their own personal drive, never OWNER's", async () => {
        const r = await asMember.get('/v1/drives', { query: { account_id: team.id } });
        r.status(200);
        const personal = r.json<{ drives: any[] }>().drives.filter((d) => d.kind === 'personal');
        if (personal.length !== 1 || personal[0].driveId === ownerDriveId || personal[0].ownerUserId !== member.userId) {
          throw new Error(`member saw ${JSON.stringify(personal)}`);
        }
      });

      await ctx.step("OWNER's personal drive is refused to a member → 404 on every route", async () => {
        (await asMember.get('/v1/drives/:driveId/files', drive(ownerDriveId))).status(404);
        (await asMember.get('/v1/drives/:driveId/versions', drive(ownerDriveId))).status(404);
        (await asMember.patch('/v1/drives/:driveId', { name: 'mine now' }, drive(ownerDriveId))).status(404);
        (await asMember.del('/v1/drives/:driveId', drive(ownerDriveId))).status(404);
      });

      await ctx.step('the default personal drive cannot be deleted → 409', async () => {
        (await owner.del('/v1/drives/:driveId', drive(ownerDriveId))).status(409);
      });

      await ctx.step('a member cannot create a company drive → 403; OWNER can → 201', async () => {
        const body = { name: ctx.fixtures.name('drive'), kind: 'company', account_id: team.id };
        (await asMember.post('/v1/drives', body)).status(403);
        const r = await owner.post('/v1/drives', body);
        r.status(201)
          .body()
          .has('$.kind', 'company')
          .has('$.accountId', team.id)
          .has('$.name', body.name)
          .has('$.access', 'manage');
        companyId = r.json<{ driveId: string }>().driveId;
      });

      await ctx.step('a member with no grant neither lists nor reaches the company drive → 404', async () => {
        const r = await asMember.get('/v1/drives', { query: { account_id: team.id } });
        r.status(200);
        const company = r.json<{ drives: any[] }>().drives.find((d) => d.driveId === companyId);
        if (company) throw new Error(`member sees an ungranted company drive: ${JSON.stringify(company)}`);
        (await asMember.get('/v1/drives/:driveId/files', { ...drive(companyId), query: { path: '/' } })).status(404);
        (await asMember.put('/v1/drives/:driveId/files/content', 'x', { ...drive(companyId), query: { path: '/x.txt' }, raw: true })).status(404);
      });

      await ctx.step('an empty name is rejected → 400', async () => {
        (await owner.post('/v1/drives', { name: '  ', kind: 'company', account_id: team.id })).status(400);
      });

      await ctx.step('NONMEMBER cannot reach the company drive → 404', async () => {
        (await ctx.client.as(ctx.P.NONMEMBER).get('/v1/drives/:driveId/files', drive(companyId))).status(404);
      });

      await ctx.step('renaming a company drive is admin-only: member → 404, OWNER → 200', async () => {
        (await asMember.patch('/v1/drives/:driveId', { name: 'Renamed' }, drive(companyId))).status(404);
        (await owner.patch('/v1/drives/:driveId', { name: 'Team Docs' }, drive(companyId)))
          .status(200)
          .body()
          .has('$.name', 'Team Docs')
          .has('$.mountPath', '/drives/team-docs');
      });

      await ctx.step('granting the company drive to the project → it lists with projectAccess', async () => {
        (await asMember.post('/v1/drives/:driveId/grants', { projectId: project.id }, drive(companyId))).status(404);
        (await owner.post('/v1/drives/:driveId/grants', { projectId: crypto.randomUUID() }, drive(companyId))).status(404);
        (await owner.post('/v1/drives/:driveId/grants', { projectId: project.id, access: 'read' }, drive(companyId)))
          .status(200)
          .body()
          .has('$.access', 'read');
        // Only the project listing carries the grant, and it needs the flag.
        if (!flagOn) return;
        const r = await owner.get('/v1/drives', { query: { projectId: project.id } });
        r.status(200);
        const company = r.json<{ drives: any[] }>().drives.find((d) => d.driveId === companyId);
        if (company?.projectAccess !== 'read') throw new Error(`grant not listed: ${JSON.stringify(company)}`);
      });

      await ctx.step('a personal drive cannot be granted to a project → 400; its owner shares it with a member', async () => {
        (await owner.post('/v1/drives/:driveId/grants', { projectId: project.id }, drive(ownerDriveId))).status(400);
        (await owner.post('/v1/drives/:driveId/grants', { type: 'agent', projectId: project.id, agentName: 'default', access: 'read' }, drive(ownerDriveId))).status(400);
        (await owner.post('/v1/drives/:driveId/grants', { type: 'user', userId: member.userId!, access: 'read' }, drive(ownerDriveId)))
          .status(200)
          .body()
          .has('$.type', 'user')
          .has('$.access', 'read');
        const shared = (await asMember.get('/v1/drives', { query: { account_id: team.id } })).status(200);
        const mine = shared.json<{ drives: any[] }>().drives.find((d) => d.driveId === ownerDriveId);
        if (!mine?.shared || mine.access !== 'read') throw new Error(`share not listed: ${JSON.stringify(mine)}`);
        (await asMember.put('/v1/drives/:driveId/files/content', 'x', { ...drive(ownerDriveId), query: { path: '/x.txt' }, raw: true })).status(403);
        (await asMember.get('/v1/drives/:driveId/grants', drive(ownerDriveId))).status(403);
        const grants = (await owner.get('/v1/drives/:driveId/grants', drive(ownerDriveId))).status(200);
        const share = grants.json<{ grants: { grantId: string; type: string }[] }>().grants.find((g) => g.type === 'user');
        if (!share) throw new Error('share missing from the grant list');
        (await owner.del('/v1/drives/:driveId/grants/:grantId', { params: { driveId: ownerDriveId, grantId: share.grantId } })).status(204);
        (await asMember.get('/v1/drives/:driveId/files', { ...drive(ownerDriveId), query: { path: '/' } })).status(404);
      });

      await ctx.step('a member gets exactly the company drive grant: read refuses writes, write allows them', async () => {
        (await owner.post('/v1/drives/:driveId/grants', { type: 'user', userId: member.userId!, access: 'read' }, drive(companyId))).status(200);
        const listed = (await asMember.get('/v1/drives', { query: { account_id: team.id } })).status(200);
        const company = listed.json<{ drives: any[] }>().drives.find((d) => d.driveId === companyId);
        if (company?.access !== 'read') throw new Error(`member access after a read grant: ${JSON.stringify(company)}`);
        (await asMember.get('/v1/drives/:driveId/files', { ...drive(companyId), query: { path: '/' } })).status(200);
        (await asMember.put('/v1/drives/:driveId/files/content', 'x', { ...drive(companyId), query: { path: '/x.txt' }, raw: true })).status(403);
        (await asMember.get('/v1/drives/:driveId/grants', drive(companyId))).status(403);
        (await owner.post('/v1/drives/:driveId/grants', { type: 'user', userId: member.userId!, access: 'write' }, drive(companyId))).status(200);
        const upgraded = (await asMember.get('/v1/drives', { query: { account_id: team.id } })).status(200);
        const writable = upgraded.json<{ drives: any[] }>().drives.find((d) => d.driveId === companyId);
        if (writable?.access !== 'write') throw new Error(`member access after a write grant: ${JSON.stringify(writable)}`);
      });

      await ctx.step('company drive grants to a project and an agent; revoking by subject → 204, then 404', async () => {
        (await owner.post('/v1/drives/:driveId/grants', { type: 'agent', projectId: project.id, agentName: 'default', access: 'read' }, drive(companyId)))
          .status(200)
          .body()
          .has('$.agentName', 'default');
        const params = { ...drive(companyId), query: { projectId: project.id } };
        (await owner.del('/v1/drives/:driveId/grants', params)).status(204);
        (await owner.del('/v1/drives/:driveId/grants', params)).status(404);
        (await owner.del('/v1/drives/:driveId/grants', { ...drive(companyId), query: { projectId: project.id, agentName: 'default' } })).status(204);
      });

      await ctx.step('conflicts: none open on a new drive; dismissing an unknown one → 404', async () => {
        (await asMember.get('/v1/drives/:driveId/conflicts', drive(companyId))).status(200).body().has('$.conflicts', []);
        (await owner.post('/v1/drives/:driveId/conflicts/:conflictId/dismiss', {}, { params: { driveId: companyId, conflictId: crypto.randomUUID() } })).status(404);
      });

      await ctx.step('a drive nothing was written to reads as empty, without creating storage', async () => {
        (await asMember.get('/v1/drives/:driveId/files', { ...drive(companyId), query: { path: '/' } }))
          .status(200)
          .body()
          .has('$.entries', []);
        (await owner.get('/v1/drives/:driveId/versions', drive(companyId))).status(200).body().has('$.versions', []);
        (await owner.get('/v1/drives/:driveId/files/content', { ...drive(companyId), query: { path: '/a.txt' } })).status(404);
      });

      await ctx.step('files: a member writes a company drive; OWNER reads, moves, versions and restores it', async () => {
        const mkdir = await asMember.post('/v1/drives/:driveId/files/mkdir', { path: '/notes' }, drive(companyId));
        if (mkdir.statusCode === 503) {
          mkdir.body().has('$.code', 'drive_storage_unavailable');
          return;
        }
        mkdir.status(200);
        (await asMember.put('/v1/drives/:driveId/files/content', 'hello drive', {
          ...drive(companyId),
          query: { path: '/notes/a.txt' },
          raw: true,
        }))
          .status(200)
          .body()
          .has('$.size', 11);
        const listed = await owner.get('/v1/drives/:driveId/files', { ...drive(companyId), query: { path: '/notes' } });
        listed.status(200);
        const names = listed.json<{ entries: { name: string }[] }>().entries.map((e) => e.name);
        if (names.join(',') !== 'a.txt') throw new Error(`folder lists ${names.join(',')}`);
        const read = await owner.get('/v1/drives/:driveId/files/content', {
          ...drive(companyId),
          query: { path: '/notes/a.txt', download: 1 },
        });
        read.status(200);
        if (read.text() !== 'hello drive') throw new Error(`read back ${read.text()}`);
        if (!/attachment/.test(read.header('content-disposition') ?? '')) throw new Error('download is not an attachment');
        (await owner.get('/v1/drives/:driveId/files/content', { ...drive(companyId), query: { path: '/../etc/passwd' } })).status(400);
        (await owner.post('/v1/drives/:driveId/files/move', { from: '/notes/a.txt', to: '/notes/b.txt' }, drive(companyId))).status(200);
        const versions = await owner.get('/v1/drives/:driveId/versions', drive(companyId));
        versions.status(200);
        const list = versions.json<{ versions: { id: string }[] }>().versions;
        if (list.length < 3) throw new Error(`expected at least 3 versions, got ${list.length}`);
        (await owner.post('/v1/drives/:driveId/restore', { versionId: 'no-such-version' }, drive(companyId))).status(404);
        (await owner.post('/v1/drives/:driveId/restore', { versionId: list[1]!.id }, drive(companyId))).status(200);
        (await owner.del('/v1/drives/:driveId/files', { ...drive(companyId), query: { path: '/notes', recursive: 'true' } })).status(204);
      });

      await ctx.step('removing the member’s grant takes the company drive away → 404', async () => {
        (await asMember.del('/v1/drives/:driveId', drive(companyId))).status(403);
        (await owner.del('/v1/drives/:driveId/grants', { ...drive(companyId), query: { userId: member.userId! } })).status(204);
        (await asMember.get('/v1/drives/:driveId/files', { ...drive(companyId), query: { path: '/' } })).status(404);
      });

      await ctx.step('deleting the company drive → 204; it is gone → 404', async () => {
        (await owner.del('/v1/drives/:driveId', drive(companyId))).status(204);
        (await owner.get('/v1/drives/:driveId/versions', drive(companyId))).status(404);
        companyId = '';
      });
    } finally {
      if (companyId) await owner.del('/v1/drives/:driveId', drive(companyId)).catch(() => undefined);
    }
  },
);

flow(
  'DRIVE-2',
  {
    domain: 'drives',
    requires: ['daytona', 'funded'],
    timeoutMs: 300_000,
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/drives',
      'POST /v1/projects/:projectId/sessions/:sessionId/drives',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/drives/:driveId',
      'PATCH /v1/projects/:projectId/sessions/:sessionId/drives/:driveId',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    const s = await ctx.fixtures.session(p);
    const route = '/v1/projects/:projectId/sessions/:sessionId/drives';
    const params = { params: { projectId: p.id, sessionId: s.id } };

    await ctx.step("OWNER lists the session's drives → 200, each at a distinct /drives path", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(route, params);
      r.status(200);
      const drives = r.json<{ drives: { mountPath: string }[] }>().drives;
      const paths = drives.map((d) => d.mountPath);
      if (new Set(paths).size !== paths.length || paths.some((m) => !m.startsWith('/drives/'))) {
        throw new Error(`bad mount paths ${paths.join(',')}`);
      }
    });
    await ctx.step('non-uuid session id → 400; unknown session → 404', async () => {
      (await ctx.client.as(ctx.P.OWNER).get(route, { params: { projectId: p.id, sessionId: 'nope' } })).status(400);
      (await ctx.client.as(ctx.P.OWNER).get(route, { params: { projectId: p.id, sessionId: crypto.randomUUID() } })).status(404);
    });
    await ctx.step('NONMEMBER → 403; ANON → 401', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).get(route, params)).status(403);
      (await ctx.client.as(ctx.P.ANON).get(route, params)).status(401);
    });
    await ctx.step('attach / detach / access changes refuse strangers and unknown drives', async () => {
      const one = { params: { projectId: p.id, sessionId: s.id, driveId: crypto.randomUUID() } };
      (await ctx.client.as(ctx.P.ANON).post(route, { driveId: crypto.randomUUID() }, params)).status(401);
      (await ctx.client.as(ctx.P.NONMEMBER).del(`${route}/:driveId`, one)).status(403);
      const attach = await ctx.client.as(ctx.P.OWNER).post(route, { driveId: crypto.randomUUID() }, params);
      attach.status([403, 404]);
      const access = await ctx.client.as(ctx.P.OWNER).patch(`${route}/:driveId`, { access: 'write' }, one);
      access.status([403, 404]);
    });
  },
);
