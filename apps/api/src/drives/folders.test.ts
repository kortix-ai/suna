import { describe, expect, test } from 'bun:test';
import {
  type FolderGrant,
  adminOnlyPersonalFolder,
  folderAccess,
  folderKnownToTree,
  folderVisible,
  grantableFolder,
  grantsCovering,
  NO_PRIVATE_CHANNEL_FOLDERS,
  planFolderMounts,
  privateChannelFolderOf,
  sessionMountCandidates,
} from './folders';

describe('folderKnownToTree', () => {
  const grants = [{ path: '/Users/ana' }, { path: '/Research/Q3' }];

  test('a person’s folder, and a shared one, before anything was written to them', () => {
    expect(folderKnownToTree('/Users/ana', grants)).toBe(true);
    expect(folderKnownToTree('/Research', grants)).toBe(true);
    expect(folderKnownToTree('/Research/Q3', grants)).toBe(true);
    expect(folderKnownToTree('/Users', [])).toBe(true);
    expect(folderKnownToTree('/Company', [])).toBe(false);
  });

  test('anything else is not found', () => {
    expect(folderKnownToTree('/Users/bob', grants)).toBe(false);
    expect(folderKnownToTree('/Research/Q3/drafts', grants)).toBe(false);
    expect(folderKnownToTree('/workspace', grants)).toBe(false);
  });
});

// Private channels: a Drive path or listing must not reach a private channel's
// folder, and another thread's sandbox must not mount it.

describe('a private channel folder is reached only by its members', () => {
  const P = '/Channels/deals';
  const CH = new Set([P]);
  const grants: FolderGrant[] = [
    { path: '/Company', level: 'write', principalType: 'agent', principalId: 'sa', source: 'system' },
    { path: P, level: 'write', principalType: 'user', principalId: 'alice', source: 'system' },
  ];
  const alice = { userId: 'alice', privateChannelFolders: CH };
  const bob = { userId: 'bob', privateChannelFolders: CH };
  const admin = { userId: 'root', admin: true, privateChannelFolders: CH };

  test('privateChannelFolderOf names the channel folder of any path in it, and only of a private channel of the project', () => {
    expect(privateChannelFolderOf(`${P}/Memory/a.md`, CH)).toBe(P);
    expect(privateChannelFolderOf(P, CH)).toBe(P);
    expect(privateChannelFolderOf('/Channels', CH)).toBeNull();
    expect(privateChannelFolderOf('/Company/Channels/deals', CH)).toBeNull();
    expect(privateChannelFolderOf('/Channels/notes/a.md', CH)).toBeNull();
    expect(privateChannelFolderOf(`${P}/a.md`, NO_PRIVATE_CHANNEL_FOLDERS)).toBeNull();
  });

  test('a member reads and writes it; a non-member and a project admin get nothing', () => {
    expect(folderAccess(`${P}/Memory/a.md`, grants, alice)).toBe('write');
    expect(folderAccess(`${P}/Memory/a.md`, grants, bob)).toBe('none');
    expect(folderAccess(`${P}/Memory/a.md`, grants, admin)).toBe('none');
    expect(folderAccess('/Company/x.md', grants, admin)).toBe('manage');
  });

  test('a grant above the folder never reaches into it', () => {
    const wide: FolderGrant[] = [...grants, { path: '/', level: 'manage', principalType: 'user', principalId: 'bob' }];
    expect(folderAccess(`${P}/a.md`, wide, bob)).toBe('none');
  });

  test('the listing shows /Channels and the folder only to a member', () => {
    expect(folderVisible('/Channels', grants, alice)).toBe(true);
    expect(folderVisible(P, grants, alice)).toBe(true);
    for (const who of [bob, admin]) {
      expect(folderVisible('/Channels', grants, who)).toBe(false);
      expect(folderVisible(P, grants, who)).toBe(false);
    }
  });

  test('nothing in a private channel folder, nor /Channels that holds it, can be shared', () => {
    expect(grantableFolder('/Channels', CH)).toBe(false);
    expect(grantableFolder(P, CH)).toBe(false);
    expect(grantableFolder(`${P}/Memory`, CH)).toBe(false);
    expect(grantableFolder('/Company/Channels/ops', CH)).toBe(true);
    expect(grantableFolder('/Channels/notes', CH)).toBe(true);
  });
});

