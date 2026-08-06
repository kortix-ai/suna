import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';

import {
  DEFAULT_HANDLE_PREFIX,
  type DeliveredSecret,
  type SecretDelivery,
  type SecretDeliveryInput,
  type SecretWithheldReason,
  type SecretEgressPolicy,
  type SecretStrategy,
  deliversPlaintextToSandbox,
  emitsValue,
  isFullyWithheld,
  looksLikeHandle,
  matchRule,
  maxStrategy,
  mintHandle,
  newLookupId,
  parseEgressPolicy,
  parseHandle,
  resolveSecretDelivery,
  secretNamesForSandbox,
} from './strategy';

const ROOT = 'test-root-secret-do-not-use-in-production';

describe('maxStrategy — the strictness lattice', () => {
  test('no declarations at all means runtime (today’s behaviour)', () => {
    expect(maxStrategy()).toBe('runtime');
  });

  test('the STRICTEST declaration wins, whatever the order', () => {
    expect(maxStrategy('runtime', 'broker', 'egress')).toBe('broker');
    expect(maxStrategy('broker', 'runtime')).toBe('broker');
    expect(maxStrategy('denied', 'runtime')).toBe('denied');
  });

  test('ABSENT is not runtime — this is what makes the change back-compatible', () => {
    // A manifest lists secrets as bare strings today, expressing no delivery
    // opinion. If undefined counted as rank 0 it would silently drag a brokered
    // secret back to plaintext the moment any manifest mentioned it.
    expect(maxStrategy('broker', undefined, null)).toBe('broker');
  });

  test('garbage is ignored rather than treated as permissive', () => {
    expect(maxStrategy('broker', 'nonsense' as never)).toBe('broker');
  });

  test('the two derived predicates agree with the lattice', () => {
    expect(deliversPlaintextToSandbox('runtime')).toBe(true);
    for (const s of ['egress', 'broker', 'denied'] as const) {
      expect(deliversPlaintextToSandbox(s)).toBe(false);
    }
    expect(isFullyWithheld('denied')).toBe(true);
    expect(isFullyWithheld('broker')).toBe(false);
  });
});

