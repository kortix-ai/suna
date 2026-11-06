/**
 * Real-Postgres contract for a project's Files: one drive, folder grants in
 * `kortix.role_assignments`, and what a session mounts from them; plus the
 * fold of the earlier per-person / per-account / per-agent drives into it.
 *
 *   a grant covers its folder and everything below it;
 *   a person's own folder is theirs alone (admins included);
 *   nothing is shared with the whole project or person to person: only a
 *   grant to an agent counts (a shared Drive), and only with `shared_drives` on;
 *   an agent reaches only what was granted to it;
 *   folding is idempotent and never overwrites a file already there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountGroupMembers, accountGroups, accountMembers, accounts, driveGrants, drives, projectSessions, projects, serviceAccounts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { driveVolumeName } from '../drives/access';
import { type FoldStorage, foldDrive } from '../drives/fold';
import { folderAccess } from '../drives/folders';
import {
  ensurePersonalFolder,
  ensureProjectDrive,
  listFolderGrants,
  planSessionDrives,
  setFolderGrant,
} from '../drives/service';
import { clearAuthorizeCaches } from '../iam/authorize';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ANA = crypto.randomUUID();
const BOB = crypto.randomUUID();
const DESIGN = crypto.randomUUID();
const RESEARCHER = crypto.randomUUID();
const ANA_SESSION = crypto.randomUUID();
const TRIGGER_SESSION = crypto.randomUUID();

/** The project's `shared_drives` flag (`projects.metadata.experimental.shared_drives`). */
async function setSharedDrives(on: boolean) {
  await db.update(projects).set({ metadata: { experimental: { shared_drives: on } } }).where(eq(projects.projectId, PROJECT));
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'project-files' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'project-files',
    repoUrl: 'https://example.test/project-files.git',
  });
  for (const userId of [ANA, BOB]) {
    await insertIntoView(db, accountMembers, { userId, accountId: ACCOUNT, accountRole: 'member' });
  }
  await db.insert(accountGroups).values({ groupId: DESIGN, accountId: ACCOUNT, name: 'Design' });
  await db.insert(accountGroupMembers).values({ groupId: DESIGN, userId: BOB });
  await db.insert(serviceAccounts).values({
    serviceAccountId: RESEARCHER,
    accountId: ACCOUNT,
    projectId: PROJECT,
    agentName: 'researcher',
    name: 'researcher',
    secretHash: `files-${RESEARCHER}`,
    publicPrefix: 'kortix_sa_files',
  });
  await db.insert(projectSessions).values([
    { sessionId: ANA_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: ANA_SESSION, createdBy: ANA, visibility: 'private', agentName: 'researcher' },
    // A trigger's session: no person behind it, only its agent and the project.
    { sessionId: TRIGGER_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: TRIGGER_SESSION, createdBy: ANA, visibility: 'project', origin: 'trigger', agentName: 'researcher' },
  ]);
  clearAuthorizeCaches();
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('folder access in a project’s Files', () => {
  test('grants inherit down the tree; own folders stay private; agents reach only what was granted, and only with shared_drives on', async () => {
    const drive = await ensureProjectDrive(ACCOUNT, PROJECT);
    expect((await ensureProjectDrive(ACCOUNT, PROJECT)).driveId).toBe(drive.driveId);
    // A new drive shares nothing with the project: no `/Company` grant, no project grant at all.
    expect((await listFolderGrants(drive)).filter((g) => !g.path.startsWith('/Users/'))).toEqual([]);
    const anaFolder = await ensurePersonalFolder(drive, ANA);
    const bobFolder = await ensurePersonalFolder(drive, BOB);
    expect(anaFolder).toMatch(/^\/Users\//);
    expect(bobFolder).not.toBe(anaFolder);

    // A person-to-team share and a project-wide grant (stored before Drive went
    // agent-first) reach nobody; the agent's grants on Research and Sales count.
    await setFolderGrant({ drive, path: `${anaFolder}/Shared`, principal: { type: 'group', id: DESIGN }, level: 'read', grantedBy: ANA });
    await setFolderGrant({ drive, path: '/Research', principal: { type: 'agent', id: RESEARCHER }, level: 'write', grantedBy: ANA });
    // Sharing again changes the level instead of adding a second grant.
    await setFolderGrant({ drive, path: '/Research', principal: { type: 'agent', id: RESEARCHER }, level: 'manage', grantedBy: ANA });
    await setFolderGrant({ drive, path: '/Sales', principal: { type: 'agent', id: RESEARCHER }, level: 'read', grantedBy: ANA });
    const grants = await listFolderGrants(drive);
    expect(grants.filter((g) => g.path === '/Research')).toHaveLength(1);
    expect(grants.filter((g) => g.principalType === 'group')).toEqual([]);

    // Bob may use the researcher agent (shared_drives on): he reaches the shared Drives added to it.
    const ana = { userId: ANA };
    const bob = { userId: BOB, groupIds: new Set([DESIGN]), agentIds: new Set([RESEARCHER]) };
    const admin = { userId: crypto.randomUUID(), admin: true };
    const agent = { agentId: RESEARCHER };

    expect(folderAccess(`${anaFolder}/deep/notes.md`, grants, ana)).toBe('manage');
    // The team share no longer counts.
    expect(folderAccess(`${anaFolder}/Shared/plan.md`, grants, bob)).toBe('none');
    expect(folderAccess(`${anaFolder}/private.md`, grants, bob)).toBe('none');
    // Admins manage everything but people's own folders.
    expect(folderAccess(anaFolder, grants, admin)).toBe('none');
    expect(folderAccess('/Research/notes.md', grants, admin)).toBe('manage');
    // No folder is the whole project's: Bob reaches the folders granted to the agent he may use, nothing else.
    expect(folderAccess('/Research/notes.md', grants, bob)).toBe('manage');
    expect(folderAccess('/Sales/pipeline.md', grants, bob)).toBe('read');
    expect(folderAccess('/Other/notes.md', grants, bob)).toBe('none');
    expect(folderAccess('/Agents/researcher/notes.md', grants, bob)).toBe('none');
    expect(folderAccess('/Company/Memory/team.md', grants, bob)).toBe('none');
    // Ana may not use the agent here: none of its shared Drives.
    expect(folderAccess('/Research/notes.md', grants, ana)).toBe('none');
    // The agent: its grants, nothing of Ana's.
    expect(folderAccess('/Research/sources/a.pdf', grants, agent)).toBe('manage');
    expect(folderAccess(`${anaFolder}/notes.md`, grants, agent)).toBe('none');
    expect(folderAccess(`${anaFolder}/Shared/plan.md`, grants, agent)).toBe('none');

    // shared_drives off: the agent's grants mount nowhere.
    await setSharedDrives(false);
    const off = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: ANA_SESSION, bootingUserId: ANA, agentName: 'researcher', slots: 6 });
    expect(off.mounts.map((m) => [m.path, m.mountPath, m.readOnly])).toEqual([[anaFolder, '/drives/me', false]]);
    expect(off.skipped).toEqual([]);
    const offTrigger = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: TRIGGER_SESSION, bootingUserId: null, agentName: 'researcher', slots: 6 });
    expect(offTrigger.mounts).toEqual([]);

    // shared_drives on: Ana's own session mounts her folder as the desktop, then the folders granted to the agent.
    await setSharedDrives(true);
    const personal = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: ANA_SESSION, bootingUserId: ANA, agentName: 'researcher', slots: 6 });
    expect(personal.mounts.map((m) => [m.path, m.mountPath, m.readOnly])).toEqual([
      [anaFolder, '/drives/me', false],
      ['/Research', '/drives/research', false],
      ['/Sales', '/drives/sales', true],
    ]);
    // A trigger of the same agent: no person, so no one's own folder.
    const unattended = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: TRIGGER_SESSION, bootingUserId: null, agentName: 'researcher', slots: 6 });
    expect(unattended.mounts.map((m) => m.path).sort()).toEqual(['/Research', '/Sales']);
    // Out of slots: the rest is reported, never dropped silently.
    const tight = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: ANA_SESSION, bootingUserId: ANA, agentName: 'researcher', slots: 1 });
    expect(tight.mounts.map((m) => m.path)).toEqual([anaFolder]);
    expect(tight.skipped).toEqual(['/Research', '/Sales']);
    const two = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: ANA_SESSION, bootingUserId: ANA, agentName: 'researcher', slots: 2 });
    expect(two.mounts.map((m) => m.path)).toEqual([anaFolder, '/Research']);
    expect(two.skipped).toEqual(['/Sales']);
  });
});

