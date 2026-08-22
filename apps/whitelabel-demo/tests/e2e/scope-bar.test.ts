import type { ProjectSecret } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  MISSING_SECRET_NOTE,
  NEW_IDENTIFIER_HINT,
  SECRET_MEMBERSHIP_LABEL,
  START_NEW_SESSION_ACTION,
  classifyTypedIdentifier,
  scopeBarConnectors,
  scopeBarSecrets,
  hasScopeDraft,
  scopeControl,
  scopeDraftIssues,
} from '../../src/components/chat/scope-bar-model';
import { buildSessionCreateInput } from '../../src/lib/session-overrides';
import { selectConnectorBindingChoices } from '../../src/server/bindable-connections';

const secret = (
  identifier: string,
  name: string,
  over: Record<string, unknown> = {},
) =>
  ({
    identifier,
    name,
    project_id: 'P1',
    secret_id: `s-${identifier}`,
    created_by: null,
    created_at: null,
    updated_at: null,
    configured: true,
    mine: null,
    effective_source: 'shared',
    can_manage_shared: true,
    ...over,
  }) as ProjectSecret;

const connection = (over: Record<string, unknown> = {}) =>
  ({
    connection_id: 'p1',
    connector_alias: 'gmail',
    owner_type: 'project',
    owner_id: null,
    label: 'Support',
    status: 'active',
    is_default: false,
    metadata: {},
    ...over,
  }) as never;

// ── The whole point of the bar: which control may touch THIS session ─────────

describe('scopeControl', () => {
  test('secrets and connections ARE live-editable now', () => {
    // They were frozen until `PUT .../scope` existed. The bar must offer the
    // control, because refusing to would now be the UI lying about the platform.
    expect(scopeControl('secrets').live).toBe(true);
    expect(scopeControl('connections').live).toBe(true);
  });

  test('the model and the per-message agent are the two that can move now', () => {
    expect(scopeControl('model').live).toBe(true);
    expect(scopeControl('agent').live).toBe(true);
  });

  test('a changeable row says so, and the badge cannot drift from the rule', () => {
    // The badge is derived from MID_SESSION_CAPABILITIES, so it moves with the
    // contract rather than being restated by hand.
    expect(scopeControl('secrets').badge).toBe('Changeable');
    expect(scopeControl('connections').badge).toBe('Changeable');
  });

  test('the model note does not promise the change takes effect immediately', () => {
    // `applied_live: false` is a real response. A user told "now running X"
    // whose next answer comes from the old model has been lied to.
    expect(scopeControl('model').note).toContain(
      'next time this session starts',
    );
  });

  test('the secrets note states the one thing a re-scope cannot do', () => {
    // Dropping a secret stops DELIVERY; it cannot un-read what the agent has.
    // Saying "revoked" here would be false assurance.
    expect(scopeControl('secrets').note).toContain('cannot un-read');
    // Bindings resolve at call time, so that change IS complete — and the copy
    // must not blur the two.
    expect(scopeControl('connections').note).toContain('retroactive');
  });

  test('the model is live too — every scope-bar row now moves', () => {
    expect(scopeControl('model').live).toBe(true);
  });

  test('the optional fallback starts a separate session', () => {
    expect(START_NEW_SESSION_ACTION.toLowerCase()).toContain('new session');
  });
});

// ── Secrets: in, out, and the ones that are neither ──────────────────────────