describe('parseEgressPolicy', () => {
  const ok = (extra: Record<string, unknown> = {}) => ({
    rules: [{ host: 'api.anthropic.com' }],
    inject: { kind: 'header', name: 'x-api-key' },
    ...extra,
  });

  test('accepts a minimal well-formed policy', () => {
    const parsed = parseEgressPolicy(ok());
    expect(parsed.ok).toBe(true);
  });

  test('requires at least one rule — an empty policy would match nothing and confuse', () => {
    expect(parseEgressPolicy({ rules: [], inject: { kind: 'header', name: 'x' } }).ok).toBe(false);
  });

  test('REJECTS a regex host — a matcher a human cannot eyeball will eventually misfire', () => {
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: '.*\\.anthropic\\.com' }] }).ok).toBe(false);
  });

  test('rejects a multi-label or embedded wildcard', () => {
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: '*.*.com' }] }).ok).toBe(false);
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: 'api.*.com' }] }).ok).toBe(false);
  });

  test('accepts exactly one leading *. wildcard', () => {
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: '*.anthropic.com' }] }).ok).toBe(true);
  });

  test('rejects a bare TLD and an empty host', () => {
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: 'localhost' }] }).ok).toBe(false);
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: '' }] }).ok).toBe(false);
  });

  test('normalises host case so policy and request compare consistently', () => {
    const parsed = parseEgressPolicy({ ...ok(), rules: [{ host: 'API.Anthropic.COM' }] });
    expect(parsed.ok && parsed.policy.rules[0].host).toBe('api.anthropic.com');
  });

  test('rejects an unknown HTTP method rather than silently dropping it', () => {
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: 'a.com', methods: ['FETCH'] }] }).ok).toBe(
      false,
    );
  });

  test('allows only ONE trailing /* in a path', () => {
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: 'a.com', path: '/v1/*' }] }).ok).toBe(true);
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: 'a.com', path: '/*/msgs' }] }).ok).toBe(
      false,
    );
    expect(parseEgressPolicy({ ...ok(), rules: [{ host: 'a.com', path: 'v1' }] }).ok).toBe(false);
  });

  test('requires a known injection kind', () => {
    expect(parseEgressPolicy({ ...ok(), inject: { kind: 'cookie', name: 'x' } }).ok).toBe(false);
    expect(parseEgressPolicy({ ...ok(), inject: { kind: 'header' } }).ok).toBe(false);
  });

  test('validates templates, JSON paths, and per-rule injection overrides', () => {
    expect(
      parseEgressPolicy({ ...ok(), inject: { kind: 'header', name: 'x', template: 'Bearer token' } })
        .ok,
    ).toBe(false);
    expect(
      parseEgressPolicy({ ...ok(), inject: { kind: 'json_body_field', path: '__proto__.key' } }).ok,
    ).toBe(false);
    const parsed = parseEgressPolicy({
      ...ok(),
      rules: [
        {
          host: 'api.anthropic.com',
          inject: { kind: 'header', name: 'X-Api-Key', template: '{{secret}}' },
        },
      ],
    });
    expect(parsed.ok && parsed.policy.rules[0].inject).toEqual({
      kind: 'header',
      name: 'x-api-key',
      template: '{{secret}}',
    });
  });

  test('rejects observe mode because no-match delivery is fail-closed', () => {
    expect(parseEgressPolicy(ok({ on_no_match: 'observe' })).ok).toBe(false);
    expect(parseEgressPolicy(ok({ on_no_match: 'deny' })).ok).toBe(true);
  });

  test('rejects an unknown broker backend', () => {
    expect(parseEgressPolicy(ok({ backend: 'somewhere_else' })).ok).toBe(false);
    expect(parseEgressPolicy(ok({ backend: 'llm_gateway' })).ok).toBe(true);
  });
});

describe('matchRule', () => {
  const policy = (rules: SecretEgressPolicy['rules']): SecretEgressPolicy => ({
    rules,
    inject: { kind: 'header', name: 'x-api-key' },
  });

  test('an exact host matches only itself', () => {
    const p = policy([{ host: 'api.anthropic.com' }]);
    expect(matchRule(p, { host: 'api.anthropic.com', method: 'POST', path: '/v1/m' })).toBeTruthy();
    expect(matchRule(p, { host: 'anthropic.com', method: 'POST', path: '/v1/m' })).toBeNull();
  });

  test('THE ATTACK: a suffix-lookalike host must not match', () => {
    // `api.anthropic.com.attacker.tld` ends with neither the exact host nor
    // `.anthropic.com` in the right position — a naive endsWith() would send the
    // credential straight to the attacker.
    const exact = policy([{ host: 'api.anthropic.com' }]);
    const wild = policy([{ host: '*.anthropic.com' }]);
    const evil = { host: 'api.anthropic.com.attacker.tld', method: 'POST', path: '/' };
    expect(matchRule(exact, evil)).toBeNull();
    expect(matchRule(wild, evil)).toBeNull();
  });

  test('THE OTHER ATTACK: a wildcard must not match a prefix-glued label', () => {
    const wild = policy([{ host: '*.anthropic.com' }]);
    expect(matchRule(wild, { host: 'evil-anthropic.com', method: 'GET', path: '/' })).toBeNull();
  });

  test('a wildcard matches a subdomain but NOT the apex', () => {
    const wild = policy([{ host: '*.anthropic.com' }]);
    expect(matchRule(wild, { host: 'api.anthropic.com', method: 'GET', path: '/' })).toBeTruthy();
    expect(matchRule(wild, { host: 'anthropic.com', method: 'GET', path: '/' })).toBeNull();
  });

  test('host comparison is case-insensitive — DNS is', () => {
    const p = policy([{ host: 'api.anthropic.com' }]);
    expect(matchRule(p, { host: 'API.ANTHROPIC.COM', method: 'GET', path: '/' })).toBeTruthy();
  });

  test('an empty methods list means ANY method', () => {
    const p = policy([{ host: 'a.com', methods: [] }]);
    expect(matchRule(p, { host: 'a.com', method: 'DELETE', path: '/' })).toBeTruthy();
  });

  test('a methods list excludes everything not named', () => {
    const p = policy([{ host: 'a.com', methods: ['POST'] }]);
    expect(matchRule(p, { host: 'a.com', method: 'POST', path: '/' })).toBeTruthy();
    expect(matchRule(p, { host: 'a.com', method: 'GET', path: '/' })).toBeNull();
  });

  test('a path prefix matches the subtree and the bare prefix, not a sibling', () => {
    const p = policy([{ host: 'a.com', path: '/v1/*' }]);
    expect(matchRule(p, { host: 'a.com', method: 'GET', path: '/v1/messages' })).toBeTruthy();
    expect(matchRule(p, { host: 'a.com', method: 'GET', path: '/v1' })).toBeTruthy();
    expect(matchRule(p, { host: 'a.com', method: 'GET', path: '/v2/messages' })).toBeNull();
    // `/v1beta` must NOT match `/v1/*` — the separator is load-bearing.
    expect(matchRule(p, { host: 'a.com', method: 'GET', path: '/v1beta' })).toBeNull();
  });

  test('NO MATCH IS A DENY — the whole point', () => {
    expect(matchRule(policy([{ host: 'a.com' }]), { host: 'b.com', method: 'GET', path: '/' })).toBeNull();
  });

  test('first matching rule wins', () => {
    const p = policy([
      { host: 'a.com', methods: ['GET'] },
      { host: 'a.com', methods: ['POST'] },
    ]);
    expect(matchRule(p, { host: 'a.com', method: 'POST', path: '/' })?.methods).toEqual(['POST']);
  });
});