// Production blocker (prod-readiness finding 1): only the folders of a
// project's private channels are reserved. A folder a person made at
// `/Channels` keeps its sharing, its admin access and its mounts.
describe('a person-made /Channels folder is an ordinary folder', () => {
  const NOTES = '/Channels/notes';
  const grants: FolderGrant[] = [
    { path: '/Company', level: 'write', principalType: 'agent', principalId: 'sa', source: 'system' },
    { path: NOTES, level: 'write', principalType: 'user', principalId: 'bob' },
    { path: '/Channels/team', level: 'read', principalType: 'agent', principalId: 'sa' },
  ];
  // Flag off and no private channel (every project today), then a project with one private channel.
  for (const [label, channels] of [
    ['no private channel', NO_PRIVATE_CHANNEL_FOLDERS],
    ['a private channel elsewhere in /Channels', new Set(['/Channels/1f0e7c9a-0000-4000-8000-000000000001'])],
  ] as const) {
    const bob = { userId: 'bob', privateChannelFolders: channels };
    const carol = { userId: 'carol', privateChannelFolders: channels };
    const admin = { userId: 'root', admin: true, privateChannelFolders: channels };

    test(`${label}: its grants count, admins manage it, it can be shared`, () => {
      expect(folderAccess(`${NOTES}/a.md`, grants, bob)).toBe('write');
      expect(folderAccess(`${NOTES}/a.md`, grants, carol)).toBe('none');
      // A folder granted to an agent: a person reaches it only through that agent's Drive rules, never by being in the project.
      expect(folderAccess('/Channels/team/x.md', grants, carol)).toBe('none');
      expect(folderAccess(`${NOTES}/a.md`, grants, admin)).toBe('manage');
      expect(folderVisible(NOTES, grants, carol)).toBe(false);
      expect(folderVisible(NOTES, grants, bob)).toBe(true);
      expect(folderVisible('/Channels', grants, bob)).toBe(true);
      expect(grantableFolder(NOTES, channels)).toBe(true);
      expect(grantsCovering(`${NOTES}/a.md`, grants, channels).map((g) => g.path)).toEqual([NOTES]);
    });

    test(`${label}: a session mounts it`, () => {
      const plan = planFolderMounts(
        sessionMountCandidates(grants, { agentId: 'sa', owner: 'bob', groupIds: new Set(), own: null, channelFolder: null, privateChannelFolders: channels }),
        16,
        channels,
      ).mounts.map((m) => `${m.path}${m.readOnly ? ':ro' : ''}`);
      expect(plan).toEqual(['/Company', '/Channels/team:ro', NOTES]);
    });
  }

  test('no private channel: /Channels itself is shared and mounted like any folder', () => {
    const top: FolderGrant[] = [{ path: '/Channels', level: 'read', principalType: 'agent', principalId: 'sa' }];
    expect(grantableFolder('/Channels', NO_PRIVATE_CHANNEL_FOLDERS)).toBe(true);
    expect(folderAccess('/Channels/x.md', top, { agentId: 'sa' })).toBe('read');
    const mounts = planFolderMounts(
      sessionMountCandidates(top, { agentId: 'sa', owner: null, groupIds: new Set(), own: null, channelFolder: null, privateChannelFolders: NO_PRIVATE_CHANNEL_FOLDERS }),
      16,
    ).mounts;
    expect(mounts.map((m) => m.path)).toEqual(['/Channels']);
  });

  test('with a private channel, a grant on /Channels itself never mounts (the mount would show the channel folder) and never reaches into it', () => {
    const PRIV = '/Channels/1f0e7c9a-0000-4000-8000-000000000001';
    const channels = new Set([PRIV]);
    const top: FolderGrant[] = [{ path: '/Channels', level: 'manage', principalType: 'user', principalId: 'bob' }];
    const bob = { userId: 'bob', privateChannelFolders: channels };
    expect(folderAccess('/Channels/notes/a.md', top, bob)).toBe('manage');
    expect(folderAccess(`${PRIV}/a.md`, top, bob)).toBe('none');
    const mounts = planFolderMounts(
      sessionMountCandidates(top, { agentId: 'sa', owner: 'bob', groupIds: new Set(), own: null, channelFolder: null, privateChannelFolders: channels }),
      16,
      channels,
    ).mounts;
    expect(mounts).toEqual([]);
  });
});

