import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { rescopeSessionBindings, rescopeSessionSecrets,
  type RescopeSecretsResult } from './session-rescope';

describe('rescopeSessionSecrets — SET semantics', () => {
  test('the requested list REPLACES the previous one', () => {
    // The founder's case: start with [a, b], re-scope to [b], and from the next
    // prompt the session sees only b.
    const result = rescopeSessionSecrets({
      current: ['TEST_KEY_1', 'TEST_KEY_2'],
      requested: ['TEST_KEY_2'],
      agentGrantEnv: 'all',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allowlist).toEqual(['TEST_KEY_2']);
      expect(result.dropped).toEqual(['TEST_KEY_1']);
    }
  });

  test('it is a REPLACE, not an append — omitting a name drops it', () => {
    const result = rescopeSessionSecrets({ current: ['a', 'b'], requested: ['c'], agentGrantEnv: 'all' });
    expect(result.ok && result.allowlist).toEqual(['c']);
    expect(result.ok && result.dropped).toEqual(['a', 'b']);
  });

  test('an EMPTY list is "no project secrets", not "stop narrowing"', () => {
    // The two are opposite, and conflating them would silently hand a session
    // every secret the agent may read at the moment someone tried to remove all.
    const result = rescopeSessionSecrets({ current: ['a'], requested: [], agentGrantEnv: 'all' });
    expect(result.ok && result.allowlist).toEqual([]);
  });

  test('null means stop narrowing — fall back to the agent grant', () => {
    const result = rescopeSessionSecrets({ current: ['a'], requested: null, agentGrantEnv: 'all' });
    expect(result.ok && result.allowlist).toBeNull();
  });

  test('a session may RESTORE a secret it previously dropped, inside the grant', () => {
    // Narrowing is not a ratchet: the grant is the ceiling, not the current
    // allowlist. Refusing this would make one accidental re-scope permanent.
    const result = rescopeSessionSecrets({
      current: ['b'],
      requested: ['a', 'b'],
      agentGrantEnv: ['a', 'b', 'c'],
    });
    expect(result.ok && result.allowlist).toEqual(['a', 'b']);
    expect(result.ok && result.added).toEqual(['a']);
  });

  test('it can NEVER exceed the agent grant', () => {
    // The manifest's grant is what this agent may EVER read. A session-level
    // field that could widen past it would make the manifest advisory.
    const result = rescopeSessionSecrets({
      current: ['a'],
      requested: ['a', 'z'],
      agentGrantEnv: ['a', 'b'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_IN_AGENT_GRANT');
      expect(result.offending).toEqual(['z']);
    }
  });

  test('the grant ceiling is case-insensitive, matching agentMayUseEnv', () => {
    const result = rescopeSessionSecrets({
      current: null,
      requested: ['GMAIL_TOKEN'],
      agentGrantEnv: ['gmail_token'],
    });
    expect(result.ok).toBe(true);
  });

  test('duplicates and blanks are normalised away', () => {
    const result = rescopeSessionSecrets({
      current: null,
      requested: ['a', ' a ', '', '  ', 'A'],
      agentGrantEnv: 'all',
    });
    expect(result.ok && result.allowlist).toEqual(['a']);
  });

  test('an unrestricted grant imposes no ceiling', () => {
    expect(rescopeSessionSecrets({ current: null, requested: ['x'], agentGrantEnv: undefined }).ok).toBe(
      true,
    );
  });
});

describe('rescopeSessionBindings — SET semantics', () => {
  test('the requested map REPLACES the previous one', () => {
    const result = rescopeSessionBindings({
      current: { gmail: 'p1', slack: 'p2' },
      requested: { gmail: 'p9' },
      grantedConnectors: 'all',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindings).toEqual({ gmail: 'p9' });
      expect(result.dropped).toEqual(['slack']);
      expect(result.changed).toEqual(['gmail']);
    }
  });

  test('an alias the agent is not granted is refused', () => {
    // Binding it would "succeed" here and then 403 CONNECTOR_NOT_ASSIGNED at the
    // first tool call — a failure the user cannot act on, far from the cause.
    const result = rescopeSessionBindings({
      current: {},
      requested: { zendesk: 'p1' },
      grantedConnectors: ['gmail'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offending).toEqual(['zendesk']);
  });

  test('a public alias matches its canonical agent grant alias', () => {
    expect(
      rescopeSessionBindings({
        current: {},
        requested: {
          email: '11111111-1111-4111-a111-111111111111',
        },
        grantedConnectors: ['kortix_email'],
      }),
    ).toEqual({
      ok: true,
      bindings: {
        kortix_email: '11111111-1111-4111-a111-111111111111',
      },
      dropped: [],
      changed: [],
    });
  });

  test('an empty map unbinds everything', () => {
    const result = rescopeSessionBindings({
      current: { gmail: 'p1' },
      requested: {},
      grantedConnectors: 'all',
    });
    expect(result.ok && result.bindings).toEqual({});
    expect(result.ok && result.dropped).toEqual(['gmail']);
  });

  test('a blank alias or connection id is dropped rather than stored', () => {
    const result = rescopeSessionBindings({
      current: {},
      requested: { '': 'p1', gmail: '  ' },
      grantedConnectors: 'all',
    });
    expect(result.ok && result.bindings).toEqual({});
  });
});

describe('the docs match the contract', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
  const DOCS = [
    join(REPO, 'docs', 'KORTIX_AS_A_BACKEND_GUIDE.md'),
    join(REPO, 'apps', 'web', 'content', 'docs', 'backend.mdx'),
    join(REPO, 'docs', 'KAAB_TESTING_GUIDE.md'),
  ];

  test('no doc still calls secrets or connector_bindings create-only', () => {
    // These three said "create-only" for as long as the refusal existed. When the
    // route landed they became false, and a reader integrating against them would
    // build a whole new-session flow to work around a limit that is gone.
    // Docs are the product surface for a backend platform; pin them.
    for (const path of DOCS) {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const claimsFrozen = /create-only|set once at create|cannot be changed mid-session/i.test(
          line,
        );
        if (!claimsFrozen) continue;
        // `runtime_context` genuinely is create-only.
        const aboutMovableFields = /\bsecrets\b|connector_bindings/.test(line);
        const alsoNamesFrozenOnes = /runtime_context/.test(line);
        expect({ path, line: line.trim().slice(0, 100) }).toMatchObject({
          path,
          line: aboutMovableFields && !alsoNamesFrozenOnes ? '<<must not claim frozen>>' : line.trim().slice(0, 100),
        });
      }
    }
  });
});

/**
 * The FIRST narrowing of a session is the largest one there is, and it was the
 * one that reported nothing had been dropped.
 *
 * A session starts with `secretsAllowlist = null`, meaning "everything the
 * agent's grant allows". Narrowing it to an explicit list is a null → list
 * transition, and `dropped` was computed only when BOTH sides were explicit —
 * so it came back `[]`, the route set `retroactive: true`, and the user was told
 * "Applies from the next prompt." with no warning.
 *
 * That is exactly the false assurance this module's own header warns about: a
 * user revoking secrets from a live session to contain a leak was told nothing
 * was dropped, and would reasonably leave the credential in place.
 *
 * When the grant is enumerable the dropped names are knowable, so they are
 * reported. When it is `'all'` they are not — but the narrowing still happened,
 * which is what `narrowed` carries.
 */
describe('rescopeSessionSecrets — narrowing away from an unrestricted session', () => {
  const ok = (r: RescopeSecretsResult) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
    return r;
  };

  test('null → subset of an enumerable grant reports the dropped names', () => {
    const r = ok(
      rescopeSessionSecrets({
        current: null,
        requested: ['A'],
        agentGrantEnv: ['A', 'B', 'C'],
      }),
    );
    expect(r.narrowed).toBe(true);
    expect(r.dropped).toEqual(['B', 'C']);
  });

  test('null → [] drops the entire grant', () => {
    // "Inject zero project secrets" on a session that had all of them.
    const r = ok(
      rescopeSessionSecrets({ current: null, requested: [], agentGrantEnv: ['A', 'B'] }),
    );
    expect(r.narrowed).toBe(true);
    expect(r.dropped).toEqual(['A', 'B']);
  });

  test("null → subset of an 'all' grant is narrowed even though the names are unknowable", () => {
    const r = ok(
      rescopeSessionSecrets({ current: null, requested: ['A'], agentGrantEnv: 'all' }),
    );
    expect(r.narrowed).toBe(true);
    expect(r.dropped).toEqual([]);
  });

  test('null → the WHOLE grant is not a narrowing', () => {
    const r = ok(
      rescopeSessionSecrets({
        current: null,
        requested: ['A', 'B'],
        agentGrantEnv: ['A', 'B'],
      }),
    );
    expect(r.narrowed).toBe(false);
    expect(r.dropped).toEqual([]);
  });

  test('widening back to null is not a narrowing', () => {
    const r = ok(
      rescopeSessionSecrets({ current: ['A'], requested: null, agentGrantEnv: ['A', 'B'] }),
    );
    expect(r.narrowed).toBe(false);
    expect(r.dropped).toEqual([]);
  });

  test('an ordinary list → list narrowing still reports, and is narrowed', () => {
    const r = ok(
      rescopeSessionSecrets({
        current: ['A', 'B'],
        requested: ['A'],
        agentGrantEnv: ['A', 'B'],
      }),
    );
    expect(r.narrowed).toBe(true);
    expect(r.dropped).toEqual(['B']);
  });

  test('a pure widening within an explicit list is not narrowed', () => {
    const r = ok(
      rescopeSessionSecrets({
        current: ['A'],
        requested: ['A', 'B'],
        agentGrantEnv: ['A', 'B'],
      }),
    );
    expect(r.narrowed).toBe(false);
    expect(r.added).toEqual(['B']);
  });
});

/**
 * The route has to actually branch on `narrowed`.
 *
 * The helper can be perfectly correct and the user still be misinformed — the
 * warning is emitted by the route, and it was keyed on `droppedSecrets.length`.
 * That is the same shape of bug as a component wired to a value nobody
 * populates: right logic, wrong plumbing, confident wrong output.
 */
const ROUTE = readFileSync(
  join(import.meta.dir, '..', 'routes', 'r7.ts'),
  'utf8',
);

describe('the scope route surfaces the narrowing', () => {
  test('retroactive and the warning key off `narrowed`, not the dropped names', () => {
    expect(ROUTE).toContain('retroactive: !narrowedSecrets');
    expect(ROUTE).toContain('narrowedSecrets = decided.narrowed');
    expect(ROUTE).not.toContain('retroactive: droppedSecrets.length === 0');
  });

  test('the warning sentence still names rotation as the remedy', () => {
    // The one actionable thing. "Dropped" without "rotate them" is the false
    // assurance this module's header warns about.
    expect(ROUTE).toContain('rotate them if that matters');
  });
});

/**
 * Validation and DELIVERY must resolve secrets for the same principal.
 *
 * The per-prompt push keys on the session's `createdBy` — `resolveOwnerRawEnv`
 * does, and `sessions.ts` spells out why: "a per-user secret override resolves
 * per principal… if a manager restarted another member's session we'd inject the
 * MANAGER's personal secret".
 *
 * `PUT /scope` validated against the CALLER instead. So a project manager
 * re-scoping someone else's session could add an identifier that exists only as
 * the manager's own personal override: the API answered 200 with it listed in
 * `secrets_allowlist` and "Applies from the next prompt.", and the session never
 * received it — not on that prompt, not on any later one, with nothing anywhere
 * saying so.
 */
describe('the scope route validates for the session OWNER, not the caller', () => {
  test('availability is resolved against createdBy', () => {
    expect(ROUTE).toContain('const secretsPrincipal = visible.row.createdBy ?? loaded.userId');
    expect(ROUTE).toContain('listResolvedWorkspaceSecrets(workspaceId, secretsPrincipal)');
  });

  test('it no longer resolves availability against the caller', () => {
    // The exact call that made a manager's personal override look in-scope for
    // somebody else's session.
    expect(ROUTE).not.toContain('listResolvedWorkspaceSecrets(workspaceId, loaded.userId)');
  });
});