describe('scopeBarSecrets', () => {
  const items = [
    secret('STRIPE', 'STRIPE_API_KEY'),
    secret('GMAIL', 'GMAIL_TOKEN'),
    secret('SENTRY', 'SENTRY_DSN'),
  ];

  test('an allowlist splits the project list into allowed and excluded', () => {
    const scope = scopeBarSecrets({ secrets: items, allowlist: ['STRIPE'] });
    expect(scope.rows.map((row) => [row.identifier, row.membership])).toEqual([
      ['STRIPE', 'allowed'],
      ['GMAIL', 'excluded'],
      ['SENTRY', 'excluded'],
    ]);
    expect(scope.summary).toBe('1 allowed');
  });

  test('every row carries the identifier AND the env KEY, because they differ', () => {
    // The allowlist addresses the IDENTIFIER; the sandbox sees the KEY. Showing
    // only one of them makes the allowlist unreadable against the sandbox.
    const scope = scopeBarSecrets({ secrets: items, allowlist: ['STRIPE'] });
    expect(scope.rows[0]).toMatchObject({
      identifier: 'STRIPE',
      name: 'STRIPE_API_KEY',
    });
  });

  test('no allowlist is "agent grant", never "allowed" and never empty', () => {
    // null (never narrowed) and [] (narrowed to nothing) are opposite states.
    // And a session that never narrowed reads whatever its AGENT is granted —
    // a set this app cannot enumerate, so claiming "allowed" here would be a
    // statement about secret access that nothing verified.
    const wide = scopeBarSecrets({ secrets: items, allowlist: null });
    expect(wide.narrowed).toBe(false);
    expect(wide.rows.every((row) => row.membership === 'agent_grant')).toBe(
      true,
    );
    expect(wide.summary).toBe('Agent grant');
    expect(wide.detail).toContain('can be fewer');
  });

  test('an empty allowlist reads as a choice, not as an empty state', () => {
    const none = scopeBarSecrets({ secrets: items, allowlist: [] });
    expect(none.narrowed).toBe(true);
    expect(none.summary).toBe('None');
    expect(none.rows.every((row) => row.membership === 'excluded')).toBe(true);
  });

  test('a channel-install row is not offered as "excluded" — nobody could allow it', () => {
    // Create resolves the allowlist against runtime-scoped rows only, so a
    // Slack install row was never a decision anyone made.
    const scope = scopeBarSecrets({
      secrets: [...items, secret('SLACK_BOT_TOKEN', 'SLACK_BOT_TOKEN')],
      allowlist: ['STRIPE'],
    });
    expect(scope.rows.map((row) => row.identifier)).not.toContain(
      'SLACK_BOT_TOKEN',
    );
  });

  test('an allowlisted identifier that no longer exists is named, not silently dropped', () => {
    // The allowlist is frozen; the project's secrets are not. A session can
    // outlive a secret it names, and showing "3 allowed" over a list of two is
    // how that becomes invisible.
    const scope = scopeBarSecrets({
      secrets: items,
      allowlist: ['STRIPE', 'DELETED'],
    });
    expect(scope.missing).toEqual(['DELETED']);
    expect(MISSING_SECRET_NOTE).toContain('not a project secret now');
  });

  test('membership labels never call an un-narrowed session "allowed"', () => {
    expect(SECRET_MEMBERSHIP_LABEL.agent_grant).not.toBe(
      SECRET_MEMBERSHIP_LABEL.allowed,
    );
  });

  test('a project with no secrets is an empty list, not a crash', () => {
    expect(
      scopeBarSecrets({ secrets: undefined, allowlist: undefined }).rows,
    ).toEqual([]);
  });
});

// ── The draft: a session cannot mint a secret ───────────────────────────────

describe('the identifier field says what a session cannot do', () => {
  const items = [secret('STRIPE', 'STRIPE_API_KEY')];

  test('a typed identifier that does not exist yet is recognised as new', () => {
    expect(
      classifyTypedIdentifier('NEW_ONE', { secrets: items, draft: [] }),
    ).toEqual({
      kind: 'unknown',
      identifier: 'NEW_ONE',
    });
    expect(
      classifyTypedIdentifier('  STRIPE  ', { secrets: items, draft: [] }),
    ).toEqual({
      kind: 'existing',
      identifier: 'STRIPE',
    });
    expect(
      classifyTypedIdentifier('STRIPE', { secrets: items, draft: ['STRIPE'] }),
    ).toEqual({
      kind: 'already_listed',
      identifier: 'STRIPE',
    });
    expect(
      classifyTypedIdentifier('   ', { secrets: items, draft: [] }),
    ).toEqual({ kind: 'empty' });
  });

  test('the hint requires creating a secret before applying scope', () => {
    expect(NEW_IDENTIFIER_HINT).toContain('Settings → Secrets');
    expect(NEW_IDENTIFIER_HINT).toContain('cannot create');
    expect(NEW_IDENTIFIER_HINT).toContain('refused');
  });
});

describe('scopeDraftIssues', () => {
  test('an identifier with no secret behind it is refused before the scope request', () => {
    const issues = scopeDraftIssues(
      ['MISSING'],
      [secret('STRIPE', 'STRIPE_API_KEY')],
    );
    expect(issues.map((issue) => issue.kind)).toEqual(['not_created']);
    expect(issues[0]!.message).toContain('Settings → Secrets');
  });

  test('two drafted identifiers sharing one env KEY are caught', () => {
    const items = [
      secret('GMAPS-primary', 'GOOGLE_MAPS_API_KEY'),
      secret('GMAPS-backup', 'GOOGLE_MAPS_API_KEY'),
    ];
    const issues = scopeDraftIssues(['GMAPS-primary', 'GMAPS-backup'], items);
    expect(issues.map((issue) => issue.kind)).toEqual([
      'key_collision',
      'key_collision',
    ]);
    expect(issues[0]!.conflicts).toEqual(['GMAPS-backup']);
    expect(issues[0]!.message).toContain('GOOGLE_MAPS_API_KEY');
  });

  test('picking only ONE of two identifiers on a shared KEY is fine', () => {
    const items = [
      secret('GMAPS-primary', 'GOOGLE_MAPS_API_KEY'),
      secret('GMAPS-backup', 'GOOGLE_MAPS_API_KEY'),
    ];
    expect(scopeDraftIssues(['GMAPS-primary'], items)).toEqual([]);
  });

  test('an ordinary draft has nothing to say', () => {
    expect(
      scopeDraftIssues(['STRIPE'], [secret('STRIPE', 'STRIPE_API_KEY')]),
    ).toEqual([]);
    expect(scopeDraftIssues([], [])).toEqual([]);
  });
});

// ── Connections ─────────────────────────────────────────────────────────────