describe('only the channel’s own threads mount a private channel folder', () => {
  const CH = new Set(['/Channels/deals', '/Channels/legal']);
  const grants: FolderGrant[] = [
    { path: '/Company', level: 'write', principalType: 'agent', principalId: 'sa', source: 'system' },
    { path: '/Users/alice', level: 'manage', principalType: 'user', principalId: 'alice', source: 'system' },
    { path: '/Channels/deals', level: 'write', principalType: 'user', principalId: 'alice', source: 'system' },
    { path: '/Channels/legal', level: 'write', principalType: 'user', principalId: 'alice', source: 'system' },
  ];
  const paths = (channelFolder: string | null, owner: string | null) =>
    planFolderMounts(
      sessionMountCandidates(grants, { agentId: 'sa', owner, groupIds: new Set(), own: owner ? '/Users/alice' : null, channelFolder, privateChannelFolders: CH }),
      16,
      CH,
    ).mounts.map((m) => `${m.path}${m.readOnly ? ':ro' : ''}`);

  test('a #general thread, even alice’s own private one, mounts no /Channels folder', () => {
    expect(paths(null, null)).toEqual(['/Company']);
    expect(paths(null, 'alice')).toEqual(['/Users/alice', '/Company']);
  });

  test('a thread of #deals mounts /Channels/deals read-write and no other private channel', () => {
    expect(paths('/Channels/deals', null)).toEqual(['/Company:ro', '/Channels/deals']);
    expect(paths('/Channels/deals', 'alice')).toEqual(['/Users/alice:ro', '/Company:ro', '/Channels/deals']);
  });

  test('in a private channel thread every folder but the channel’s own is read-only, so nothing of it is copied out', () => {
    const plan = planFolderMounts(
      sessionMountCandidates(grants, { agentId: 'sa', owner: 'alice', groupIds: new Set(), own: '/Users/alice', channelFolder: '/Channels/deals', privateChannelFolders: CH }),
      16,
    ).mounts;
    expect(plan.filter((m) => !m.readOnly).map((m) => m.path)).toEqual(['/Channels/deals']);
  });
});

describe('with chat on, a public channel or DM thread mounts its space folder', () => {
  const grants: FolderGrant[] = [
    { path: '/Users/ana', level: 'manage', principalType: 'user', principalId: 'ana', source: 'system' },
    { path: '/Sales', level: 'read', principalType: 'agent', principalId: 'sa', source: 'admin' },
  ];
  const paths = (spaceFolder: string | null, owner: string | null) =>
    planFolderMounts(
      sessionMountCandidates(grants, { agentId: 'sa', owner, groupIds: new Set(), own: owner ? '/Users/ana' : null, channelFolder: null, privateChannelFolders: NO_PRIVATE_CHANNEL_FOLDERS, spaceFolder }),
      16,
    ).mounts.map((m) => `${m.path}@${m.mountPath}${m.readOnly ? ':ro' : ''}`);

  test('a #general thread and its workers mount /Company/Channels/general read-write', () => {
    expect(paths('/Company/Channels/general', null)).toEqual(['/Sales@/drives/sales:ro', '/Company/Channels/general@/drives/general']);
    expect(paths(null, null)).toEqual(['/Sales@/drives/sales:ro']);
  });

  test('a DM folder inside the owner’s own folder is not mounted twice', () => {
    expect(paths('/Users/ana/Agents/writer', 'ana')).toEqual(['/Users/ana@/drives/me', '/Sales@/drives/sales:ro']);
    expect(paths('/Users/ana/Agents/writer', null)).toEqual(['/Sales@/drives/sales:ro', '/Users/ana/Agents/writer@/drives/writer']);
  });
});

