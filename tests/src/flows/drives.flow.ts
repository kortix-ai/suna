/**
 * Files (`/v1/drives`). Maps to spec §10b (DRIVE-1, DRIVE-2). A team account
 * with OWNER as owner and a plain member who works in the project. Every
 * project has a Drive: `volumes` and `drives` are no flags since 2026-11-02,
 * and the features route refuses both. Writes need drive storage; on a
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
      'GET /v1/workspaces/:projectId',
      'PATCH /v1/workspaces/:projectId/features',
      'GET /v1/drives',
      'GET /v1/workspaces/:projectId/resource-grants',
      'POST /v1/workspaces/:projectId/resource-grants',
      'GET /v1/drives/:driveId/files',
      'GET /v1/drives/:driveId/files/content',
      'PUT /v1/drives/:driveId/files/content',
      'POST /v1/drives/:driveId/files/mkdir',
      'POST /v1/drives/:driveId/files/move',
      'DELETE /v1/drives/:driveId/files',
      'GET /v1/drives/:driveId/access',
      'GET /v1/drives/:driveId/admin-reads',
      'PUT /v1/drives/:driveId/access',
      'GET /v1/drives/:driveId/principals',
      'GET /v1/drives/:driveId/agents/:agentName/mounts',
      'GET /v1/drives/:driveId/mounts',
      'POST /v1/drives/:driveId/restore',
      'DELETE /v1/drives/:driveId/access/:grantId',
      'GET /v1/drives/:driveId/conflicts',
      'POST /v1/drives/:driveId/conflicts/:conflictId/dismiss',
      'GET /v1/drives/:driveId/versions',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    // A managed repository, so a step can declare an agent in kortix.yaml.
    const project = await team.project({ managedGit: true });
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'user');
    // Another account member: a plain member may not see them (MEM-8).
    const outsider = await team.addMember('member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const listFiles = { query: { projectId: project.id } };
    let driveId = '';
    let ownerFolder = '';
    let memberFolder = '';
    const files = (path: string) => ({ params: { driveId }, query: { path } });
    const entries = (r: { json<T>(): T }) => r.json<{ entries: { path: string }[] }>().entries.map((e) => e.path).sort();

    await ctx.step('ANON cannot list Files → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).get('/v1/drives', listFiles)).status(401);
    });

    await ctx.step('every project has a Drive: the detail sends drives true; volumes and drives are no flags → 400', async () => {
      (await owner.get('/v1/workspaces/:projectId', { params: { projectId: project.id } }))
        .status(200)
        .body()
        .has('$.experimental.volumes', true)
        .has('$.experimental.drives', true);
      for (const feature of ['volumes', 'drives']) {
        (await owner.patch('/v1/workspaces/:projectId/features', { feature, enabled: false }, { params: { projectId: project.id } })).status(400);
      }
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
      if (drive.sharedWithMe?.length) throw new Error(`nothing is shared with a person: ${JSON.stringify(drive.sharedWithMe)}`);
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

    await ctx.step('shared_drives is on by default; a project turns it off: Drive is My files only; every share → 403 feature_disabled; no Company folder', async () => {
      const before = (await asMember.get('/v1/drives', listFiles)).status(200).json<{ drives: any[] }>().drives[0];
      if (before.sharedDrives !== true) throw new Error(`shared Drives are not on by default: ${JSON.stringify(before)}`);
      (await owner.patch('/v1/projects/:projectId/features', { feature: 'shared_drives', enabled: false }, { params: { projectId: project.id } })).status(200);
      const drive = (await asMember.get('/v1/drives', listFiles)).status(200).json<{ drives: any[] }>().drives[0];
      if (drive.sharedDrives !== false || drive.sharedWithMe?.length) throw new Error(`member Drive ${JSON.stringify(drive)}`);
      (await owner.put('/v1/drives/:driveId/access', { path: '/Sales', principalType: 'agent', principalId: 'worker', level: 'read' }, { params: { driveId } }))
        .status(403)
        .body()
        .has('$.code', 'feature_disabled')
        .has('$.feature', 'shared_drives');
      const top = entries((await asMember.get('/v1/drives/:driveId/files', files('/'))).status(200));
      if (top.join(',') !== '/Users') throw new Error(`a member sees ${top.join(',')} at the top`);
      (await asMember.get('/v1/drives/:driveId/files', files('/Company'))).status(404);
      (await asMember.get('/v1/drives/:driveId/files', files('/Company/Memory'))).status(404);
      (await asMember.put('/v1/drives/:driveId/files/content', 'x', { ...files('/Company/x.txt'), raw: true })).status(404);
    });

    await ctx.step('shared_drives on: a share with a person, a team or the project → 400; with an agent → 200', async () => {
      (await owner.patch('/v1/workspaces/:projectId/features', { feature: 'shared_drives', enabled: true }, { params: { projectId: project.id } })).status(200);
      for (const body of [
        { path: `${ownerFolder}/shared`, principalType: 'user', principalId: member.userId!, level: 'read' },
        { path: '/Sales', principalType: 'project', level: 'read' },
      ]) {
        (await owner.put('/v1/drives/:driveId/access', body, { params: { driveId } })).status(400);
      }
    });

    await ctx.step("a member reaches a shared Drive only once they may use an agent added to it, at the agent's level", async () => {
      const params = { projectId: project.id };
      const catalog = (await owner.get('/v1/workspaces/:projectId/resource-grants', { params })).status(200);
      const agents = catalog.json<{ resources: { agents: Array<{ id: string }> } }>().resources.agents.map((a) => a.id);
      const agent = agents.find((a) => a !== 'mykortix' && a !== 'meta');
      if (!agent) throw new Error(`no agent to grant: ${catalog.text().slice(0, 400)}`);
      (await owner.put('/v1/drives/:driveId/access', { path: '/Sales', principalType: 'agent', principalId: agent, level: 'write' }, { params: { driveId } })).status(200);
      // Not yet a user of the agent: nothing.
      (await asMember.get('/v1/drives/:driveId/files', files('/Sales'))).status(404);
      (await owner.post(
        '/v1/workspaces/:projectId/resource-grants',
        { resource_type: 'agent', resource_id: agent, principal_type: 'member', principal_id: member.userId },
        { params },
      )).status(201);
      // Access caches per API process for up to 15 s: read until every process agrees.
      const deadline = Date.now() + 45_000;
      let seen: unknown = null;
      for (let streak = 0; streak < 6; ) {
        if (Date.now() > deadline) throw new Error(`member never reached /Sales: ${JSON.stringify(seen)}`);
        const d = (await asMember.get('/v1/drives', listFiles)).status(200).json<{ drives: any[] }>().drives[0];
        seen = d.sharedWithMe;
        streak = JSON.stringify(d.sharedWithMe) === JSON.stringify([{ path: '/Sales', access: 'write' }]) ? streak + 1 : 0;
        if (streak === 0) await new Promise((r) => setTimeout(r, 500));
      }
      // The local profile stores no bytes: the access answer is the proof.
      (await asMember.get('/v1/drives/:driveId/files', files('/Sales'))).status(200).body().has('$.access', 'write');
      const top = entries((await asMember.get('/v1/drives/:driveId/files', files('/'))).status(200));
      if (top.join(',') !== '/Sales,/Users') throw new Error(`a member sees ${top.join(',')} at the top`);
      (await owner.patch('/v1/workspaces/:projectId/features', { feature: 'shared_drives', enabled: false }, { params })).status(200);
      // Off again: the grant stays stored but reaches nobody.
      (await asMember.get('/v1/drives/:driveId/files', files('/Sales'))).status(404);
    });

    await ctx.step('OWNER can name the people of the project to share with', async () => {
      const r = (await owner.get('/v1/drives/:driveId/principals', { params: { driveId } })).status(200);
      if (!JSON.stringify(r.json()).includes(member.userId!)) throw new Error(`member missing from principals: ${r.text()}`);
      if (!JSON.stringify(r.json()).includes(outsider.userId!)) throw new Error(`owner cannot name an account member: ${r.text()}`);
    });

    await ctx.step('project mounts are available to OWNER and reject ANON', async () => {
      const route = '/v1/drives/:driveId/mounts';
      const plan = (await owner.get(route, { params: { driveId } })).status(200)
        .json<{ mounts: { mountPath: string }[]; slots: number }>();
      if (!(plan.slots > 0) || !plan.mounts.every((mount) => mount.mountPath.startsWith('/drives/'))) {
        throw new Error(`invalid project mount plan: ${JSON.stringify(plan)}`);
      }
      (await ctx.client.as(ctx.P.ANON).get(route, { params: { driveId } })).status(401);
    });

    await ctx.step('a plain member reads the project mounts (the Drive page asks on every open): 200, never a folder they cannot see', async () => {
      const plan = (await asMember.get('/v1/drives/:driveId/mounts', { params: { driveId } }))
        .status(200)
        .json<{ mounts: { path: string }[] }>();
      if (plan.mounts.some((m) => m.path === ownerFolder || m.path.startsWith(`${ownerFolder}/`))) {
        throw new Error(`a member sees the owner's folder in the mount plan: ${JSON.stringify(plan.mounts)}`);
      }
    });

    await ctx.step("an agent's mounts are the session plan: the project's folders at /drives paths; ANON 401", async () => {
      const plan = (await owner.get('/v1/drives/:driveId/agents/:agentName/mounts', { params: { driveId, agentName: 'kortix' } }))
        .status(200)
        .json<{ mounts: { path: string; mountPath: string; via: string; readOnly: boolean }[]; skipped: string[]; slots: number }>();
      if (!(plan.slots > 0)) throw new Error(`slots ${plan.slots}`);
      if (!plan.mounts.every((m) => m.mountPath.startsWith('/drives/'))) throw new Error(`mounts ${JSON.stringify(plan.mounts)}`);
      if (plan.mounts.some((m) => m.path.startsWith('/Users'))) throw new Error(`a person's folder in an agent plan: ${JSON.stringify(plan.mounts)}`);
      (await ctx.client.as(ctx.P.ANON).get('/v1/drives/:driveId/agents/:agentName/mounts', { params: { driveId, agentName: 'kortix' } })).status(401);
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

    await ctx.step('files: the member writes their folder; it reads back, OWNER (admin) opens it and the member sees that, then it moves and deletes', async () => {
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
      // A project admin opens every person's own folder; its owner sees each open.
      const seen = (await owner.get('/v1/drives/:driveId/files/content', files(`${dir}/a.txt`))).status(200);
      if (seen.text() !== 'hello files') throw new Error(`OWNER read ${seen.text()}`);
      const reads = (await asMember.get('/v1/drives/:driveId/admin-reads', files(memberFolder)))
        .status(200)
        .json<{ folder: string; reads: Array<{ adminUserId: string; opens: number }> }>();
      if (reads.folder !== memberFolder || !reads.reads.some((r) => r.adminUserId === ctx.P.OWNER.userId && r.opens >= 1)) {
        throw new Error(`the member does not see OWNER's open: ${JSON.stringify(reads)}`);
      }
      (await asMember.get('/v1/drives/:driveId/admin-reads', files(ownerFolder))).status(404);
      (await asMember.post('/v1/drives/:driveId/files/move', { from: `${dir}/a.txt`, to: `${dir}/b.txt` }, { params: { driveId } })).status(200);
      (await asMember.del('/v1/drives/:driveId/files', { params: { driveId }, query: { path: dir, recursive: 'true' } })).status(204);
    });
  },
);

flow(
  'DRIVE-2',
  {
    domain: 'drives',
    requires: ['sandbox', 'funded'],
    timeoutMs: 300_000,
    routes: ['GET /v1/workspaces/:projectId/sessions/:sessionId/drives'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    const s = await ctx.fixtures.session(p);
    const route = '/v1/workspaces/:projectId/sessions/:sessionId/drives';
    const params = { params: { projectId: p.id, sessionId: s.id } };

    await ctx.step("OWNER lists the session's drives → 200, each at a distinct /drives path, with its open conflicts and the newest one's time", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(route, params);
      r.status(200);
      const drives = r.json<{ drives: { mountPath: string; openConflicts: number; latestConflictAt: string | null }[] }>().drives;
      const paths = drives.map((d) => d.mountPath);
      if (new Set(paths).size !== paths.length || paths.some((m) => !m.startsWith('/drives/'))) {
        throw new Error(`bad mount paths ${paths.join(',')}`);
      }
      // The conflict notice compares latestConflictAt across reads: null with no open conflict.
      const badConflicts = drives.filter((d) =>
        d.openConflicts === 0 ? d.latestConflictAt !== null : Number.isNaN(Date.parse(d.latestConflictAt ?? '')),
      );
      if (badConflicts.length) throw new Error(`bad conflict fields ${JSON.stringify(badConflicts)}`);
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

flow(
  'DRIVE-3',
  {
    domain: 'drives',
    // One wait for every API process to see the new member (≤45 s).
    timeoutMs: 300_000,
    routes: [
      'POST /v1/drives/:driveId/files/upload',
      'PUT /v1/drives/:driveId/files/upload/:uploadId/blocks/:sha',
      'POST /v1/drives/:driveId/files/upload/:uploadId/commit',
    ],
  },
  async (ctx) => {
    const { createHash } = await import('node:crypto');
    const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
    const MiB = 1024 * 1024;
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'user');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const listFiles = { query: { projectId: project.id } };
    // Two blocks: one full 1 MiB block and a 10-byte tail.
    const content = 'a'.repeat(MiB) + 'tail-bytes';
    const blocks = [sha(content.slice(0, MiB)), sha(content.slice(MiB))];
    let driveId = '';
    let ownerFolder = '';
    let path = '';
    let uploadId = '';
    let storage = true;
    const block = (id: string, s: string) => ({ params: { driveId, uploadId: id, sha: s } });

    await ctx.step('OWNER and the member open Files', async () => {
      const drive = (await owner.get('/v1/drives', listFiles)).status(200).json<{ drives: any[] }>().drives[0];
      driveId = drive.driveId;
      ownerFolder = drive.personalFolder;
      await waitForFilesStatus(ctx, listFiles, 200, member);
      const mine = (await asMember.get('/v1/drives', listFiles)).status(200).json<{ drives: any[] }>().drives[0];
      path = `${mine.personalFolder}/uploads/big.bin`;
    });

    await ctx.step('the member makes a folder for the upload → 200 (503 drive_storage_unavailable without drive storage)', async () => {
      const mkdir = () => asMember.post('/v1/drives/:driveId/files/mkdir', { path: path.slice(0, path.lastIndexOf('/')) }, { params: { driveId } });
      let r = await mkdir();
      // The drive's first write creates its storage volume (~24 s locally): a
      // 25 s request deadline can answer 503 first. The volume is made either way.
      if (r.statusCode === 503 && r.json<{ code?: string }>().code === 'request_deadline') r = await mkdir();
      if (r.statusCode === 503) {
        r.body().has('$.code', 'drive_storage_unavailable');
        storage = false;
        return;
      }
      r.status([200, 409]);
    });

    await ctx.step('ANON cannot plan an upload → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).post('/v1/drives/:driveId/files/upload', { path, size: content.length, blocks }, { params: { driveId } })).status(401);
    });

    await ctx.step("the member plans into OWNER's private folder → 404; a wrong block count → 400", async () => {
      (await asMember.post('/v1/drives/:driveId/files/upload', { path: `${ownerFolder}/x.bin`, size: content.length, blocks }, { params: { driveId } })).status(404);
      (await asMember.post('/v1/drives/:driveId/files/upload', { path, size: content.length, blocks: blocks.slice(0, 1) }, { params: { driveId } })).status(400);
      (await asMember.post('/v1/drives/:driveId/files/upload', { path, size: content.length, blocks: ['NOT-A-SHA', blocks[1]] }, { params: { driveId } })).status(400);
    });

    if (!storage) return;

    await ctx.step('the member plans a 2-block file in their folder → 200: an upload id and the blocks storage lacks', async () => {
      const r = await asMember.post('/v1/drives/:driveId/files/upload', { path, size: content.length, blocks }, { params: { driveId } });
      const planned = r.status(200).json<{ uploadId: string; missing: string[] }>();
      uploadId = planned.uploadId;
      if (!uploadId || !planned.missing.every((m) => blocks.includes(m))) throw new Error(`plan ${r.text()}`);
    });

    await ctx.step("OWNER cannot use the member's upload id, and a changed id is refused → 404 upload_not_found", async () => {
      (await owner.put('/v1/drives/:driveId/files/upload/:uploadId/blocks/:sha', content.slice(0, MiB), { ...block(uploadId, blocks[0]!), raw: true }))
        .status(404)
        .body()
        .has('$.code', 'upload_not_found');
      (await owner.post('/v1/drives/:driveId/files/upload/:uploadId/commit', {}, { params: { driveId, uploadId } })).status(404);
      (await asMember.post('/v1/drives/:driveId/files/upload/:uploadId/commit', {}, { params: { driveId, uploadId: `${uploadId}x` } })).status(404);
    });

    await ctx.step('a block over 1 MiB → 413; a block name that is not a sha256 → 400', async () => {
      (await asMember.put('/v1/drives/:driveId/files/upload/:uploadId/blocks/:sha', `${content.slice(0, MiB)}x`, { ...block(uploadId, blocks[0]!), raw: true })).status(413);
      (await asMember.put('/v1/drives/:driveId/files/upload/:uploadId/blocks/:sha', 'x', { ...block(uploadId, 'nope'), raw: true })).status(400);
    });

    await ctx.step('the member sends both blocks (each twice: safe to resend) → 204, and commits → 200 {path,size}', async () => {
      for (const [i, part] of [content.slice(0, MiB), content.slice(MiB)].entries()) {
        for (let n = 0; n < 2; n++) {
          (await asMember.put('/v1/drives/:driveId/files/upload/:uploadId/blocks/:sha', part, { ...block(uploadId, blocks[i]!), raw: true })).status(204);
        }
      }
      (await asMember.post('/v1/drives/:driveId/files/upload/:uploadId/commit', {}, { params: { driveId, uploadId } }))
        .status(200)
        .body()
        .has('$.path', path)
        .has('$.size', content.length);
    });

    await ctx.step('the file reads back byte for byte (sha256 equal); OWNER still cannot read it → 404', async () => {
      const read = (await asMember.get('/v1/drives/:driveId/files/content', { params: { driveId }, query: { path } })).status(200);
      if (read.text().length !== content.length || sha(read.text()) !== sha(content)) throw new Error(`read back ${read.text().length} bytes`);
      (await owner.get('/v1/drives/:driveId/files/content', { params: { driveId }, query: { path } })).status(404);
    });

    await ctx.step('a plan with a stale If-Match → 409 file_changed', async () => {
      (await asMember.post('/v1/drives/:driveId/files/upload', { path, size: content.length, blocks }, { params: { driveId }, headers: { 'if-match': '"stale-version"' } }))
        .status(409)
        .body()
        .has('$.code', 'file_changed');
    });

    await ctx.step('cleanup: the member deletes the upload folder → 204', async () => {
      (await asMember.del('/v1/drives/:driveId/files', { params: { driveId }, query: { path: path.slice(0, path.lastIndexOf('/')), recursive: 'true' } })).status(204);
    });
  },
);

flow(
  'DRIVE-4',
  {
    domain: 'drives',
    timeoutMs: 300_000,
    routes: [
      'GET /v1/drives/:driveId/usage',
      'GET /v1/drives/usage',
      'PUT /v1/drives/:driveId/files/content',
      'POST /v1/drives/:driveId/files/upload',
      'PUT /v1/admin/api/accounts/:id/overrides',
      'POST /v1/workspaces/:projectId/artifacts',
    ],
  },
  async (ctx) => {
    const GiB = 1024 ** 3;
    const team = await ctx.fixtures.team({ name: ctx.fixtures.name('drive4-limits') });
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    let driveId = '';
    let folder = '';
    const admin = ctx.env.capabilities.admin ? ctx.client.withBearer(ctx.env.adminToken!, 'ADMIN_TOKEN') : null;
    const setOverrides = (patch: Record<string, unknown>) =>
      admin!.put('/v1/admin/api/accounts/:id/overrides', patch, { params: { id: team.id } });

    try {
      await ctx.step('setup: OWNER opens the project Files', async () => {
        const drive = (await owner.get('/v1/drives', { query: { projectId: project.id } })).status(200).json<{ drives: any[] }>().drives[0];
        driveId = drive.driveId;
        folder = drive.personalFolder;
      });

      await ctx.step('the project usage names every limit: the plan figure, one file, the folder-mount cap, mounts per session', async () => {
        const r = (await owner.get('/v1/drives/:driveId/usage', { params: { driveId } })).status(200);
        const u = r.json<{ driveId: string; projectId: string; limits: Record<string, number | null>; account: unknown; folders: unknown[] }>();
        if (u.driveId !== driveId || u.projectId !== project.id) throw new Error(`usage of another drive ${JSON.stringify(u)}`);
        const l = u.limits;
        // A fresh team is on Free (or No Plan): 5 GiB per project and per account.
        if (l.projectBytes !== 5 * GiB || l.accountBytes !== 5 * GiB) throw new Error(`plan limits ${JSON.stringify(l)}`);
        if (!(Number(l.fileBytes) > 0) || !(Number(l.folderMountBytes) > 0) || !(Number(l.mountsPerSession) > 0)) throw new Error(`limits ${JSON.stringify(l)}`);
        if (l.requestBytes !== 64 * 1024 * 1024) throw new Error(`request limit ${l.requestBytes}`);
        if (!Array.isArray(u.folders)) throw new Error('no folders');
        const list = (await owner.get('/v1/drives', { query: { projectId: project.id } })).status(200).json<{ drives: any[] }>().drives[0];
        if (list.sizeLimitBytes !== 5 * GiB) throw new Error(`the drive's sizeLimitBytes is not the plan's: ${list.sizeLimitBytes}`);
      });

      await ctx.step('ANON → 401; NONMEMBER cannot read the usage → 403/404', async () => {
        (await ctx.client.as(ctx.P.ANON).get('/v1/drives/:driveId/usage', { params: { driveId } })).status(401);
        (await ctx.client.as(ctx.P.NONMEMBER).get('/v1/drives/:driveId/usage', { params: { driveId } })).status([403, 404]);
      });

      await ctx.step("the account's storage lists its project with the account limit; NONMEMBER → 403", async () => {
        const r = (await owner.get('/v1/drives/usage', { query: { account_id: team.id } })).status(200);
        const a = r.json<{ accountId: string; usedBytes: number; limits: { accountBytes: number }; projects: { projectId: string; name: string; driveId: string }[] }>();
        if (a.accountId !== team.id || a.limits.accountBytes !== 5 * GiB) throw new Error(`account usage ${JSON.stringify(a)}`);
        const row = a.projects.find((p) => p.projectId === project.id);
        if (!row || row.driveId !== driveId || !row.name) throw new Error(`the project is missing: ${JSON.stringify(a.projects)}`);
        (await ctx.client.as(ctx.P.NONMEMBER).get('/v1/drives/usage', { query: { account_id: team.id } })).status(403);
        (await ctx.client.as(ctx.P.ANON).get('/v1/drives/usage', { query: { account_id: team.id } })).status(401);
      });

      await ctx.step("an account member of the 1:1 workspace is in it: the account's storage list names the project", async () => {
        // Membership is access (design.md C3). A non-member is refused above.
        const member = await team.addMember('member');
        // Membership reaches every API process within 15 s; until then the route may answer 403.
        const deadline = Date.now() + 45_000;
        let r = await ctx.client.as(member).get('/v1/drives/usage', { query: { account_id: team.id } });
        while (r.statusCode !== 200 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          r = await ctx.client.as(member).get('/v1/drives/usage', { query: { account_id: team.id } });
        }
        if (r.statusCode === 403) return; // no billing.read: nothing is disclosed either
        r.status(200);
        const listed = r.json<{ projects: { projectId: string; name: string }[] }>().projects;
        if (!listed.some((p) => p.projectId === project.id)) {
          throw new Error(`a member of the workspace does not see it in the storage list: ${JSON.stringify(listed)}`);
        }
      });

      if (!admin) return;

      await ctx.step('an operator sets a 1 KiB project limit; the usage reads it back', async () => {
        (await setOverrides({ driveProjectBytes: { value: 1024 } })).status(200).body().has('$.overrides.driveProjectBytes.value', 1024);
        (await setOverrides({ driveProjectBytes: { value: 1.5 } })).status(400);
        (await owner.get('/v1/drives/:driveId/usage', { params: { driveId } })).status(200).body().has('$.limits.projectBytes', 1024);
      });

      await ctx.step('a 2 KiB upload is refused before any byte reaches storage → 403 storage_limit_exceeded with the numbers', async () => {
        const body = 'x'.repeat(2048);
        (await owner.put('/v1/drives/:driveId/files/content', body, { params: { driveId }, query: { path: `${folder}/big.txt` }, raw: true }))
          .status(403)
          .body()
          .has('$.code', 'storage_limit_exceeded')
          .has('$.limit', 'project_bytes')
          .has('$.max', 1024)
          .has('$.requested', 2048);
        // The block upload is refused at its plan, before a block is sent.
        (await owner.post('/v1/drives/:driveId/files/upload', { path: `${folder}/big.bin`, size: 2048, blocks: ['a'.repeat(64)] }, { params: { driveId } }))
          .status(403)
          .body()
          .has('$.code', 'storage_limit_exceeded')
          .has('$.limit', 'project_bytes');
      });

      await ctx.step('an Artifact publish is held to the same limit → refused with storage_limit_exceeded', async () => {
        const r = await owner.post(
          '/v1/workspaces/:projectId/artifacts',
          { files: { 'index.md': { content: `# Big\n\n${'z'.repeat(4096)}` } } },
          { params: { projectId: project.id } },
        );
        // The artifact routes answer a storage refusal with their older status (409).
        r.status(409).body().has('$.code', 'storage_limit_exceeded').has('$.limit', 'project_bytes').has('$.max', 1024);
      });

      await ctx.step('the account limit applies across projects → 403 limit account_bytes', async () => {
        (await setOverrides({ driveProjectBytes: null, driveAccountBytes: { value: 1024 } })).status(200);
        (await owner.put('/v1/drives/:driveId/files/content', 'y'.repeat(2048), { params: { driveId }, query: { path: `${folder}/big.txt` }, raw: true }))
          .status(403)
          .body()
          .has('$.code', 'storage_limit_exceeded')
          .has('$.limit', 'account_bytes')
          .has('$.max', 1024);
      });

      await ctx.step('one file over the folder-mount cap → 413 file_too_large, at the plan', async () => {
        (await setOverrides({ driveAccountBytes: null })).status(200);
        const limits = (await owner.get('/v1/drives/:driveId/usage', { params: { driveId } })).status(200).json<{ limits: { fileBytes: number } }>().limits;
        const size = limits.fileBytes + 1;
        (await owner.post('/v1/drives/:driveId/files/upload', { path: `${folder}/huge.bin`, size, blocks: Array.from({ length: Math.ceil(size / (1024 * 1024)) }, () => 'b'.repeat(64)) }, { params: { driveId } }))
          .status(413)
          .body()
          .has('$.code', 'file_too_large')
          .has('$.limit', 'file_bytes')
          .has('$.max', limits.fileBytes);
      });
    } finally {
      if (admin) await setOverrides({ driveProjectBytes: null, driveAccountBytes: null }).catch(() => undefined);
    }
  },
);
