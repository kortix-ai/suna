import { describe, expect, test } from 'bun:test';
import {
  projectSessionIdForProjectPrincipal,
  resolveTokenBoundSessionId,
} from '../../connectors/db-deps';
import {
  RequiredConnectorConnectionUnavailableError,
  type ValidatedSessionConnectorBinding,
  canonicalConnectorAlias,
  connectorBindingPayloadConflicts,
  mayUseLegacyDefaultConnection,
  parseSessionConnectorBindings,
  resolveRequiredConnectorConnections,
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

describe('required-connector pre-flight never strands a backend caller', () => {
  const bound = (alias: string): ValidatedSessionConnectorBinding => ({
    alias,
    connectionId: '33333333-3333-4333-a333-333333333333',
    connectorId: '44444444-4444-4444-a444-444444444444',
    ownerType: 'project',
    ownerId: null,
    authorizationStrategy: 'project',
  });

  test('an explicitly bound alias is satisfied without any lookup', async () => {
    // A wrapper credential binds by connection_id and has no personal
    // upstream identity, so a "go connect it" refusal is one it can never
    // satisfy. An alias the caller already bound must short-circuit the
    // pre-flight entirely — the assertions below hold with no database
    // fixtures precisely because that path issues no query.
    const res = await resolveRequiredConnectorConnections({
      accountId: '55555555-5555-4555-a555-555555555555',
      projectId: '66666666-6666-4666-a666-666666666666',
      actingUserId: '77777777-7777-4777-a777-777777777777',
      actingPrincipalIsServiceAccount: true,
      aliases: ['veyris', 'veyris'],
      explicitBindings: [bound('veyris')],
    });

    expect(res).toEqual({ ok: true, bindings: [] });
  });

  test('the public email alias is matched against its canonical binding', async () => {
    // `require_connectors: ['email']` and a binding stored as `kortix_email` are
    // the same connector. Comparing the raw strings would refuse a session the
    // caller had already bound correctly.
    const res = await resolveRequiredConnectorConnections({
      accountId: '55555555-5555-4555-a555-555555555555',
      projectId: '66666666-6666-4666-a666-666666666666',
      actingUserId: '77777777-7777-4777-a777-777777777777',
      actingPrincipalIsServiceAccount: true,
      aliases: ['email'],
      explicitBindings: [bound(canonicalConnectorAlias('email'))],
    });

    expect(res).toEqual({ ok: true, bindings: [] });
  });
});

describe('RequiredConnectorConnectionUnavailableError carries every alias', () => {
  test('the list is the contract; `alias` is a convenience read of the first', () => {
    // The prompt path threw on the first unconfigured alias while create's
    // pre-flight returned all of them, and the guide promised the create shape
    // for both. A caller who fixed the one name they were handed got refused
    // again by the next — one failed prompt per missing connector.
    const error = new RequiredConnectorConnectionUnavailableError(['gmail', 'slack']);
    expect(error.aliases).toEqual(['gmail', 'slack']);
    expect(error.alias).toBe('gmail');
    expect(error.code).toBe('REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE');
  });

  test('the sentence agrees in number with the list', () => {
    // `Required connection "a", "b" is unavailable` reads as a bug in the
    // product to the person it is shown to.
    expect(new RequiredConnectorConnectionUnavailableError(['gmail']).message).toBe(
      'Required connection "gmail" is unavailable',
    );
    expect(new RequiredConnectorConnectionUnavailableError(['gmail', 'slack']).message).toBe(
      'Required connections "gmail", "slack" are unavailable',
    );
  });

  test('a bare string still works, so existing throw sites are unchanged', () => {
    const error = new RequiredConnectorConnectionUnavailableError('gmail');
    expect(error.aliases).toEqual(['gmail']);
    expect(error.alias).toBe('gmail');
  });

  test('an empty alias never reaches the message as an empty pair of quotes', () => {
    expect(new RequiredConnectorConnectionUnavailableError(['gmail', '']).aliases).toEqual(['gmail']);
  });
});
