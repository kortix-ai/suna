import { describe, expect, test } from 'bun:test';
import { BOUND_CONNECTIONS_KEY, buildSessionCreateInput } from '../../src/lib/session-overrides';
import {
  isFixedAtStart,
  readBoundConnections,
  sessionScopeIsReadable,
  sessionScopeRows,
} from '../../src/lib/session-scope';

const rows = (over: Partial<Parameters<typeof sessionScopeRows>[0]> = {}) =>
  sessionScopeRows({ agentName: null, secretsAllowlist: null, boundConnections: {}, ...over });

const row = (key: string, over: Parameters<typeof rows>[0] = {}) =>
  rows(over).find((r) => r.key === key)!;

describe('sessionScopeRows', () => {
  test("a real allowlist is shown, not a description of what an allowlist is", () => {
    expect(row('secrets', { secretsAllowlist: ['STRIPE_KEY', 'GMAIL_TOKEN'] }).value).toBe(
      'STRIPE_KEY, GMAIL_TOKEN',
    );
  });

  test('no allowlist reads as "everything the agent is granted", never as empty', () => {
    // null (never narrowed) and [] (narrowed to nothing) are opposite states;
    // rendering both as an empty list would claim a session can read nothing.
    expect(row('secrets', { secretsAllowlist: null, agentName: 'support' }).value).toBe(
      'Everything support is granted',
    );
    expect(row('secrets', { secretsAllowlist: [] }).value).toBe('No project secrets');
  });

  test('the allowlist reason is specific to whether THIS session has one', () => {
    expect(row('secrets', { secretsAllowlist: null }).detail).toContain('without a narrower');
    expect(row('secrets', { secretsAllowlist: ['A'] }).detail).toContain('cannot be widened');
  });

  test("the agent row names this session's agent, in both directions", () => {
    const scoped = row('agent', { agentName: 'support' });
    expect(scoped.value).toBe('support');
    // The refusal is about SECRET access specifically — connector and CLI
    // grants may differ freely — so the row has to say which.
    expect(scoped.detail).toContain('SECRET access');
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
    expect(row('connections', { boundConnections: { slack: 'Support', gmail: 'Team inbox' } }).value).toBe(
      'slack: Support, gmail: Team inbox',
    );
  });

  test('nothing bound reads as the project default, not as "no connectors"', () => {
    expect(row('connections').value).toBe('The project default for every connector');
  });

  test('a bound session is told unbound connectors still fall back to the default', () => {
    expect(row('connections', { boundConnections: { slack: 'Support' } }).detail).toContain(
      'still use the project default',
    );
  });

  test('only the model is changeable now — the badges match the contract', () => {
    expect(isFixedAtStart('model')).toBe(false);
    expect(isFixedAtStart('secrets')).toBe(true);
    expect(isFixedAtStart('connections')).toBe(true);
    // Per-message, so not frozen — but it has no control on this panel.
    expect(isFixedAtStart('agent')).toBe(false);
    expect(rows().filter((r) => r.control !== null).map((r) => r.key)).toEqual(['model']);
  });
});

describe('readBoundConnections', () => {
  test('round-trips what the create wrote — the panel reads its own record', () => {
    // The platform never serializes a session's bindings back, so the create
    // body and the scope panel have to agree on one metadata key or the
    // Connections row silently reads empty forever.
    const created = buildSessionCreateInput(
      { agent: null, secrets: null, bindings: { slack: 'prof_9' } },
      { sessionId: 's', connectionLabels: { slack: 'Support' } },
    );
    expect(readBoundConnections(created.metadata)).toEqual({ slack: 'Support' });
  });

  test('a session created before this existed reads as unbound, not as broken', () => {
    expect(readBoundConnections({})).toEqual({});
    expect(readBoundConnections(null)).toEqual({});
    expect(readBoundConnections({ name: 'Some session' })).toEqual({});
  });

  test('junk in metadata is ignored rather than rendered', () => {
    expect(readBoundConnections({ [BOUND_CONNECTIONS_KEY]: 'nope' })).toEqual({});
    expect(readBoundConnections({ [BOUND_CONNECTIONS_KEY]: { slack: 7, gmail: 'Team' } })).toEqual({
      gmail: 'Team',
    });
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
    const rows = sessionScopeRows({ agentName: 'kortix', secretsAllowlist: null, boundConnections: {} });
    const secrets = rows.find((r) => r.key === 'secrets');
    expect(secrets?.detail ?? '').not.toContain('0 secret');
  });
});
