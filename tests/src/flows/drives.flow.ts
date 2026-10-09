/**
 * Files (`/v1/drives`). Maps to spec §10b (DRIVE-1, DRIVE-2). A team account
 * with OWNER as owner and a plain member who works in the project. Files is
 * not a project toggle: it follows the organization's Volumes switch, which a
 * platform admin sets in the boot-mode policy. The flow turns Volumes on for
 * its own fixture organization only and takes it off again in `finally`.
 * Writes need drive storage; on a target without it every write answers 503
 * `drive_storage_unavailable`, which DRIVE-1 asserts instead of the file
 * lifecycle.
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { asPlatformAdmin } from '../fixtures/enterprise-demo';

type Policy = { volumes?: { enabled?: boolean; orgs?: Record<string, boolean> } } & Record<string, unknown>;

/** Turn Volumes on or off for one organization, leaving every other entry as it is. */
async function setOrgVolumes(ctx: FlowContext, accountId: string, enabled: boolean | null): Promise<void> {
  const admin = asPlatformAdmin(ctx);
  const current = (await admin.get('/v1/admin/api/boot-modes')).status(200).json<{ policy: Policy }>().policy;
  const orgs = { ...(current.volumes?.orgs ?? {}) };
  if (enabled === null) delete orgs[accountId];
  else orgs[accountId] = enabled;
  const saved = await admin.put('/v1/admin/api/boot-modes', { ...current, volumes: { ...current.volumes, orgs } });
  saved.status(200);
  const after = saved.json<{ policy: Policy }>().policy.volumes?.orgs?.[accountId];
  if (enabled !== null && after !== enabled) throw new Error(`Volumes for ${accountId} reads back ${String(after)}`);
}

