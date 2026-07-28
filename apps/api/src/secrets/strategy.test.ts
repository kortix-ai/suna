import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';

import {
  DEFAULT_HANDLE_PREFIX,
  type SecretEgressPolicy,
  deliversPlaintextToSandbox,
  isFullyWithheld,
  looksLikeHandle,
  matchRule,
  maxStrategy,
  mintHandle,
  newLookupId,
  parseEgressPolicy,
  parseHandle,
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
