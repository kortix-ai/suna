import { describe, expect, test } from 'bun:test';
import {
  projectSessionIdForProjectPrincipal,
  resolveTokenBoundSessionId,
} from '../../connectors/db-deps';
import {
  type ValidatedSessionConnectorBinding,
  canonicalConnectorAlias,
  connectorBindingPayloadConflicts,
  mayUseLegacyDefaultConnection,
  parseSessionConnectorBindings,
  selectEntitledConnectorConnection,
} from './session-connector-bindings';

describe('session connector binding security contracts', () => {
  const connectionA = '11111111-1111-4111-a111-111111111111';
  const connectionB = '22222222-2222-4222-a222-222222222222';

  test('idempotent replay accepts reordered identical bindings and conflicts on connection swap', () => {
    expect(
      connectorBindingPayloadConflicts(
        { email: { connection_id: connectionA }, veyris: { connection_id: connectionB } },
        { veyris: { connection_id: connectionB }, email: { connection_id: connectionA } },
      ),
    ).toBe(false);
    expect(
      connectorBindingPayloadConflicts(
        { veyris: { connection_id: connectionA } },
        { veyris: { connection_id: connectionB } },
      ),
    ).toBe(true);
  });

  test('public email alias canonicalizes and binding input stays typed', () => {
    expect(canonicalConnectorAlias('email')).toBe('kortix_email');
    expect(parseSessionConnectorBindings({ email: { connection_id: connectionA } }).ok).toBe(true);
    expect(parseSessionConnectorBindings({ email: { connection_id: connectionA, token: 'no' } }).ok).toBe(
      false,
    );
  });

  test('caller header can never replace authenticated session identity', () => {
    expect(resolveTokenBoundSessionId('session-a', 'session-a')).toEqual({
      ok: true,
      sessionId: 'session-a',
    });
    expect(resolveTokenBoundSessionId('session-a', 'session-b')).toEqual({ ok: false });
    expect(resolveTokenBoundSessionId(null, 'session-b')).toEqual({ ok: false });
  });

  test('Supabase authentication session identity is not a Kortix project session identity', () => {
    expect(projectSessionIdForProjectPrincipal(undefined, 'supabase-auth-session')).toBeNull();
    expect(
      projectSessionIdForProjectPrincipal('11111111-1111-4111-a111-111111111111', 'kortix-session'),
    ).toBe('kortix-session');
  });

  test('legacy defaults are allowed only when the session has zero durable bindings', () => {
    expect(mayUseLegacyDefaultConnection(false)).toBe(true);
    expect(mayUseLegacyDefaultConnection(true)).toBe(false);
  });
});

/**
 * Account selection is what replaced the per-session connector dropdown. The
 * agent may reach EVERY account it is entitled to and names one at call time,
 * so the two properties that matter are: an unnamed call keeps the old
 * behavior (the default account), and a named-but-unknown account is never
 * silently substituted — that would run "send as Work" against Personal.
 */