// A person's own folder opens for its owner and the project's admins (as
// people, never through a session); each admin open is recorded for the owner.
describe("a person's own folder opens for its owner and for admins as people", () => {
  const ANA = '/Users/ana';
  const grants: FolderGrant[] = [
    { path: ANA, level: 'manage', principalType: 'user', principalId: 'ana', source: 'system' },
    { path: '/Company', level: 'write', principalType: 'agent', principalId: 'sa', source: 'system' },
  ];
  const ana = { userId: 'ana' };
  const bob = { userId: 'bob' };
  const adminPerson = { userId: 'root', admin: true, adminPeople: true };
  const adminSession = { userId: 'root', admin: true };

  test('an admin signed in as a person manages it and sees it listed; a session of that admin does not', () => {
    expect(folderAccess(`${ANA}/notes.md`, grants, adminPerson)).toBe('manage');
    expect(folderVisible(ANA, grants, adminPerson)).toBe(true);
    expect(folderAccess(`${ANA}/notes.md`, grants, adminSession)).toBe('none');
    expect(folderVisible(ANA, grants, adminSession)).toBe(false);
  });

  test('adminPeople without admin reaches nothing; a plain member still gets nothing', () => {
    expect(folderAccess(ANA, grants, { ...bob, adminPeople: true })).toBe('none');
    expect(folderAccess(ANA, grants, bob)).toBe('none');
  });

  test('adminOnlyPersonalFolder names the folder an admin reaches only as admin, never their own or a shared one', () => {
    expect(adminOnlyPersonalFolder(`${ANA}/notes.md`, grants, adminPerson)).toBe(ANA);
    expect(adminOnlyPersonalFolder(`${ANA}/notes.md`, grants, ana)).toBeNull();
    expect(adminOnlyPersonalFolder('/Company/x.md', grants, adminPerson)).toBeNull();
    const shared: FolderGrant[] = [...grants, { path: `${ANA}/Shared`, level: 'read', principalType: 'user', principalId: 'root' }];
    expect(adminOnlyPersonalFolder(`${ANA}/Shared/a.md`, shared, adminPerson)).toBeNull();
    expect(adminOnlyPersonalFolder(`${ANA}/notes.md`, shared, adminPerson)).toBe(ANA);
  });

  test("a session never mounts another person's folder through its admin", () => {
    const candidates = sessionMountCandidates(grants, { agentId: 'sa', owner: 'root', groupIds: new Set(), own: null, channelFolder: null, privateChannelFolders: NO_PRIVATE_CHANNEL_FOLDERS });
    expect(candidates.some((c) => c.path === ANA)).toBe(false);
  });
});

// Shared Drives (2026-11-03, `shared_drives`): nothing is shared with the
// whole project; an admin adds agents to a Drive, and everyone who may use one
// of them reaches it. The flag only decides whether `agentIds` is filled.
describe('shared Drives', () => {
  const grants: FolderGrant[] = [
    { path: '/Users/ana', level: 'manage', principalType: 'user', principalId: 'ana', source: 'system' },
    { path: '/Sales', level: 'write', principalType: 'agent', principalId: 'sa-sales' },
  ];

  test('a Drive added to an agent reaches everyone who may use that agent, at the grant level, and nobody else', () => {
    expect(folderAccess('/Sales/q3.md', grants, { userId: 'ana', agentIds: new Set(['sa-sales']) })).toBe('write');
    expect(folderAccess('/Sales/q3.md', grants, { userId: 'ana', agentIds: new Set(['sa-support']) })).toBe('none');
    expect(folderVisible('/Sales', grants, { userId: 'ana' })).toBe(false);
  });

  test('a person with no agent (or with the flag off: no agentIds) has only their own folder', () => {
    const ana = { userId: 'ana' };
    expect(folderVisible('/Users/ana', grants, ana)).toBe(true);
    expect(folderAccess('/Sales/q3.md', grants, ana)).toBe('none');
    expect(folderAccess('/Company/Memory/x.md', grants, ana)).toBe('none');
    expect(folderKnownToTree('/Company', [])).toBe(false);
  });

  test("a session of the agent mounts the Drive; a session of another agent does not, whoever started it", () => {
    const mounts = (agentId: string | null) =>
      planFolderMounts(
        sessionMountCandidates(grants, { agentId, owner: 'ana', groupIds: new Set(), own: '/Users/ana', channelFolder: null, privateChannelFolders: NO_PRIVATE_CHANNEL_FOLDERS }),
        16,
      ).mounts.map((m) => `${m.path}@${m.mountPath}${m.readOnly ? ':ro' : ''}`);
    expect(mounts('sa-sales')).toEqual(['/Users/ana@/drives/me', '/Sales@/drives/sales']);
    expect(mounts('sa-support')).toEqual(['/Users/ana@/drives/me']);
    // The flag off: planSessionDrives passes no agent, so only the person's own folder mounts.
    expect(mounts(null)).toEqual(['/Users/ana@/drives/me']);
  });

  test("a private channel thread mounts the agent's Drive read-only", () => {
    const CH = new Set(['/Channels/deals']);
    const plan = planFolderMounts(
      sessionMountCandidates(grants, { agentId: 'sa-sales', owner: null, groupIds: new Set(), own: null, channelFolder: '/Channels/deals', privateChannelFolders: CH }),
      16,
      CH,
    ).mounts.map((m) => `${m.path}${m.readOnly ? ':ro' : ''}`);
    expect(plan).toEqual(['/Sales:ro', '/Channels/deals']);
  });
});