describe('scopeBarConnectors', () => {
  test('an alias with nothing bindable carries the reason and a teammate-shaped remedy', () => {
    const choices = selectConnectorBindingChoices([
      connection({ owner_type: 'member', owner_id: 'u1' }),
    ]);
    const [row] = scopeBarConnectors({ choices, boundConnections: {} }).rows;
    expect(row!.unavailable).toBe('private_only');
    expect(row!.notice!.detail).toContain('teammate');
    // A wrapper has no personal upstream identity, so "connect it yourself"
    // could only ever lead to 403 REQUIRE_CONNECTORS_INTERACTIVE_ONLY.
    expect(row!.notice!.selfServiceAction).toBeNull();
  });

  test('a revoked project connection asks for a reconnect, not a first-time share', () => {
    const choices = selectConnectorBindingChoices([
      connection({ status: 'revoked' }),
    ]);
    expect(
      scopeBarConnectors({ choices, boundConnections: {} }).rows[0]!.notice!
        .detail,
    ).toContain('reconnect');
  });

  test('a bindable alias gets no notice — the picker speaks for itself', () => {
    const choices = selectConnectorBindingChoices([connection()]);
    const [row] = scopeBarConnectors({ choices, boundConnections: {} }).rows;
    expect(row!.notice).toBeNull();
    expect(row!.choices.map((connection) => connection.label)).toEqual([
      'Support',
    ]);
  });

  test("this session's binding is shown per alias, with the unbound ones on the default", () => {
    const choices = selectConnectorBindingChoices([
      connection(),
      connection({
        connector_alias: 'slack',
        connection_id: 'p2',
        label: 'Team slack',
      }),
    ]);
    const { rows, summary } = scopeBarConnectors({
      choices,
      boundConnections: { gmail: 'p1' },
    });
    expect(rows.map((row) => [row.alias, row.bound])).toEqual([
      ['gmail', 'Support'],
      ['slack', null],
    ]);
    expect(summary).toBe('1 bound');
  });

  test('an alias bound to a connection that has since vanished still gets a row', () => {
    // Dropping it would claim the session runs on the project default, which is
    // exactly what it does not do — the binding is frozen into the sandbox.
    const { rows } = scopeBarConnectors({
      choices: [],
      boundConnections: { gmail: 'auth-removed' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bound).toBe('auth-removed');
    // ...and no cause is invented for it: nothing reported a reason.
    expect(rows[0]!.unavailable).toBeNull();
    expect(rows[0]!.notice).toBeNull();
  });

  test('nothing bound reads as project defaults, and no connectors reads as none', () => {
    const choices = selectConnectorBindingChoices([connection()]);
    expect(
      scopeBarConnectors({ choices, boundConnections: {} }).summary,
    ).toBe('Project defaults');
    expect(
      scopeBarConnectors({ choices: undefined, boundConnections: {} })
        .summary,
    ).toBe('None');
  });
});

// ── What the draft actually sends ───────────────────────────────────────────

describe('the draft carried into the next session', () => {
  test('an untouched draft reproduces this session, allowlist and all', () => {
    const body = buildSessionCreateInput(
      {
        agent: 'support',
        secrets: ['STRIPE'],
        bindings: { gmail: 'p1' },
        runtimeContext: null,
      },
      { sessionId: 'next' },
    );
    expect(body).toMatchObject({
      agent_name: 'support',
      secrets: ['STRIPE'],
      connector_bindings: { gmail: { connection_id: 'p1' } },
      // Binding one alias must not unplug every other connector.
      inherit_unbound: true,
    });
  });

  test('an un-narrowed session stays un-narrowed — no guessed empty allowlist', () => {
    // `secrets: []` would boot the next session with NO project secrets, which
    // is the opposite of what "same scope as this one" means here.
    const body = buildSessionCreateInput(
      { agent: null, secrets: null, bindings: {}, runtimeContext: null },
      { sessionId: 'next' },
    );
    expect(body).not.toHaveProperty('secrets');
    expect(body).not.toHaveProperty('agent_name');
    expect(body).not.toHaveProperty('connector_bindings');
  });
});

describe('hasScopeDraft — when the Apply button may appear', () => {
  test('untouched means nothing to apply', () => {
    // The bug: the first version tested `draft !== null`, and the untouched
    // value is `undefined`. `undefined !== null` is true, so Apply rendered from
    // first paint — above a list the user had no way to edit yet.
    expect(hasScopeDraft(undefined)).toBe(false);
  });

  test('an explicit null IS a change — "stop narrowing"', () => {
    // Opposite of untouched: it hands the session the agent's full grant.
    expect(hasScopeDraft(null)).toBe(true);
  });

  test('an EMPTY list is a change — "no project secrets at all"', () => {
    expect(hasScopeDraft([])).toBe(true);
  });

  test('a populated list is a change', () => {
    expect(hasScopeDraft(['TEST_KEY_2'])).toBe(true);
  });

  test('an empty bindings map is a change — it unbinds everything', () => {
    expect(hasScopeDraft({})).toBe(true);
  });
});