describe('selectEntitledConnectorConnection', () => {
  const work = {
    connectionId: '11111111-1111-4111-a111-111111111111',
    connectorId: 'c1',
    alias: 'gmail',
    label: 'Work',
    ownerType: 'project' as const,
    isDefault: true,
    status: 'active' as const,
    metadata: {},
  };
  const personal = { ...work, connectionId: '22222222-2222-4222-a222-222222222222', label: 'Personal', ownerType: 'member' as const, isDefault: false };
  const accounts = [work, personal];

  test('no account named, exactly one pinned → the pinned account, exactly as before', () => {
    expect(selectEntitledConnectorConnection(accounts, null)).toEqual({ kind: 'one', connection: work });
    expect(selectEntitledConnectorConnection(accounts, undefined)).toEqual({ kind: 'one', connection: work });
    expect(selectEntitledConnectorConnection(accounts, '   ')).toEqual({ kind: 'one', connection: work });
  });

  test('no account named, several reachable and NONE pinned → ambiguous, not a guess', () => {
    const neitherPinned = [{ ...work, isDefault: false }, personal];
    expect(selectEntitledConnectorConnection(neitherPinned, null)).toEqual({
      kind: 'ambiguous',
      connections: neitherPinned,
    });
  });

  test('exactly one entitled account → it, unnamed, pinned or not', () => {
    expect(selectEntitledConnectorConnection([{ ...personal, isDefault: false }], null)).toEqual({
      kind: 'one',
      connection: { ...personal, isDefault: false },
    });
  });

  test('matches a label case-insensitively — humans type the printed name', () => {
    for (const query of ['Personal', 'personal', '  PERSONAL ']) {
      const sel = selectEntitledConnectorConnection(accounts, query);
      expect(sel.kind === 'one' && sel.connection.connectionId).toBe(personal.connectionId);
    }
  });

  test('matches a connection id, which is what the connections API prints', () => {
    const sel = selectEntitledConnectorConnection(accounts, personal.connectionId);
    expect(sel.kind === 'one' && sel.connection.label).toBe('Personal');
  });

  test('an unknown account resolves to nothing rather than the default', () => {
    expect(selectEntitledConnectorConnection(accounts, 'Archive')).toEqual({ kind: 'none' });
  });

  test('no entitled account at all → none for every input', () => {
    expect(selectEntitledConnectorConnection([], null)).toEqual({ kind: 'none' });
    expect(selectEntitledConnectorConnection([], 'Work')).toEqual({ kind: 'none' });
  });

  describe('me / project shorthand', () => {
    const workPinned = { ...work, connectionId: 'aaaaaaaa-1111-4111-a111-111111111111', label: 'Work', ownerType: 'project' as const, isDefault: true };
    const workOther = { ...work, connectionId: 'aaaaaaaa-2222-4111-a111-111111111111', label: 'Other shared', ownerType: 'project' as const, isDefault: false };
    const mePinned = { ...work, connectionId: 'aaaaaaaa-3333-4111-a111-111111111111', label: 'Work email', ownerType: 'member' as const, isDefault: true };
    const meOther = { ...work, connectionId: 'aaaaaaaa-4444-4111-a111-111111111111', label: 'Personal email', ownerType: 'member' as const, isDefault: false };

    test('me: pinned private wins even when a shared account is also pinned', () => {
      const all = [workPinned, mePinned, meOther];
      expect(selectEntitledConnectorConnection(all, 'me')).toEqual({ kind: 'one', connection: mePinned });
    });

    test('me: exactly one private, unpinned → it', () => {
      expect(selectEntitledConnectorConnection([workPinned, meOther], 'me')).toEqual({
        kind: 'one',
        connection: meOther,
      });
    });

    test('me: several private, none pinned → ambiguous among MY OWN accounts only', () => {
      const mineUnpinned = { ...meOther, isDefault: false };
      const otherMine = { ...meOther, connectionId: 'aaaaaaaa-5555-4111-a111-111111111111', label: 'Work 2', isDefault: false };
      expect(selectEntitledConnectorConnection([workPinned, mineUnpinned, otherMine], 'me')).toEqual({
        kind: 'ambiguous',
        connections: [mineUnpinned, otherMine],
      });
    });

    test('me: no private account reachable → none', () => {
      expect(selectEntitledConnectorConnection([workPinned, workOther], 'me')).toEqual({ kind: 'none' });
    });

    test('project: pinned shared wins', () => {
      expect(selectEntitledConnectorConnection([workPinned, workOther, mePinned], 'project')).toEqual({
        kind: 'one',
        connection: workPinned,
      });
    });

    test('project: several shared, none pinned → ambiguous among shared accounts only', () => {
      const sharedA = { ...workOther, isDefault: false };
      const sharedB = { ...workOther, connectionId: 'aaaaaaaa-6666-4111-a111-111111111111', label: 'Sales', isDefault: false };
      expect(selectEntitledConnectorConnection([sharedA, sharedB, mePinned], 'project')).toEqual({
        kind: 'ambiguous',
        connections: [sharedA, sharedB],
      });
    });
  });
});
