/**
 * Files (`/v1/drives`). Maps to spec §10b (DRIVE-1, DRIVE-2). A team account
 * with OWNER as owner and a plain member who works in the project. Files is
 * not a toggle of its own: it follows the project's `volumes` flag, which the
 * project admin turns on with `PATCH /projects/:id/features`. Writes need drive storage; on a
 * target without it every write answers 503 `drive_storage_unavailable`,
 * which DRIVE-1 asserts instead of the file lifecycle.
 */
import { flow } from '../core/flow';
import type { FlowContext, Principal } from '../core/types';


/**
 * Each API process caches membership for up to 15 s. Poll until 12 reads in
 * a row agree, so every process behind the load balancer answers the new state.
 */
async function waitForFilesStatus(
  ctx: FlowContext,
  list: { query: { projectId: string } },
  status: 200 | 403,
  as: Principal = ctx.P.OWNER,
): Promise<void> {
  const deadline = Date.now() + 45_000;
  let streak = 0;
  let last = 0;
  while (streak < 12) {
    if (Date.now() > deadline) throw new Error(`Files did not answer ${status} 12 times in a row within 45 s (last ${last})`);
    last = (await ctx.client.as(as).get('/v1/drives', list)).statusCode;
    streak = last === status ? streak + 1 : 0;
    if (streak < 12) await new Promise((resolve) => setTimeout(resolve, last === status ? 250 : 1_000));
  }
}

flow(
  'DRIVE-1',
  {
    domain: 'drives',
    // One wait for every API process to see the new member (≤45 s).
    timeoutMs: 300_000,
    routes: [
      'GET /v1/projects/:projectId',
      'PATCH /v1/projects/:projectId/features',
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
    // Another account member: a plain member may not see them (MEM-8).
    const outsider = await team.addMember('member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const listFiles = { query: { projectId: project.id } };
    const setVolumes = (enabled: boolean | null) =>
      owner.patch('/v1/projects/:projectId/features', { feature: 'volumes', enabled }, { params: { projectId: project.id } });
    let driveId = '';
    let ownerFolder = '';
    let memberFolder = '';
    const files = (path: string) => ({ params: { driveId }, query: { path } });
    const entries = (r: { json<T>(): T }) => r.json<{ entries: { path: string }[] }>().entries.map((e) => e.path).sort();

    try {
      await ctx.step('ANON cannot list Files → 401', async () => {
        (await ctx.client.as(ctx.P.ANON).get('/v1/drives', listFiles)).status(401);
      });

      await ctx.step('Volumes is on by default; the project admin turns it off → Files → 403 feature_disabled', async () => {
        (await owner.get('/v1/projects/:projectId', { params: { projectId: project.id } }))
          .status(200)
          .body()
          .has('$.experimental.volumes', true)
          .has('$.experimental.drives', true);
        (await setVolumes(false)).status(200).body().has('$.experimental.drives', false);
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

      await ctx.step("the project admin turns the project's Volumes on → Files → 200", async () => {
        (await setVolumes(true))
          .status(200)
          .body()
          .has('$.experimental.volumes', true)
          .has('$.experimental.drives', true);
        (await owner.get('/v1/drives', listFiles)).status(200);
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
        // The member joined moments ago; each API process caches membership
        // for up to 15 s, so wait until every process lets them in.
        await waitForFilesStatus(ctx, listFiles, 200, member);
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
        if (!JSON.stringify(r.json()).includes(outsider.userId!)) throw new Error(`owner cannot name an account member: ${r.text()}`);
      });

      await ctx.step('a plain member names only themselves: not the owner, not an account member', async () => {
        const people = (await asMember.get('/v1/drives/:driveId/principals', { params: { driveId } }))
          .status(200)
          .json<{ people: { id: string }[] }>()
          .people.map((p) => p.id);
        if (JSON.stringify(people) !== JSON.stringify([member.userId])) {
          throw new Error(`a plain member must name only themselves, got ${JSON.stringify(people)} (outsider ${outsider.userId})`);
        }
      });

      await ctx.step('restoring an unknown version → 404 (503 without drive storage)', async () => {
        (await owner.post('/v1/drives/:driveId/restore', { versionId: 'no-such-version' }, { params: { driveId } })).status([404, 503]);
      });

      await ctx.step('a `..` path → 400; conflicts start empty; dismissing an unknown one → 404', async () => {
        // No `../`: an edge WAF answers that itself (403) before the API sees it.
        (await owner.get('/v1/drives/:driveId/files/content', files('/Users/..'))).status(400);
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

      await ctx.step('Volumes off again: Files and writes → 403 feature_disabled; what is there still reads', async () => {
        (await setVolumes(false)).status(200).body().has('$.experimental.drives', false);
        (await owner.get('/v1/drives', listFiles)).status(403).body().has('$.code', 'feature_disabled');
        (await owner.post('/v1/drives/:driveId/files/mkdir', { path: `${ownerFolder}/after-off` }, { params: { driveId } }))
          .status(403)
          .body()
          .has('$.code', 'feature_disabled');
        // A file a session already wrote under /drives still opens in its transcript.
        const top = entries((await owner.get('/v1/drives/:driveId/files', files('/'))).status(200));
        if (!top.includes('/Users')) throw new Error(`with Volumes off the top lists ${top.join(',')}`);
      });
    } finally {
      await setVolumes(null).catch(() => undefined);
    }
  },
);

flow(
  'DRIVE-2',
  {
    domain: 'drives',
    requires: ['daytona', 'funded'],
    timeoutMs: 300_000,
    routes: ['GET /v1/projects/:projectId/sessions/:sessionId/drives'],
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
    await ctx.step('what a session mounts follows grants only: there is no route to attach a folder or change its access', async () => {
      const one = { params: { projectId: p.id, sessionId: s.id, driveId: crypto.randomUUID() } };
      (await ctx.client.as(ctx.P.OWNER).post(route, { driveId: crypto.randomUUID() }, params)).status([404, 405]);
      (await ctx.client.as(ctx.P.OWNER).patch(`${route}/:driveId`, { access: 'write' }, one)).status([404, 405]);
      (await ctx.client.as(ctx.P.OWNER).del(`${route}/:driveId`, one)).status([404, 405]);
    });
  },
);
