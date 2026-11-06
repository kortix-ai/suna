/**
 * Search over a project's Files (`GET /v1/projects/:projectId/search`). Maps
 * to spec §10b (DRIVE-5). The index rows are seeded in the database (the
 * indexer fills them from Platinum volumes, which the local profile has
 * none of), so this flow proves the route's contract: who sees which hit.
 * A team account: OWNER (project admin), a member who may use the agent
 * `worker`, and an account member without project access. With
 * `shared_drives` on, a person finds their own folder and the shared Drives
 * added to an agent they may use; nothing of the project at large.
 */
import { randomUUID } from 'node:crypto';
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';

type Db = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

async function openDb(ctx: FlowContext): Promise<Db> {
  const { Client } = await import('pg');
  const databaseUrl = ctx.env.databaseUrl as string;
  const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const db = new Client({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
  await db.connect();
  return db as unknown as Db;
}

type Hit = { path: string; name: string; kind: string; snippet: string | null; access: string };
type Page = { hits: Hit[]; next_cursor: string | null };

/** Nine shared Drives added to the agent: with the owner's folder and /Sales, more than a session's 8 mount slots. */
const TEAM_FOLDERS = Array.from({ length: 9 }, (_, i) => `/Team-${i + 1}`);

flow(
  'DRIVE-5',
  {
    domain: 'drives',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'GET /v1/workspaces/:projectId/search',
      'GET /v1/drives',
      'PUT /v1/drives/:driveId/access',
      'POST /v1/accounts/tokens',
      'GET /v1/workspaces/:projectId/resource-grants',
      'POST /v1/workspaces/:projectId/resource-grants',
      'PATCH /v1/workspaces/:projectId/features',
    ],
  },
  async (ctx) => {
    const db = await openDb(ctx);
    const team = await ctx.fixtures.team();
    // A managed repository: its starter declares the agent `worker`.
    const project = await team.project({ managedGit: true });
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'user');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const params = { projectId: project.id };
    const search = (as: { get: typeof owner.get }, query: Record<string, string>) => as.get('/v1/workspaces/:projectId/search', { params, query });
    const paths = (r: { json<T>(): T }) => r.json<Page>().hits.map((h) => h.path).sort();
    // One word nothing else in the drive holds.
    const word = `zephyrine${randomUUID().slice(0, 6)}`;
    const AGENT = 'worker';
    const AGENT_DRIVE = '/Sales';
    let driveId = '';
    let ownerFolder = '';
    let memberFolder = '';
    let sessionId = '';
    let tokenId = '';

    try {
      await ctx.step('ANON searches → 401', async () => {
        (await ctx.client.as(ctx.P.ANON).get('/v1/workspaces/:projectId/search', { params, query: { q: word } })).status(401);
      });

      await ctx.step('OWNER and the member open Files → 200: one drive, each with their own folder', async () => {
        const mine = (await owner.get('/v1/drives', { query: { projectId: project.id } })).status(200).json<{ drives: any[] }>().drives[0];
        const theirs = (await asMember.get('/v1/drives', { query: { projectId: project.id } })).status(200).json<{ drives: any[] }>().drives[0];
        driveId = mine.driveId;
        ownerFolder = mine.personalFolder;
        memberFolder = theirs.personalFolder;
        if (theirs.driveId !== driveId || !ownerFolder || !memberFolder || ownerFolder === memberFolder) {
          throw new Error(`unexpected drives: ${JSON.stringify({ mine, theirs })}`);
        }
      });

      await ctx.step('OWNER turns shared_drives on, adds the agent to /Sales (write) and the nine team Drives (read) → 200; a share with a person or the project → 400', async () => {
        (await owner.patch('/v1/workspaces/:projectId/features', { feature: 'shared_drives', enabled: true }, { params })).status(200);
        (await owner.put('/v1/drives/:driveId/access', { path: AGENT_DRIVE, principalType: 'agent', principalId: AGENT, level: 'write' }, { params: { driveId } })).status(200);
        (await owner.put('/v1/drives/:driveId/access', { path: '/Shared', principalType: 'user', principalId: member.userId, level: 'read' }, { params: { driveId } })).status(400);
        (await owner.put('/v1/drives/:driveId/access', { path: '/Shared', principalType: 'project', level: 'read' }, { params: { driveId } })).status(400);
        for (const path of TEAM_FOLDERS) {
          (await owner.put('/v1/drives/:driveId/access', { path, principalType: 'agent', principalId: AGENT, level: 'read' }, { params: { driveId } })).status(200);
        }
      });

      await ctx.step('OWNER lets the member use the agent → 201; every API process sees it within 45 s', async () => {
        (await owner.post(
          '/v1/workspaces/:projectId/resource-grants',
          { resource_type: 'agent', resource_id: AGENT, principal_type: 'member', principal_id: member.userId },
          { params },
        )).status(201);
        const deadline = Date.now() + 45_000;
        for (let streak = 0; streak < 6; ) {
          if (Date.now() > deadline) throw new Error(`the member never reached ${AGENT_DRIVE}`);
          const d = (await asMember.get('/v1/drives', { query: { projectId: project.id } })).status(200).json<{ drives: any[] }>().drives[0];
          streak = d.sharedWithMe?.some((a: { path: string }) => a.path === AGENT_DRIVE) ? streak + 1 : 0;
          if (streak === 0) await new Promise((r) => setTimeout(r, 500));
        }
      });

      await ctx.step('the index holds a file in each folder (seeded as the indexer writes them)', async () => {
        const rows: Array<[string, string]> = [
          [`${ownerFolder}/diary.md`, `the ${word} budget is the owner's own`],
          [`${memberFolder}/notes.md`, `the member's ${word} notes`],
          [`${AGENT_DRIVE}/plan.md`, `sales plan: ${word} starts in week 46`],
          ['/Company/old.md', `a file from before: ${word} is admin-only now`],
          ['/Leadership/pricing.md', `admin-only ${word} pricing`],
          ['/Shared/q3.md', `never shared ${word} forecast`],
          ...TEAM_FOLDERS.map((f): [string, string] => [`${f}/brief.md`, `team brief ${word}`]),
        ];
        for (const [path, body] of rows) {
          await db.query(
            `INSERT INTO kortix.drive_index_entries (drive_id, path, kind, size, name, body)
             VALUES ($1::uuid, $2, 'file', $3, $4, $5)`,
            [driveId, path, Buffer.byteLength(body), path.slice(path.lastIndexOf('/') + 1), body],
          );
        }
        // A file whose name matches: name hits rank first.
        await db.query(
          `INSERT INTO kortix.drive_index_entries (drive_id, path, kind, size, name, body) VALUES ($1::uuid, $2, 'file', 10, $3, '')`,
          [driveId, `${AGENT_DRIVE}/${word}-logo.png`, `${word}-logo.png`],
        );
      });

      await ctx.step("the member's search → 200: their own folder and the shared Drives of their agent; never Company, OWNER's folder or an admin-only folder", async () => {
        const r = (await search(asMember, { q: word, limit: '100' })).status(200);
        const got = paths(r);
        const want = [`${AGENT_DRIVE}/${word}-logo.png`, `${AGENT_DRIVE}/plan.md`, `${memberFolder}/notes.md`, ...TEAM_FOLDERS.map((f) => `${f}/brief.md`)].sort();
        if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`member hits ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        const hits = r.json<Page>().hits;
        if (hits[0]!.path !== `${AGENT_DRIVE}/${word}-logo.png`) throw new Error(`a name hit must rank first: ${hits[0]!.path}`);
        if (hits.find((h) => h.path === `${AGENT_DRIVE}/plan.md`)?.snippet?.includes(word) !== true) throw new Error('no snippet around the word');
        if (hits.find((h) => h.path === `${AGENT_DRIVE}/plan.md`)?.access !== 'write') throw new Error('a write Drive must answer access write');
        if (hits.find((h) => h.path === `${TEAM_FOLDERS[0]}/brief.md`)?.access !== 'read') throw new Error('a read grant to the agent must answer access read');
      });

      await ctx.step("OWNER's search (project admin) → 200: every folder but the member's own", async () => {
        const got = paths((await search(owner, { q: word, limit: '100' })).status(200));
        if (!got.includes('/Leadership/pricing.md') || !got.includes('/Company/old.md') || !got.includes(`${ownerFolder}/diary.md`)) throw new Error(`owner misses hits: ${JSON.stringify(got)}`);
        if (got.includes(`${memberFolder}/notes.md`)) throw new Error("owner sees the member's private folder");
      });

      await ctx.step('limit 2 pages through every hit once; path= keeps the search below one folder', async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
          const query: Record<string, string> = cursor ? { q: word, limit: '2', cursor } : { q: word, limit: '2' };
          const r: Page = (await search(asMember, query)).status(200).json<Page>();
          seen.push(...r.hits.map((h) => h.path));
          cursor = r.next_cursor;
          if (!cursor) break;
        }
        if (seen.length !== 12 || new Set(seen).size !== 12) throw new Error(`paging returned ${seen.length} hits (${new Set(seen).size} distinct), want 12`);
        const under = paths((await search(asMember, { q: word, path: AGENT_DRIVE })).status(200));
        if (JSON.stringify(under) !== JSON.stringify([`${AGENT_DRIVE}/${word}-logo.png`, `${AGENT_DRIVE}/plan.md`].sort())) throw new Error(`path=${AGENT_DRIVE}: ${JSON.stringify(under)}`);
        const company = paths((await search(asMember, { q: word, path: '/Company' })).status(200));
        if (company.length !== 0) throw new Error(`path=/Company finds ${JSON.stringify(company)} for a member`);
      });

      await ctx.step('a session-bound credential of OWNER’s own session of the agent → 200: exactly the folders the session may mount, past its 8 slots too; never Company or the admin-only folder', async () => {
        const minted = (await owner.post('/v1/accounts/tokens', { name: `DRIVE-5 ${randomUUID().slice(0, 8)}` })).status(201).json<{ token_id: string; secret_key: string }>();
        tokenId = minted.token_id;
        sessionId = randomUUID();
        await db.query(
          `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility)
           VALUES ($1, $2, $3, 'main', $5, 'running', $4, 'private')`,
          [sessionId, team.id, project.id, ctx.P.OWNER.userId, AGENT],
        );
        await db.query(
          `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES ($1::uuid, $1, $2, $3, 'active')`,
          [sessionId, team.id, project.id],
        );
        await db.query(`UPDATE kortix.account_tokens SET account_id = $2, project_id = $3, session_id = $4 WHERE token_id = $1`, [tokenId, team.id, project.id, sessionId]);
        const asSession = ctx.client.withBearer(minted.secret_key, 'SESSION_TOKEN');
        const got = paths((await search(asSession, { q: word, limit: '100' })).status(200));
        const want = [`${AGENT_DRIVE}/${word}-logo.png`, `${AGENT_DRIVE}/plan.md`, `${ownerFolder}/diary.md`, ...TEAM_FOLDERS.map((f) => `${f}/brief.md`)].sort();
        if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`session hits ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      });

      await ctx.step('an empty q → 400 invalid_input; a limit that is not a number → 400', async () => {
        (await search(owner, { q: '   ' })).status(400).body().has('$.code', 'invalid_input');
        (await search(owner, { q: word, limit: 'ten' })).status(400).body().has('$.code', 'invalid_input');
      });

      await ctx.step('a person outside the workspace → 404 workspace_not_found', async () => {
        // Membership is access (design.md C3): an account member is in the 1:1 workspace.
        (await search(ctx.client.as(ctx.P.NONMEMBER), { q: word })).status(404).body().has('$.code', 'workspace_not_found');
      });
    } finally {
      if (tokenId) await db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [tokenId]).catch(() => {});
      if (sessionId) {
        await db.query('DELETE FROM kortix.session_sandboxes WHERE sandbox_id = $1::uuid', [sessionId]).catch(() => {});
        await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId]).catch(() => {});
      }
      if (driveId) await db.query('DELETE FROM kortix.drive_index_entries WHERE drive_id = $1::uuid', [driveId]).catch(() => {});
      await db.end();
    }
  },
);
