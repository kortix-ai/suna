import { describe, expect, test } from 'bun:test';
import {
  buildCompleteSessionScopeReplacement,
  isFixedAtStart,
  readScopeBindingIds,
  sessionScopeIsReadable,
  sessionScopeRows,
} from '../../src/lib/session-scope';

const rows = (over: Partial<Parameters<typeof sessionScopeRows>[0]> = {}) =>
  sessionScopeRows({
    agentName: null,
    secretsAllowlist: null,
    boundConnections: {},
    ...over,
  });

const row = (key: string, over: Parameters<typeof rows>[0] = {}) =>
  rows(over).find((r) => r.key === key)!;

describe('sessionScopeRows', () => {
  test('a real allowlist is shown, not a description of what an allowlist is', () => {
    expect(
      row('secrets', { secretsAllowlist: ['STRIPE_KEY', 'GMAIL_TOKEN'] }).value,
    ).toBe('STRIPE_KEY, GMAIL_TOKEN');
  });

  test('no allowlist reads as "everything the agent is granted", never as empty', () => {
    // null (never narrowed) and [] (narrowed to nothing) are opposite states;
    // rendering both as an empty list would claim a session can read nothing.
    expect(
      row('secrets', { secretsAllowlist: null, agentName: 'support' }).value,
    ).toBe('Everything support is granted');
    expect(row('secrets', { secretsAllowlist: [] }).value).toBe(
      'No project secrets',
    );
  });

  test('the allowlist reason is specific to whether THIS session has one', () => {
    // Both cases must say where to change it, and the narrowed one must state
    // the limit that survives: removing a secret stops DELIVERY, it cannot
    // un-read what the agent already holds.
    expect(row('secrets', { secretsAllowlist: null }).detail).toContain(
      'full secret grant',
    );
    expect(row('secrets', { secretsAllowlist: ['A'] }).detail).toContain(
      'cannot un-read',
    );
  });

  test("the agent row names this session's agent, in both directions", () => {
    const scoped = row('agent', { agentName: 'support' });
    expect(scoped.value).toBe('support');
    expect(scoped.detail).toContain('re-scopes future secret delivery');
    expect(scoped.detail).toContain('connector access');
    expect(scoped.detail).toContain('Kortix CLI access');
    expect(scoped.detail).toContain('support');
    expect(row('agent').value).toBe('The project default agent');
  });

  test('the model row carries the control instead of a duplicated value', () => {
    const model = row('model');
    expect(model.control).toBe('model');
    expect(model.value).toBeNull();
    // "applied_live: false" is a real outcome, so the row must not promise the
    // change always takes effect immediately.
    expect(model.detail).toContain('next time this session starts');
  });

  test('bound connections are listed by alias', () => {
    expect(
      row('connections', {
        boundConnections: { slack: 'Support', gmail: 'Team inbox' },
      }).value,
    ).toBe('slack: Support, gmail: Team inbox');
  });

  test('nothing bound reads as the project default, not as "no connectors"', () => {
    expect(row('connections').value).toBe(
      'The project default for every connector',
    );
    expect(row('connections').detail).toContain('project connection');
    expect(row('connections').detail.toLowerCase()).not.toContain(
      'team authorization',
    );
  });

  test('a bound session is told unbound connectors still fall back to the default', () => {
    expect(
      row('connections', { boundConnections: { slack: 'Support' } }).detail,
    ).toContain('retroactive');
  });

  test('no scope-bar row is frozen any more — the badges match the contract', () => {
    // `PUT .../scope` made secrets and connections changeable; `runtime_context`
    // is the one field still fixed at create, which is what keeps that state a
    // real branch rather than dead code.
    for (const key of ['model', 'secrets', 'connections', 'agent'] as const) {
      expect(isFixedAtStart(key)).toBe(false);
    }
    expect(isFixedAtStart('runtime_context')).toBe(true);
  });
});

describe('authoritative session scope', () => {
  const current = {
    secrets_allowlist: ['PRIMARY_TOKEN'],
    required_connectors: null,
    connector_bindings: { gmail: { connection_id: 'auth-primary' } },
    dropped_secrets: [],
    added_secrets: [],
    dropped_bindings: [],
    retroactive: true,
    detail: 'Current scope.',
  };

  test('reads connection identifiers from the scope response', () => {
    expect(readScopeBindingIds(current.connector_bindings)).toEqual({
      gmail: 'auth-primary',
    });
  });

  test('a secret change preserves and sends the complete connector map', () => {
    expect(
      buildCompleteSessionScopeReplacement(current, {
        secrets: [],
      }),
    ).toEqual({
      secrets: [],
      connector_bindings: { gmail: { connection_id: 'auth-primary' } },
    });
  });

  test('a connector change preserves and sends the complete secret allowlist', () => {
    expect(
      buildCompleteSessionScopeReplacement(current, {
        bindings: { slack: 'auth-slack' },
      }),
    ).toEqual({
      secrets: ['PRIMARY_TOKEN'],
      connector_bindings: { slack: { connection_id: 'auth-slack' } },
    });
  });

  test('empty bindings replace every existing connector binding', () => {
    expect(
      buildCompleteSessionScopeReplacement(current, {
        bindings: {},
      }).connector_bindings,
    ).toEqual({});
  });
});

describe('a redacted session must not read as permissive (F1)', () => {
  test('can_access:false is treated as unreadable, not as "not narrowed"', () => {
    // The serializer blanks an inaccessible session to `metadata: {}` and
    // `secrets_allowlist: null` and still returns HTTP 200. `null` is exactly
    // what this panel reads as "everything the agent grant allows", so without
    // the can_access check a session the caller may NOT open renders as LESS
    // restricted than one they may — a false reassurance about a security fact.
    expect(sessionScopeIsReadable({ can_access: false })).toBe(false);
    // ...while an accessible session, or one whose shape omits the field, renders.
    expect(sessionScopeIsReadable({ can_access: true })).toBe(true);
    expect(sessionScopeIsReadable({})).toBe(true);
    expect(sessionScopeIsReadable(null)).toBe(false);
    expect(sessionScopeIsReadable(undefined)).toBe(false);
  });

  test('a null allowlist on an ACCESSIBLE session still means "everything granted"', () => {
    // Guard the other direction: the fix must not make a legitimately
    // un-narrowed session look restricted.
    const rows = sessionScopeRows({
      agentName: 'kortix',
      secretsAllowlist: null,
      boundConnections: {},
    });
    const secrets = rows.find((r) => r.key === 'secrets');
    expect(secrets?.detail ?? '').not.toContain('0 secret');
  });
});
