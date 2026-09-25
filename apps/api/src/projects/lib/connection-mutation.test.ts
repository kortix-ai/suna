import { describe, expect, test } from 'bun:test';
import { mayMutateConnection } from './connection-mutation';

const OWNER = 'user-owner';
const OTHER = 'user-other';
const INBOX = 'inbox-1';

function row(overrides: Partial<Parameters<typeof mayMutateConnection>[0]> = {}) {
  return {
    ownerType: 'member' as const,
    ownerId: OWNER,
    metadata: {},
    providerType: 'mcp',
    connectorConfig: {},
    ...overrides,
  };
}

const projectRow = row({ ownerType: 'project', ownerId: null });

const managedChannelRow = row({
  ownerType: 'external',
  ownerId: `agentmail:${INBOX}`,
  providerType: 'channel',
  connectorConfig: { platform: 'email' },
  metadata: { channel_connection: true, inbox_id: INBOX },
});

function human(userId: string, mayManageSystemConnections: boolean) {
  return { userId, isServiceAccount: false, mayManageSystemConnections, agentPrincipal: null };
}

function serviceAccount(mayManageSystemConnections: boolean) {
  return { userId: '', isServiceAccount: true, mayManageSystemConnections, agentPrincipal: null };
}

function agentSession(
  onBehalfOfUserId: string | null,
  visibility: 'private' | 'project' | 'restricted' | null = 'private',
) {
  return {
    userId: OTHER,
    isServiceAccount: true,
    mayManageSystemConnections: false,
    agentPrincipal: { onBehalfOfUserId, visibility },
  };
}

describe('mayMutateConnection', () => {
  test('a member may mutate their own private connection without the manage capability', () => {
    expect(mayMutateConnection(row(), human(OWNER, false))).toBe(true);
  });

  test("another member's private connection is never mutable, even with the manage capability", () => {
    expect(mayMutateConnection(row(), human(OTHER, false))).toBe(false);
    expect(mayMutateConnection(row(), human(OTHER, true))).toBe(false);
  });

  test('a project-owned connection needs the manage capability', () => {
    expect(mayMutateConnection(projectRow, human(OWNER, true))).toBe(true);
    expect(mayMutateConnection(projectRow, human(OWNER, false))).toBe(false);
  });

  test('a service account may mutate a project connection with manage and never a member connection', () => {
    expect(mayMutateConnection(projectRow, serviceAccount(true))).toBe(true);
    expect(mayMutateConnection(projectRow, serviceAccount(false))).toBe(false);
    expect(mayMutateConnection(row(), serviceAccount(true))).toBe(false);
    expect(mayMutateConnection(row({ ownerId: '' }), serviceAccount(true))).toBe(false);
  });

  test('a trusted managed-channel row is reachable and still needs the manage capability', () => {
    expect(mayMutateConnection(managedChannelRow, human(OWNER, true))).toBe(true);
    expect(mayMutateConnection(managedChannelRow, human(OWNER, false))).toBe(false);
    const untrusted = { ...managedChannelRow, ownerId: 'agentmail:another-inbox' };
    expect(mayMutateConnection(untrusted, human(OWNER, true))).toBe(false);
  });

  test('an agent principal reaches only the private row of the human it acts for, in a private session', () => {
    expect(mayMutateConnection(row(), agentSession(OWNER))).toBe(true);
    expect(mayMutateConnection(row(), agentSession(OTHER))).toBe(false);
    expect(mayMutateConnection(row(), agentSession(null))).toBe(false);
    expect(mayMutateConnection(row(), agentSession(OWNER, 'project'))).toBe(false);
  });

  test('agent and subject rows are never mutable', () => {
    for (const ownerType of ['agent', 'subject'] as const) {
      expect(mayMutateConnection(row({ ownerType }), human(OWNER, true))).toBe(false);
    }
  });
});
