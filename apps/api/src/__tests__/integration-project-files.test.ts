/**
 * Real-Postgres contract for a project's Files: one drive, folder grants in
 * `kortix.role_assignments`, and what a session mounts from them; plus the
 * fold of the earlier per-person / per-account / per-agent drives into it.
 *
 *   a grant covers its folder and everything below it;
 *   a person's own folder is theirs alone (admins included) until shared;
 *   an agent reaches only what is shared with it, the project or its person;
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
  test('grants inherit down the tree; own folders stay private; agents reach only what was shared', async () => {
    const drive = await ensureProjectDrive(ACCOUNT, PROJECT);
    expect((await ensureProjectDrive(ACCOUNT, PROJECT)).driveId).toBe(drive.driveId);
    const anaFolder = await ensurePersonalFolder(drive, ANA);
    const bobFolder = await ensurePersonalFolder(drive, BOB);
    expect(anaFolder).toMatch(/^\/Users\//);
    expect(bobFolder).not.toBe(anaFolder);

    // Ana shares one subfolder with the Design team, read-only; the agent gets Research.
    await setFolderGrant({ drive, path: `${anaFolder}/Shared`, principal: { type: 'group', id: DESIGN }, level: 'read', grantedBy: ANA });
    await setFolderGrant({ drive, path: '/Research', principal: { type: 'agent', id: RESEARCHER }, level: 'write', grantedBy: ANA });
    // Sharing again changes the level instead of adding a second grant.
    await setFolderGrant({ drive, path: '/Research', principal: { type: 'agent', id: RESEARCHER }, level: 'manage', grantedBy: ANA });
    const grants = await listFolderGrants(drive);
    expect(grants.filter((g) => g.path === '/Research')).toHaveLength(1);

    const ana = { userId: ANA, projectMember: true };
    const bob = { userId: BOB, groupIds: new Set([DESIGN]), projectMember: true };
    const admin = { userId: crypto.randomUUID(), projectMember: true, admin: true };
    const agent = { agentId: RESEARCHER, projectMember: true };

    expect(folderAccess(`${anaFolder}/deep/notes.md`, grants, ana)).toBe('manage');
    expect(folderAccess(`${anaFolder}/Shared/plan.md`, grants, bob)).toBe('read');
    expect(folderAccess(`${anaFolder}/private.md`, grants, bob)).toBe('none');
    // Admins manage everything but people's own folders.
    expect(folderAccess(anaFolder, grants, admin)).toBe('none');
    expect(folderAccess('/Company/Memory/team.md', grants, admin)).toBe('manage');
    // Everyone in the project writes Company by default.
    expect(folderAccess('/Company/Memory/team.md', grants, bob)).toBe('write');
    // The agent: its grant and the project's, nothing of Ana's.
    expect(folderAccess('/Research/sources/a.pdf', grants, agent)).toBe('manage');
    expect(folderAccess(`${anaFolder}/notes.md`, grants, agent)).toBe('none');
    expect(folderAccess(`${anaFolder}/Shared/plan.md`, grants, agent)).toBe('none');

    // Ana's own session: her folder as the desktop, plus what the agent and project reach.
    const personal = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: ANA_SESSION, bootingUserId: ANA, agentName: 'researcher', slots: 6 });
    expect(personal.mounts.map((m) => [m.path, m.mountPath, m.readOnly])).toEqual([
      [anaFolder, '/drives/me', false],
      ['/Research', '/drives/research', false],
      ['/Company', '/drives/company', false],
    ]);
    // A trigger of the same agent: no person, so no one's own folder.
    const unattended = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: TRIGGER_SESSION, bootingUserId: null, agentName: 'researcher', slots: 6 });
    expect(unattended.mounts.map((m) => m.path).sort()).toEqual(['/Company', '/Research']);
    // Out of slots: the rest is reported, never dropped silently.
    const tight = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId: ANA_SESSION, bootingUserId: ANA, agentName: 'researcher', slots: 1 });
    expect(tight.mounts.map((m) => m.path)).toEqual([anaFolder]);
    expect(tight.skipped).toEqual(['/Research', '/Company']);
  });
});

describe('folding the earlier drives into the project’s Files', () => {
  test('personal, company and agent drives land in folders with the same access, once', async () => {
    const files = new Map<string, Map<string, Uint8Array<ArrayBuffer>>>();
    const vol = (name: string) => files.get(name) ?? files.set(name, new Map()).get(name)!;
    const bytes = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
    const storage: FoldStorage = {
      listFiles: async (v) => [...vol(v).entries()].map(([path, b]) => ({ path, size: b.byteLength })),
      exists: async (v, p) => vol(v).has(p),
      read: async (v, p) => vol(v).get(p)!,
      write: async (v, p, b) => void vol(v).set(p, b),
      writeLarge: async () => {
        throw new Error('no large files here');
      },
      open: async (d) => d.platinumVolumeName,
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

    const grants = await listFolderGrants(project);
    const bob = { userId: BOB, groupIds: new Set([DESIGN]), projectMember: true };
    const agent = { agentId: RESEARCHER, projectMember: true };
    expect(folderAccess(`${anaFolder}/notes.md`, grants, bob)).toBe('read');
    expect(folderAccess('/Shared/Specs/plan.md', grants, bob)).toBe('read');
    expect(folderAccess('/Shared/Specs/plan.md', grants, agent)).toBe('write');
    expect(folderAccess('/Agents/researcher/memory.md', grants, agent)).toBe('write');

    // Run again: every target is marked done and nothing is copied twice.
    const again = [...(await foldDrive(mine, storage)), ...(await foldDrive(specs, storage)), ...(await foldDrive(agentDrive, storage))];
    expect(again.every((r) => r.skipped === 'already_folded' && r.copied === 0)).toBe(true);
  });
});