describe('folding the earlier drives into the project’s Files', () => {
  test('personal, company and agent drives land in folders, only agent grants carried over, once', async () => {
    const files = new Map<string, Map<string, Uint8Array<ArrayBuffer>>>();
    const vol = (name: string) => files.get(name) ?? files.set(name, new Map()).get(name)!;
    const bytes = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
    const storage: FoldStorage = {
      listFiles: async (v) => [...vol(v.name).entries()].map(([path, b]) => ({ path, size: b.byteLength })),
      exists: async (v, p) => vol(v.name).has(p),
      read: async (v, p) => vol(v.name).get(p)!,
      write: async (v, p, b) => void vol(v.name).set(p, b),
      writeLarge: async () => {
        throw new Error('no large files here');
      },
      open: async (d) => ({ name: d.platinumVolumeName, region: null }),
    };
    const legacy = async (values: Partial<typeof drives.$inferInsert> & { kind: string; name: string }) => {
      const driveId = crypto.randomUUID();
      const [row] = await db
        .insert(drives)
        .values({ driveId, accountId: ACCOUNT, platinumVolumeName: driveVolumeName(driveId), platinumVolumeId: `vol-${driveId}`, ...values })
        .returning();
      return row!;
    };
    const mine = await legacy({ kind: 'personal', name: 'My Drive', ownerUserId: ANA, isDefault: true });
    vol(mine.platinumVolumeName).set('/From agents/report.md', bytes('report'));
    vol(mine.platinumVolumeName).set('/notes.md', bytes('ana notes'));
    await db.insert(driveGrants).values({ driveId: mine.driveId, subjectType: 'user', userId: BOB, access: 'read' });
    const specs = await legacy({ kind: 'company', name: 'Specs' });
    vol(specs.platinumVolumeName).set('/plan.md', bytes('plan'));
    await db.insert(driveGrants).values([
      { driveId: specs.driveId, subjectType: 'project', projectId: PROJECT, access: 'read' },
      { driveId: specs.driveId, subjectType: 'agent', projectId: PROJECT, agentName: 'researcher', access: 'write' },
    ]);
    const agentDrive = await legacy({ kind: 'agent', name: 'researcher', projectId: PROJECT, agentName: 'researcher' });
    vol(agentDrive.platinumVolumeName).set('/memory.md', bytes('remember'));

    const project = await ensureProjectDrive(ACCOUNT, PROJECT);
    const anaFolder = await ensurePersonalFolder(project, ANA);
    // Something already at a destination is kept, not overwritten.
    vol(project.platinumVolumeName).set(`${anaFolder}/notes.md`, bytes('newer'));

    const first = [...(await foldDrive(mine, storage)), ...(await foldDrive(specs, storage)), ...(await foldDrive(agentDrive, storage))];
    expect(first.map((r) => [r.kind, r.path, r.copied, r.kept])).toEqual([
      ['personal', anaFolder, 1, 1],
      ['company', '/Shared/Specs', 1, 0],
      ['agent', '/Agents/researcher', 1, 0],
    ]);
    const dest = vol(project.platinumVolumeName);
    expect(new TextDecoder().decode(dest.get(`${anaFolder}/From agents/report.md`))).toBe('report');
    expect(new TextDecoder().decode(dest.get(`${anaFolder}/notes.md`))).toBe('newer');
    expect(dest.has('/Shared/Specs/plan.md')).toBe(true);

    // Only the agent grants survive the fold: Bob's read on Ana's drive and the
    // project's read on Specs are dropped. The old agent drive becomes a shared
    // Drive added to its agent (write).
    const grants = await listFolderGrants(project);
    expect(grants.filter((g) => g.path === '/Agents/researcher').map((g) => [g.principalType, g.principalId, g.level])).toEqual([['agent', RESEARCHER, 'write']]);
    const bob = { userId: BOB, groupIds: new Set([DESIGN]) };
    const bobWithAgent = { ...bob, agentIds: new Set([RESEARCHER]) };
    const agent = { agentId: RESEARCHER };
    const admin = { userId: crypto.randomUUID(), admin: true };
    expect(folderAccess(`${anaFolder}/notes.md`, grants, bob)).toBe('none');
    expect(folderAccess('/Shared/Specs/plan.md', grants, bob)).toBe('none');
    expect(folderAccess('/Shared/Specs/plan.md', grants, agent)).toBe('write');
    // Specs was shared with the agent: whoever may use it reaches it (shared_drives on).
    expect(folderAccess('/Shared/Specs/plan.md', grants, bobWithAgent)).toBe('write');
    // The folded agent drive reaches its agent and, with shared_drives on, whoever may use it; nobody else.
    expect(folderAccess('/Agents/researcher/memory.md', grants, agent)).toBe('write');
    expect(folderAccess('/Agents/researcher/memory.md', grants, bobWithAgent)).toBe('write');
    expect(folderAccess('/Agents/researcher/memory.md', grants, bob)).toBe('none');
    expect(folderAccess('/Agents/researcher/memory.md', grants, admin)).toBe('manage');

    // Run again: every target is marked done and nothing is copied twice.
    const again = [...(await foldDrive(mine, storage)), ...(await foldDrive(specs, storage)), ...(await foldDrive(agentDrive, storage))];
    expect(again.every((r) => r.skipped === 'already_folded' && r.copied === 0)).toBe(true);
  });
});
