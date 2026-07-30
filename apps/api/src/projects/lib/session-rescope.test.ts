import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { rescopeSessionBindings, rescopeSessionSecrets } from './session-rescope';

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

  test('a blank alias or profile id is dropped rather than stored', () => {
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