flow(
  'DRIVE-1',
  {
    domain: 'drives',
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'GET /v1/admin/api/boot-modes',
      'PUT /v1/admin/api/boot-modes',
      'GET /v1/drives',
      'GET /v1/drives/:driveId/files',
      'GET /v1/drives/:driveId/files/content',
      'PUT /v1/drives/:driveId/files/content',
      'POST /v1/drives/:driveId/files/mkdir',
      'POST /v1/drives/:driveId/files/move',
      'DELETE /v1/drives/:driveId/files',
      'GET /v1/drives/:driveId/access',
      'PUT /v1/drives/:driveId/access',
      'GET /v1/drives/:driveId/principals',
      'POST /v1/drives/:driveId/restore',
      'DELETE /v1/drives/:driveId/access/:grantId',
      'GET /v1/drives/:driveId/conflicts',
      'POST /v1/drives/:driveId/conflicts/:conflictId/dismiss',
      'GET /v1/drives/:driveId/versions',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'user');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const listFiles = { query: { projectId: project.id } };
    let volumesOn = false;
    let driveId = '';
    let ownerFolder = '';
    let memberFolder = '';
    const files = (path: string) => ({ params: { driveId }, query: { path } });
    const entries = (r: { json<T>(): T }) => r.json<{ entries: { path: string }[] }>().entries.map((e) => e.path).sort();

    try {
      await ctx.step('ANON cannot list Files → 401', async () => {
        (await ctx.client.as(ctx.P.ANON).get('/v1/drives', listFiles)).status(401);
      });

      await ctx.step('Volumes off for the organization: Files → 403 feature_disabled', async () => {
        (await owner.get('/v1/drives', listFiles))
          .status(403)
          .body()
          .has('$.code', 'feature_disabled')
          .has('$.feature', 'drives');
      });

      await ctx.step('Files is not a project toggle: the features route refuses it → 400', async () => {
        (await owner.patch('/v1/projects/:projectId/features', { feature: 'drives', enabled: true }, { params: { projectId: project.id } })).status(400);
        (await owner.get('/v1/drives', listFiles)).status(403);
      });

      await ctx.step('the account OWNER cannot change the Volumes policy → 403', async () => {
        (await owner.get('/v1/admin/api/boot-modes')).status(403);
      });

      await ctx.step('a platform admin turns Volumes on for this organization only', async () => {
        await setOrgVolumes(ctx, team.id, true);
        volumesOn = true;
      });

      await ctx.step('OWNER opens Files → 200: one project drive they manage, and their own folder', async () => {
        const r = (await owner.get('/v1/drives', listFiles)).status(200);
        const drives = r.json<{ drives: any[] }>().drives;
        const [drive] = drives;
        if (drives.length !== 1 || drive.kind !== 'project' || drive.projectId !== project.id || drive.access !== 'manage') {
          throw new Error(`unexpected Files ${JSON.stringify(drives)}`);
        }
        if (!/^\/Users\/[^/]+$/.test(drive.personalFolder ?? '')) throw new Error(`no own folder: ${drive.personalFolder}`);
        driveId = drive.driveId;
        ownerFolder = drive.personalFolder;
        const again = (await owner.get('/v1/drives', listFiles)).status(200).json<{ drives: any[] }>().drives;
        if (again.length !== 1 || again[0].driveId !== driveId) throw new Error('a second open created another drive');
      });

      await ctx.step('the member opens the same Files with a folder of their own; they do not manage it', async () => {
        const drive = (await asMember.get('/v1/drives', listFiles)).status(200).json<{ drives: any[] }>().drives[0];
        if (drive?.driveId !== driveId || drive.access === 'manage' || !drive.personalFolder || drive.personalFolder === ownerFolder) {
          throw new Error(`member saw ${JSON.stringify(drive)}`);
        }
        memberFolder = drive.personalFolder;
        if (drive.sharedWithMe?.length) throw new Error(`nothing is shared yet: ${JSON.stringify(drive.sharedWithMe)}`);
      });

      await ctx.step('NONMEMBER cannot open Files → 403/404', async () => {
        (await ctx.client.as(ctx.P.NONMEMBER).get('/v1/drives', listFiles)).status([403, 404]);
        (await ctx.client.as(ctx.P.NONMEMBER).get('/v1/drives/:driveId/files', files('/'))).status([403, 404]);
      });

      await ctx.step("the top lists Users; Users lists only the member's own folder for them", async () => {
        const top = entries((await owner.get('/v1/drives/:driveId/files', files('/'))).status(200));
        if (!top.includes('/Users')) throw new Error(`top lists ${top.join(',')}`);
        const users = entries((await asMember.get('/v1/drives/:driveId/files', files('/Users'))).status(200));
        if (users.join(',') !== memberFolder) throw new Error(`member sees ${users.join(',')} in Users`);
      });

      await ctx.step("OWNER's own folder is private: the member gets 404 listing, reading or writing it", async () => {
        (await asMember.get('/v1/drives/:driveId/files', files(ownerFolder))).status(404);
        (await asMember.get('/v1/drives/:driveId/files/content', files(`${ownerFolder}/a.txt`))).status(404);
        (await asMember.put('/v1/drives/:driveId/files/content', 'x', { ...files(`${ownerFolder}/a.txt`), raw: true })).status(404);
        (await asMember.get('/v1/drives/:driveId/access', files(ownerFolder))).status(404);
      });

      await ctx.step('OWNER shares a folder inside their own with the member (read); the member walks to it', async () => {
        const shared = `${ownerFolder}/shared`;
        const r = await owner.put(
          '/v1/drives/:driveId/access',
          { path: shared, principalType: 'user', principalId: member.userId!, level: 'read' },
          { params: { driveId } },
        );
        r.status(200);
        const grantId = r.json<{ grantId: string }>().grantId;
        const users = entries((await asMember.get('/v1/drives/:driveId/files', files('/Users'))).status(200));
        if (users.join(',') !== [ownerFolder, memberFolder].sort().join(',')) throw new Error(`Users lists ${users.join(',')}`);
        const way = entries((await asMember.get('/v1/drives/:driveId/files', files(ownerFolder))).status(200));
        if (way.join(',') !== shared) throw new Error(`owner folder lists ${way.join(',')} for the member`);
        (await asMember.get('/v1/drives/:driveId/files', files(shared))).status(200).body().has('$.access', 'read');
        const drive = (await asMember.get('/v1/drives', listFiles)).status(200).json<{ drives: any[] }>().drives[0];
        if (JSON.stringify(drive.sharedWithMe) !== JSON.stringify([{ path: shared, access: 'read' }])) {
          throw new Error(`sharedWithMe ${JSON.stringify(drive.sharedWithMe)}`);
        }
        (await asMember.put('/v1/drives/:driveId/files/content', 'x', { ...files(`${shared}/x.txt`), raw: true })).status(403);
        (await asMember.put('/v1/drives/:driveId/access', { path: shared, principalType: 'project', level: 'read' }, { params: { driveId } })).status(403);
        const access = (await owner.get('/v1/drives/:driveId/access', files(shared))).status(200);
        if (!access.json<{ grants: { grantId: string }[] }>().grants.some((g) => g.grantId === grantId)) throw new Error('share missing from the folder access');
        (await owner.del('/v1/drives/:driveId/access/:grantId', { params: { driveId, grantId } })).status(204);
        (await asMember.get('/v1/drives/:driveId/files', files(shared))).status(404);
        (await asMember.get('/v1/drives/:driveId/files', files(ownerFolder))).status(404);
      });

      await ctx.step('OWNER can name the people of the project to share with', async () => {
        const r = (await owner.get('/v1/drives/:driveId/principals', { params: { driveId } })).status(200);
        if (!JSON.stringify(r.json()).includes(member.userId!)) throw new Error(`member missing from principals: ${r.text()}`);
      });

      await ctx.step('restoring an unknown version → 404 (503 without drive storage)', async () => {
        (await owner.post('/v1/drives/:driveId/restore', { versionId: 'no-such-version' }, { params: { driveId } })).status([404, 503]);
      });

      await ctx.step('a `..` path → 400; conflicts start empty; dismissing an unknown one → 404', async () => {
        (await owner.get('/v1/drives/:driveId/files/content', files('/../etc/passwd'))).status(400);
        (await asMember.get('/v1/drives/:driveId/conflicts', { params: { driveId } })).status(200).body().has('$.conflicts', []);
        (await owner.post('/v1/drives/:driveId/conflicts/:conflictId/dismiss', {}, { params: { driveId, conflictId: crypto.randomUUID() } })).status(404);
      });

      await ctx.step('files: the member writes their folder; it reads back, moves and deletes', async () => {
        const dir = `${memberFolder}/notes`;
        const mkdir = await asMember.post('/v1/drives/:driveId/files/mkdir', { path: dir }, { params: { driveId } });
        if (mkdir.statusCode === 503) {
          mkdir.body().has('$.code', 'drive_storage_unavailable');
          (await owner.get('/v1/drives/:driveId/versions', { params: { driveId } })).status(200).body().has('$.versions', []);
          return;
        }
        mkdir.status(200);
        (await asMember.put('/v1/drives/:driveId/files/content', 'hello files', { ...files(`${dir}/a.txt`), raw: true }))
          .status(200)
          .body()
          .has('$.size', 11);
        const read = (await asMember.get('/v1/drives/:driveId/files/content', { params: { driveId }, query: { path: `${dir}/a.txt`, download: 1 } })).status(200);
        if (read.text() !== 'hello files') throw new Error(`read back ${read.text()}`);
        (await owner.get('/v1/drives/:driveId/files/content', files(`${dir}/a.txt`))).status(404);
        (await asMember.post('/v1/drives/:driveId/files/move', { from: `${dir}/a.txt`, to: `${dir}/b.txt` }, { params: { driveId } })).status(200);
        (await asMember.del('/v1/drives/:driveId/files', { params: { driveId }, query: { path: dir, recursive: 'true' } })).status(204);
      });

      await ctx.step('Volumes off again: Files → 403 feature_disabled', async () => {
        await setOrgVolumes(ctx, team.id, null);
        volumesOn = false;
        (await owner.get('/v1/drives', listFiles)).status(403).body().has('$.code', 'feature_disabled');
      });
    } finally {
      if (volumesOn) await setOrgVolumes(ctx, team.id, null).catch(() => undefined);
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
