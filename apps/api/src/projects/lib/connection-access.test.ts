import { describe, expect, test } from 'bun:test';
import {
  type ConnectionReachabilityRow,
  connectionIsReachable,
  connectionNeedsPrivateSession,
  connectionRowIsReachable,
  isTrustedManagedChannelAuthorization,
} from './connection-access';

const human = {
  actingUserId: 'user-1',
  actingPrincipalIsServiceAccount: false,
  audience: 'open' as const,
};

const serviceAccount = {
  actingUserId: '',
  actingPrincipalIsServiceAccount: true,
  audience: 'open' as const,
};

describe('a shared account narrowed to an audience', () => {
  // `in` / `out` are resolved for the person the call acts for; `open` means
  // nobody narrowed the account, or it is shared with everyone in the project.
  test('open: every principal that may use the connector, as before', () => {
    expect(connectionIsReachable({ ownerType: 'project', ownerId: null, ...human })).toBe(true);
    expect(connectionIsReachable({ ownerType: 'project', ownerId: null, ...serviceAccount })).toBe(true);
  });

  test('narrowed: only a human the audience names', () => {
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...human, audience: 'in' }),
    ).toBe(true);
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...human, audience: 'out' }),
    ).toBe(false);
  });

  test('narrowed: an unattended service account reaches it never, even when "in"', () => {
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...serviceAccount, audience: 'in' }),
    ).toBe(false);
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...serviceAccount, audience: 'out' }),
    ).toBe(false);
  });

  test('narrowed: an agent principal reaches it only for a named human, in a private session', () => {
    const agent = (visibility: 'private' | 'project', onBehalfOfUserId: string | null) => ({
      ownerType: 'project' as const,
      ownerId: null,
      actingUserId: 'sa-1',
      actingPrincipalIsServiceAccount: true,
      agentPrincipal: { onBehalfOfUserId, visibility },
    });
    expect(connectionIsReachable({ ...agent('private', 'user-1'), audience: 'in' })).toBe(true);
    expect(connectionIsReachable({ ...agent('project', 'user-1'), audience: 'in' })).toBe(false);
    expect(connectionIsReachable({ ...agent('private', 'user-1'), audience: 'out' })).toBe(false);
    expect(connectionIsReachable({ ...agent('private', null), audience: 'in' })).toBe(false);
    // An open shared account stays reachable by an agent principal in any session.
    expect(connectionIsReachable({ ...agent('project', null), audience: 'open' })).toBe(true);
  });

  test('the audience never widens a private account', () => {
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: 'user-2', ...human, audience: 'in' }),
    ).toBe(false);
  });

  test('a narrowed shared account needs a private session, like a personal one', () => {
    expect(connectionNeedsPrivateSession('member', 'open')).toBe(true);
    expect(connectionNeedsPrivateSession('project', 'in')).toBe(true);
    expect(connectionNeedsPrivateSession('project', 'out')).toBe(true);
    expect(connectionNeedsPrivateSession('project', 'open')).toBe(false);
    expect(connectionNeedsPrivateSession('external', 'open')).toBe(false);
  });
});