describe('handles', () => {
  const lookup = () => newLookupId(randomBytes(32));

  test('round-trips through mint → parse', () => {
    const id = lookup();
    const handle = mintHandle({ lookupId: id, rootSecret: ROOT });
    const parsed = parseHandle(handle, ROOT);
    expect(parsed.ok && parsed.lookupId).toBe(id);
  });

  test('stays within [A-Za-z0-9_-] so shell/JSON/header transit cannot mangle it', () => {
    const handle = mintHandle({ lookupId: lookup(), rootSecret: ROOT });
    expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('the default prefix is self-describing, so a stray 401 teaches the model', () => {
    const handle = mintHandle({ lookupId: lookup(), rootSecret: ROOT });
    expect(handle.startsWith(DEFAULT_HANDLE_PREFIX)).toBe(true);
  });

  test('a vendor-shaped prefix is preserved for SDKs that validate key format', () => {
    const handle = mintHandle({ lookupId: lookup(), prefix: 'sk-ant-api03-', rootSecret: ROOT });
    expect(handle.startsWith('sk-ant-api03-')).toBe(true);
    const parsed = parseHandle(handle, ROOT);
    expect(parsed.ok && parsed.prefix).toBe('sk-ant-api03-');
  });

  test('a FORGED tag is rejected, and is distinguishable from "not a handle"', () => {
    // The distinction matters operationally: bad_tag is somebody guessing,
    // not_a_handle is ordinary traffic.
    const handle = mintHandle({ lookupId: lookup(), rootSecret: ROOT });
    const tampered = `${handle.slice(0, -1)}${handle.endsWith('a') ? 'b' : 'a'}`;
    expect(parseHandle(tampered, ROOT)).toEqual({ ok: false, reason: 'bad_tag' });
    expect(parseHandle('sk-ant-totally-real', ROOT)).toEqual({ ok: false, reason: 'not_a_handle' });
  });

  test('a handle minted under a different root secret does not verify', () => {
    const handle = mintHandle({ lookupId: lookup(), rootSecret: ROOT });
    expect(parseHandle(handle, 'some-other-root').ok).toBe(false);
  });

  test('the tag is verified BEFORE any lookup id is returned', () => {
    // Guards the broker against being used as a query amplifier by an agent
    // spraying guessed handles.
    const parsed = parseHandle(`${DEFAULT_HANDLE_PREFIX}KXS1${'a'.repeat(36)}`, ROOT);
    expect(parsed.ok).toBe(false);
  });

  test('looksLikeHandle is a cheap pre-filter, never an authorization check', () => {
    expect(looksLikeHandle(mintHandle({ lookupId: lookup(), rootSecret: ROOT }))).toBe(true);
    expect(looksLikeHandle('ordinary-value')).toBe(false);
  });

  test('two mints of the same lookup id are stable — the box sees one value per session', () => {
    const id = lookup();
    expect(mintHandle({ lookupId: id, rootSecret: ROOT })).toBe(
      mintHandle({ lookupId: id, rootSecret: ROOT }),
    );
  });
});

// A session id and an explicit grant naming the row, so each test below varies
// exactly one axis away from "everything is permitted".
const PERMISSIVE = {
  identifier: 'ALPHA',
  agentGrantEnv: ['ALPHA'],
  sessionId: 'ses_1',
} satisfies SecretDeliveryInput;

const resolve = (over: Partial<SecretDeliveryInput> = {}): SecretDelivery =>
  resolveSecretDelivery({ ...PERMISSIVE, ...over });

/** The withheld reason, or null when something WAS emitted — so an assertion
 *  about a reason cannot accidentally pass on a row that emitted a value. */
const reasonOf = (delivery: SecretDelivery): SecretWithheldReason | null =>
  delivery.emit === 'nothing' ? delivery.reason : null;

describe('resolveSecretDelivery — composition of the declared strategies', () => {
  test('nothing declared anywhere delivers plaintext — today’s behaviour, unchanged', () => {
    expect(resolveSecretDelivery({ identifier: 'ALPHA' })).toEqual({
      emit: 'plaintext',
      strategy: 'runtime',
    });
  });

  test('the project default applies when the row declares nothing', () => {
    expect(resolve({ projectDefaultStrategy: 'broker' })).toEqual({
      emit: 'handle',
      strategy: 'broker',
    });
  });

  test('the manifest may STRENGTHEN the row', () => {
    expect(resolve({ strategy: 'egress', manifestStrategy: 'broker' })).toEqual({
      emit: 'handle',
      strategy: 'broker',
    });
  });

  test('no layer can WEAKEN another — max wins from whichever direction', () => {
    expect(resolve({ strategy: 'broker', manifestStrategy: 'runtime' }).strategy).toBe('broker');
    expect(resolve({ strategy: 'runtime', projectDefaultStrategy: 'denied' })).toEqual({
      emit: 'nothing',
      strategy: 'denied',
      reason: 'denied',
    });
  });

  test('ABSENT is not runtime: a manifest that merely MENTIONS the secret cannot downgrade it', () => {
    // The back-compat spine. A bare string in `[env].required` is today's only
    // manifest form and expresses no delivery opinion; if it counted as rank 0
    // every brokered secret would fall back to plaintext the day a repo listed it.
    expect(resolve({ strategy: 'broker', manifestStrategy: null }).emit).toBe('handle');
    expect(resolve({ strategy: 'broker', manifestStrategy: undefined }).emit).toBe('handle');
    expect(resolve({ strategy: 'broker', projectDefaultStrategy: null }).emit).toBe('handle');
  });
});

describe('resolveSecretDelivery — what each strategy emits', () => {
  test('runtime emits the plaintext value', () => {
    expect(resolve({ strategy: 'runtime' })).toEqual({ emit: 'plaintext', strategy: 'runtime' });
  });

  test('broker and egress emit a handle, never a value', () => {
    for (const strategy of ['broker', 'egress'] as const) {
      expect(resolve({ strategy })).toEqual({ emit: 'handle', strategy });
    }
  });

  test('denied emits NOTHING — and that is what keeps its name out of KORTIX_PROJECT_SECRET_NAMES', () => {
    const delivery = resolve({ strategy: 'denied' });
    expect(delivery).toEqual({ emit: 'nothing', strategy: 'denied', reason: 'denied' });
    expect(secretNamesForSandbox([{ key: 'ALPHA_KEY', delivery }])).toEqual([]);
  });

  test('denied is decided FIRST, so its reason survives every other objection', () => {
    // A denied row is a statement about the secret, not about the caller; it
    // stays true with no session and with no grant, and reporting "no_session"
    // there would send an operator chasing the wrong fix.
    expect(
      reasonOf(
        resolve({ strategy: 'denied', sessionId: null, agentGrantEnv: null, sessionAllowlist: [] }),
      ),
    ).toBe('denied');
  });
});

describe('resolveSecretDelivery — sessionId is required to mint a handle', () => {
  test('NO SESSION ⇒ every non-runtime row emits nothing (fail closed)', () => {
    for (const strategy of ['egress', 'broker'] as const) {
      expect(resolve({ strategy, sessionId: null })).toEqual({
        emit: 'nothing',
        strategy,
        reason: 'no_session',
      });
    }
  });

  test('an empty-string session id is no session — a falsy id must not mint', () => {
    expect(resolve({ strategy: 'broker', sessionId: '' }).emit).toBe('nothing');
  });

  test('a runtime row is unaffected by a missing session id', () => {
    // Every path that resolves secrets without a session keeps working exactly
    // as it does today; only the new classes fail closed.
    expect(resolve({ strategy: 'runtime', sessionId: null }).emit).toBe('plaintext');
    expect(resolve({ strategy: 'runtime', sessionId: undefined }).emit).toBe('plaintext');
  });

  test('the failure is closed, not downgraded — no session NEVER yields plaintext', () => {
    for (const strategy of ['egress', 'broker', 'denied'] as const) {
      expect(resolve({ strategy, sessionId: null }).emit).not.toBe('plaintext');
    }
  });
});

describe('resolveSecretDelivery — the agent grant', () => {
  test('an explicit list admits the identifiers it names, case-insensitively', () => {
    expect(resolve({ strategy: 'broker', agentGrantEnv: ['alpha'] }).emit).toBe('handle');
    expect(resolve({ identifier: 'alpha', strategy: 'broker', agentGrantEnv: ['ALPHA'] }).emit).toBe(
      'handle',
    );
  });

  test('an explicit list excludes everything it does not name, whatever the strategy', () => {
    for (const strategy of ['runtime', 'broker'] as const) {
      expect(resolve({ strategy, agentGrantEnv: ['BETA'] })).toEqual({
        emit: 'nothing',
        strategy,
        reason: 'agent_grant_excludes',
      });
    }
  });

  test('an explicit EMPTY grant admits nothing at all', () => {
    expect(reasonOf(resolve({ strategy: 'runtime', agentGrantEnv: [] }))).toBe(
      'agent_grant_excludes',
    );
  });

  test('A NULL GRANT still delivers a runtime row — the fail-open legacy paths depend on', () => {
    // `agentMayUseEnv` returns true for a null grant ("no grant = no
    // restriction"), and an ungoverned project produces exactly that.
    expect(resolve({ strategy: 'runtime', agentGrantEnv: null }).emit).toBe('plaintext');
    expect(resolve({ strategy: 'runtime', agentGrantEnv: undefined }).emit).toBe('plaintext');
  });

  test('A NULL GRANT DENIES a non-runtime row — the fail-open closes exactly where it is free', () => {
    for (const grant of [null, undefined]) {
      for (const strategy of ['egress', 'broker'] as const) {
        expect(resolve({ strategy, agentGrantEnv: grant })).toEqual({
          emit: 'nothing',
          strategy,
          reason: 'agent_grant_unscoped',
        });
      }
    }
  });

  test('so does an ALL grant — secret-grant.ts collapses `all` and absent to one authority', () => {
    // `'all'` is what an agent that simply OMITS `secrets:` produces, so treating
    // it as a deliberate declaration would reopen the same hole under a
    // different spelling. Only a named identifier list carries a brokered secret.
    expect(reasonOf(resolve({ strategy: 'broker', agentGrantEnv: 'all' }))).toBe(
      'agent_grant_unscoped',
    );
    expect(resolve({ strategy: 'runtime', agentGrantEnv: 'all' }).emit).toBe('plaintext');
  });
});

describe('resolveSecretDelivery — the per-session allowlist', () => {
  test('ABSENT (null/undefined) narrows nothing — byte-identical to the pre-KaaB path', () => {
    expect(resolve({ strategy: 'runtime', sessionAllowlist: null }).emit).toBe('plaintext');
    expect(resolve({ strategy: 'runtime', sessionAllowlist: undefined }).emit).toBe('plaintext');
    expect(resolve({ strategy: 'broker', sessionAllowlist: null }).emit).toBe('handle');
  });

  test('EXPLICIT EMPTY is a declaration, not absence: zero secrets reach the session', () => {
    // The distinction `canonicalizeSecretsAllowlist` already preserves for
    // idempotency comparison has to hold here too, or `secrets: []` on a
    // session-create silently means "everything".
    expect(resolve({ strategy: 'runtime', sessionAllowlist: [] })).toEqual({
      emit: 'nothing',
      strategy: 'runtime',
      reason: 'session_allowlist_excludes',
    });
    expect(resolve({ strategy: 'runtime', sessionAllowlist: null }).emit).toBe('plaintext');
  });

  test('an explicit list admits only what it names, case-insensitively', () => {
    expect(resolve({ strategy: 'runtime', sessionAllowlist: ['alpha'] }).emit).toBe('plaintext');
    expect(reasonOf(resolve({ strategy: 'runtime', sessionAllowlist: ['BETA'] }))).toBe(
      'session_allowlist_excludes',
    );
  });

  test('the allowlist cannot RESCUE a row the agent grant left unscoped', () => {
    // Treating a null grant as `[]` means the intersection is empty however
    // generous the session list is — the wrapper backend cannot hand its agent a
    // brokered credential the agent was never declared to hold.
    expect(
      reasonOf(resolve({ strategy: 'broker', agentGrantEnv: null, sessionAllowlist: ['ALPHA'] })),
    ).toBe('agent_grant_unscoped');
  });

  test('the two axes compose as an intersection', () => {
    expect(
      resolve({ strategy: 'broker', agentGrantEnv: ['ALPHA', 'BETA'], sessionAllowlist: ['ALPHA'] })
        .emit,
    ).toBe('handle');
    expect(
      resolve({ strategy: 'broker', agentGrantEnv: ['ALPHA'], sessionAllowlist: ['BETA'] }).emit,
    ).toBe('nothing');
  });
});

describe('secretNamesForSandbox — the name/value invariant', () => {
  const named = (key: string, delivery: SecretDelivery): DeliveredSecret => ({ key, delivery });

  test('a plaintext row and a handle row both contribute their name', () => {
    expect(
      secretNamesForSandbox([
        named('STRIPE_KEY', { emit: 'handle', strategy: 'broker' }),
        named('OPENAI_KEY', { emit: 'plaintext', strategy: 'runtime' }),
      ]),
    ).toEqual(['OPENAI_KEY', 'STRIPE_KEY']);
  });

  test('a withheld row contributes nothing, for every reason', () => {
    const reasons = [
      'denied',
      'agent_grant_excludes',
      'agent_grant_unscoped',
      'session_allowlist_excludes',
      'no_session',
    ] as const;
    for (const reason of reasons) {
      expect(
        secretNamesForSandbox([named('K', { emit: 'nothing', strategy: 'denied', reason })]),
      ).toEqual([]);
    }
  });

  test('names are deduped and sorted, matching sanitizeSandboxEnv’s Object.keys().sort()', () => {
    expect(
      secretNamesForSandbox([
        named('B_KEY', { emit: 'plaintext', strategy: 'runtime' }),
        named('A_KEY', { emit: 'handle', strategy: 'egress' }),
        named('B_KEY', { emit: 'plaintext', strategy: 'runtime' }),
      ]),
    ).toEqual(['A_KEY', 'B_KEY']);
  });

  test('an empty input yields an empty list, not [""]', () => {
    expect(secretNamesForSandbox([])).toEqual([]);
  });

  test('TWO IDENTIFIERS, ONE KEY: the name appears if EITHER of them emits', () => {
    // `project_secrets.name` is deliberately non-unique — GMAPS_PRIMARY and
    // GMAPS_BACKUP may both be GOOGLE_MAPS_API_KEY. `resolveGrantedSecretEnv`
    // picks one winner for the env map, so the key is present as long as any
    // contributing row emits, in either order.
    const emitted = { emit: 'plaintext', strategy: 'runtime' } as const;
    const withheld = { emit: 'nothing', strategy: 'denied', reason: 'denied' } as const;
    const KEY = 'GOOGLE_MAPS_API_KEY';
    expect(secretNamesForSandbox([named(KEY, emitted), named(KEY, withheld)])).toEqual([KEY]);
    expect(secretNamesForSandbox([named(KEY, withheld), named(KEY, emitted)])).toEqual([KEY]);
  });

  test('TWO IDENTIFIERS, ONE KEY: the name disappears only when EVERY one is withheld', () => {
    const withheld = { emit: 'nothing', strategy: 'denied', reason: 'denied' } as const;
    const KEY = 'GOOGLE_MAPS_API_KEY';
    expect(secretNamesForSandbox([named(KEY, withheld), named(KEY, withheld)])).toEqual([]);
  });

  test('THE INVARIANT, over the whole decision space: a name appears IFF a value does', () => {
    // Exhaustive rather than illustrative because the failure is not a wrong
    // answer, it is a desynchronised box: the daemon's env store builds
    // `knownNames` from this list, so a name without a value advertises a
    // variable that is not there and a value without a name escapes the store's
    // scrubbing and its hot-push updates entirely.
    const strategies: Array<SecretStrategy | null> = [null, 'runtime', 'egress', 'broker', 'denied'];
    const grants: Array<string[] | 'all' | null> = [null, 'all', [], ['ALPHA'], ['BETA']];
    const allowlists: Array<string[] | null> = [null, [], ['ALPHA'], ['BETA']];
    const sessions: Array<string | null> = [null, 'ses_1'];

    let combos = 0;
    for (const strategy of strategies) {
      for (const projectDefaultStrategy of strategies) {
        for (const agentGrantEnv of grants) {
          for (const sessionAllowlist of allowlists) {
            for (const sessionId of sessions) {
              combos += 1;
              const delivery = resolveSecretDelivery({
                identifier: 'ALPHA',
                strategy,
                projectDefaultStrategy,
                agentGrantEnv,
                sessionAllowlist,
                sessionId,
              });

              // A value is emitted iff the delivery is not 'nothing'…
              expect(emitsValue(delivery)).toBe(delivery.emit !== 'nothing');
              // …and the name list agrees, row by row.
              expect(secretNamesForSandbox([{ key: 'ALPHA_KEY', delivery }])).toEqual(
                delivery.emit === 'nothing' ? [] : ['ALPHA_KEY'],
              );

              // The two invariants that make the emit tag trustworthy.
              if (delivery.emit === 'plaintext') expect(delivery.strategy).toBe('runtime');
              if (delivery.emit === 'handle') {
                expect(['egress', 'broker']).toContain(delivery.strategy);
                expect(sessionId).toBeTruthy();
              }
              // No route to plaintext exists for a strategy anyone strengthened.
              if (delivery.emit === 'plaintext') {
                expect(strategy === null || strategy === 'runtime').toBe(true);
                expect(
                  projectDefaultStrategy === null || projectDefaultStrategy === 'runtime',
                ).toBe(true);
              }
            }
          }
        }
      }
    }
    expect(combos).toBe(strategies.length ** 2 * grants.length * allowlists.length * 2);
  });
});