describe('connection reachability', () => {
  test('a project-owned account is reachable by every principal that may use the connector', () => {
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...human }),
    ).toBe(true);
    // The whole point of retiring the strategy flag: an unattended automation
    // now uses the shared account instead of having nothing it can reach.
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...serviceAccount }),
    ).toBe(true);
  });

  test('a member-owned account is reachable only by its own owner', () => {
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: 'user-1', ...human }),
    ).toBe(true);
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: 'user-2', ...human }),
    ).toBe(false);
  });

  test('a service account never runs as somebody personal account', () => {
    expect(
      connectionIsReachable({
        ownerType: 'member',
        ownerId: 'user-1',
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: true,
        audience: 'open' as const,
      }),
    ).toBe(false);
  });

  test('an absent acting user never matches an absent owner', () => {
    // `actingUserId` defaults to '' with no human in context; an owner id that
    // is empty or null must not read as "the caller owns this".
    expect(
      connectionIsReachable({
        ownerType: 'member',
        ownerId: '',
        actingUserId: '',
        actingPrincipalIsServiceAccount: false,
        audience: 'open' as const,
      }),
    ).toBe(false);
    expect(
      connectionIsReachable({
        ownerType: 'member',
        ownerId: null,
        actingUserId: '',
        actingPrincipalIsServiceAccount: false,
        audience: 'open' as const,
      }),
    ).toBe(false);
  });

  test('agent, subject and bare external ownership stay unreachable', () => {
    for (const ownerType of ['agent', 'subject', 'external'] as const) {
      expect(
        connectionIsReachable({ ownerType, ownerId: 'owner-1', ...human }),
      ).toBe(false);
    }
  });

  test('trusted managed email authorizations are the one external exception', () => {
    const managedSystem = isTrustedManagedChannelAuthorization({
      providerType: 'channel',
      platform: 'email',
      ownerType: 'external',
      ownerId: 'agentmail:inbox-1',
      metadata: { channel_connection: true, inbox_id: 'inbox-1' },
    });
    expect(managedSystem).toBe(true);
    expect(
      connectionIsReachable({
        ownerType: 'external',
        ownerId: 'agentmail:inbox-1',
        trustedManagedSystem: managedSystem,
        ...human,
      }),
    ).toBe(true);
  });

  test('generic external metadata cannot activate the managed exception', () => {
    expect(
      isTrustedManagedChannelAuthorization({
        providerType: 'http',
        platform: null,
        ownerType: 'external',
        ownerId: 'agentmail:inbox-1',
        metadata: { channel_connection: true, inbox_id: 'inbox-1' },
      }),
    ).toBe(false);
    expect(
      isTrustedManagedChannelAuthorization({
        providerType: 'channel',
        platform: 'email',
        ownerType: 'external',
        ownerId: 'managed-1',
        metadata: { channel_connection: true, inbox_id: 'inbox-1' },
      }),
    ).toBe(false);
  });
});

// Spec docs/specs/2026-09-22-agents-as-principals.md §2.3: under the
// agent-principal model the acting principal is the agent's service account,
// so a member-owned account keys on `on_behalf_of` AND a private session.
describe('connection reachability for an agent-principal session', () => {
  const agentSession = (onBehalfOfUserId: string | null, visibility: 'private' | 'project' | 'restricted' | null) => ({
    actingUserId: '',
    actingPrincipalIsServiceAccount: true,
    audience: 'open' as const,
    agentPrincipal: { onBehalfOfUserId, visibility },
  });

  test("the on-behalf-of human's own account is reachable in a private session", () => {
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: 'user-1', ...agentSession('user-1', 'private') }),
    ).toBe(true);
  });

  test("another member's account is never reachable", () => {
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: 'user-2', ...agentSession('user-1', 'private') }),
    ).toBe(false);
  });

  test('a shared session reaches no personal account', () => {
    for (const visibility of ['project', 'restricted', null] as const) {
      expect(
        connectionIsReachable({ ownerType: 'member', ownerId: 'user-1', ...agentSession('user-1', visibility) }),
      ).toBe(false);
    }
  });

  test('an unattended run (no on_behalf_of) reaches no personal account', () => {
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: 'user-1', ...agentSession(null, 'private') }),
    ).toBe(false);
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: '', ...agentSession(null, 'private') }),
    ).toBe(false);
  });

  test('the launcher passed as actingUserId does not count: only on_behalf_of does', () => {
    expect(
      connectionIsReachable({
        ownerType: 'member',
        ownerId: 'user-1',
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: false,
        audience: 'open' as const,
        agentPrincipal: { onBehalfOfUserId: null, visibility: 'private' },
      }),
    ).toBe(false);
  });

  test('project accounts stay reachable; agent/subject accounts stay closed', () => {
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...agentSession(null, 'project') }),
    ).toBe(true);
    for (const ownerType of ['agent', 'subject'] as const) {
      expect(
        connectionIsReachable({ ownerType, ownerId: 'user-1', ...agentSession('user-1', 'private') }),
      ).toBe(false);
    }
  });
});

// `connectionRowIsReachable` is the one adapter from a loaded row (joined to its
// connector) to `connectionIsReachable`. The mutation rule, the connection list,
// OAuth completion and session bindings all ask through it.
describe('connection row reachability', () => {
  const memberRow = (ownerId: string | null): ConnectionReachabilityRow => ({
    ownerType: 'member',
    ownerId,
    metadata: {},
    providerType: 'mcp',
    connectorConfig: {},
  });
  const managedChannelRow = (
    overrides: Partial<ConnectionReachabilityRow> = {},
  ): ConnectionReachabilityRow => ({
    ownerType: 'external',
    ownerId: 'agentmail:inbox-1',
    metadata: { channel_connection: true, inbox_id: 'inbox-1' },
    providerType: 'channel',
    connectorConfig: { platform: 'email' },
    ...overrides,
  });
  const humanActor = (userId: string) => ({ userId, isServiceAccount: false, agentPrincipal: null });
  const serviceActor = { userId: '', isServiceAccount: true, agentPrincipal: null };

  test('a project row is reachable by a human and a service account', () => {
    const row: ConnectionReachabilityRow = { ...memberRow(null), ownerType: 'project' };
    expect(connectionRowIsReachable(row, humanActor('user-1'), 'open')).toBe(true);
    expect(connectionRowIsReachable(row, serviceActor, 'open')).toBe(true);
  });

  test('a member row is reachable only by its human owner', () => {
    expect(connectionRowIsReachable(memberRow('user-1'), humanActor('user-1'), 'open')).toBe(true);
    expect(connectionRowIsReachable(memberRow('user-1'), humanActor('user-2'), 'open')).toBe(false);
    expect(connectionRowIsReachable(memberRow('user-1'), { ...serviceActor, userId: 'user-1' }, 'open')).toBe(
      false,
    );
    expect(connectionRowIsReachable(memberRow(''), serviceActor, 'open')).toBe(false);
  });

  test('the managed-channel exception comes from the row and its connector config', () => {
    expect(connectionRowIsReachable(managedChannelRow(), humanActor('user-1'), 'open')).toBe(true);
    expect(connectionRowIsReachable(managedChannelRow(), serviceActor, 'open')).toBe(true);
    // A non-string platform is no platform.
    expect(
      connectionRowIsReachable(
        managedChannelRow({ connectorConfig: { platform: ['email'] } }),
        humanActor('user-1'), 'open'
      ),
    ).toBe(false);
    expect(
      connectionRowIsReachable(managedChannelRow({ connectorConfig: {} }), humanActor('user-1'), 'open'),
    ).toBe(false);
    expect(
      connectionRowIsReachable(managedChannelRow({ providerType: 'http' }), humanActor('user-1'), 'open'),
    ).toBe(false);
    expect(
      connectionRowIsReachable(
        managedChannelRow({ ownerId: 'agentmail:another-inbox' }),
        humanActor('user-1'), 'open'
      ),
    ).toBe(false);
  });

  test('an agent principal reaches only its on-behalf-of human in a private session', () => {
    const agent = (onBehalfOfUserId: string | null, visibility: 'private' | 'project') => ({
      userId: 'user-2',
      isServiceAccount: true,
      agentPrincipal: { onBehalfOfUserId, visibility },
    });
    expect(connectionRowIsReachable(memberRow('user-1'), agent('user-1', 'private'), 'open')).toBe(true);
    expect(connectionRowIsReachable(memberRow('user-1'), agent('user-1', 'project'), 'open')).toBe(false);
    expect(connectionRowIsReachable(memberRow('user-1'), agent(null, 'private'), 'open')).toBe(false);
    expect(connectionRowIsReachable(memberRow('user-2'), agent('user-1', 'private'), 'open')).toBe(false);
  });

  test('a narrowed project row follows the audience: in for a human, never a service account', () => {
    const row: ConnectionReachabilityRow = { ...memberRow(null), ownerType: 'project' };
    expect(connectionRowIsReachable(row, humanActor('user-1'), 'in')).toBe(true);
    expect(connectionRowIsReachable(row, humanActor('user-1'), 'out')).toBe(false);
    expect(connectionRowIsReachable(row, serviceActor, 'in')).toBe(false);
  });

  test('agent and subject rows stay unreachable', () => {
    for (const ownerType of ['agent', 'subject'] as const) {
      expect(
        connectionRowIsReachable({ ...memberRow('user-1'), ownerType }, humanActor('user-1'), 'open'),
      ).toBe(false);
    }
  });
});
