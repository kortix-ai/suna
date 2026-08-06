import { describe, expect, test } from 'bun:test';
import {
  type Policy,
  areValidConditions,
  normalizeConditions,
  parseStoredConditions,
  resolveEffectiveAction,
} from './policy';

const ALLOWED = '/^(owner@example\\.com|admin@example\\.com)$/';

/** The allow-list shape: a narrow permit, then a catch-all block under it. */
const EMAIL_ALLOW_LIST: Policy[] = [
  {
    match: 'gmail.send_email',
    action: 'require_approval',
    position: 0,
    conditions: [{ arg: 'to', match: ALLOWED }],
  },
  { match: 'gmail.send_email', action: 'block', position: 1 },
];

function resolve(args: Record<string, unknown> | null, argsAvailable = true) {
  return resolveEffectiveAction({
    fullPath: 'gmail.send_email',
    relPath: 'send_email',
    projectPolicies: EMAIL_ALLOW_LIST,
    connectorPolicies: [],
    risk: 'write',
    defaultMode: 'risk',
    args,
    argsAvailable,
  });
}

describe('arg-level policy conditions', () => {
  test('permits an on-list recipient', () => {
    expect(resolve({ to: 'owner@example.com' }).action).toBe('require_approval');
    expect(resolve({ to: 'admin@example.com' }).action).toBe('require_approval');
  });

  test('blocks an off-list recipient', () => {
    expect(resolve({ to: 'stranger@other-company.test' }).action).toBe('block');
  });

  test('blocks a near-miss that a sloppy pattern would let through', () => {
    for (const to of [
      'owner@example.com.attacker.test',
      'evil+owner@example.com@evil.test',
      'OWNER@EXAMPLE.COM.co',
      'xowner@example.com',
    ]) {
      expect(resolve({ to }).action).toBe('block');
    }
  });

  test('is case-insensitive on an exact address, matching the matcher grammar', () => {
    expect(resolve({ to: 'Owner@Example.com' }).action).toBe('require_approval');
  });

  test('blocks when ANY recipient in a list is off-list', () => {
    expect(resolve({ to: ['owner@example.com', 'stranger@other-company.test'] }).action).toBe(
      'block',
    );
    expect(resolve({ to: ['owner@example.com', 'admin@example.com'] }).action).toBe(
      'require_approval',
    );
  });

  test('blocks when the guarded arg is missing entirely', () => {
    expect(resolve({ subject: 'no recipient' }).action).toBe('block');
    expect(resolve({ to: null }).action).toBe('block');
    expect(resolve({ to: [] }).action).toBe('block');
  });

  test('blocks when the arg is a non-scalar we cannot compare', () => {
    expect(resolve({ to: { address: 'owner@example.com' } }).action).toBe('block');
  });

  test('never reads through the prototype chain', () => {
    const protoRule: Policy[] = [
      {
        match: 'gmail.send_email',
        action: 'always_run',
        position: 0,
        conditions: [{ arg: 'constructor', match: '*' }],
      },
    ];
    const result = resolveEffectiveAction({
      fullPath: 'gmail.send_email',
      relPath: 'send_email',
      projectPolicies: protoRule,
      connectorPolicies: [],
      risk: 'write',
      defaultMode: 'risk',
      args: {},
      argsAvailable: true,
    });

    expect(result.action).toBe('require_approval');
    expect(result.source).toBe('risk_default');
  });

  /**
   * Undecidable condition (no args in hand) resolves toward LESS privilege, but
   * "less privilege" differs per action: a gate still gates (ask the human, who
   * then sees the args and decides), while a permit must not silently open.
   */
  test('an unevaluated gate still asks the human rather than auto-running', () => {
    expect(resolve(null, false).action).toBe('require_approval');
  });

  test('an unevaluated permit never opens the tool', () => {
    const permissive: Policy[] = [
      {
        match: 'gmail.send_email',
        action: 'always_run',
        position: 0,
        conditions: [{ arg: 'to', match: ALLOWED }],
      },
    ];
    const result = resolveEffectiveAction({
      fullPath: 'gmail.send_email',
      relPath: 'send_email',
      projectPolicies: permissive,
      connectorPolicies: [],
      risk: 'write',
      defaultMode: 'risk',
      argsAvailable: false,
    });

    expect(result.action).toBe('require_approval');
    expect(result.source).toBe('risk_default');
  });

  test('an unevaluated block still blocks', () => {
    const blocking: Policy[] = [
      {
        match: 'gmail.send_email',
        action: 'block',
        position: 0,
        conditions: [{ arg: 'to', match: ALLOWED, negate: true }],
      },
    ];
    const result = resolveEffectiveAction({
      fullPath: 'gmail.send_email',
      relPath: 'send_email',
      projectPolicies: blocking,
      connectorPolicies: [],
      risk: 'write',
      defaultMode: 'risk',
      argsAvailable: false,
    });

    expect(result.action).toBe('block');
  });

  test('negate expresses "block anything not on the list" in one rule', () => {
    const denyOffList: Policy[] = [
      {
        match: 'gmail.send_email',
        action: 'block',
        position: 0,
        conditions: [{ arg: 'to', match: ALLOWED, negate: true }],
      },
    ];
    const check = (args: Record<string, unknown>) =>
      resolveEffectiveAction({
        fullPath: 'gmail.send_email',
        relPath: 'send_email',
        projectPolicies: denyOffList,
        connectorPolicies: [],
        risk: 'write',
        defaultMode: 'risk',
        args,
        argsAvailable: true,
      }).action;

    expect(check({ to: 'stranger@other-company.test' })).toBe('block');
    expect(check({})).toBe('block');
    expect(check({ to: 'owner@example.com' })).toBe('require_approval');
  });

  test('reads a nested arg path', () => {
    const nested: Policy[] = [
      {
        match: 'slack.post',
        action: 'block',
        position: 0,
        conditions: [{ arg: 'message.channel', match: 'general' }],
      },
    ];
    const check = (args: Record<string, unknown>) =>
      resolveEffectiveAction({
        fullPath: 'slack.post',
        relPath: 'post',
        projectPolicies: nested,
        connectorPolicies: [],
        risk: 'write',
        defaultMode: 'risk',
        args,
        argsAvailable: true,
      }).action;

    expect(check({ message: { channel: 'general' } })).toBe('block');
    expect(check({ message: { channel: 'ops' } })).toBe('require_approval');
  });

  test('an unconditional rule behaves exactly as before', () => {
    const plain: Policy[] = [{ match: 'gmail.*', action: 'block', position: 0 }];
    const result = resolveEffectiveAction({
      fullPath: 'gmail.send_email',
      relPath: 'send_email',
      projectPolicies: plain,
      connectorPolicies: [],
      risk: 'write',
      defaultMode: 'risk',
    });

    expect(result).toEqual({ action: 'block', source: 'project' });
  });
});

describe('areValidConditions', () => {
  test('accepts absent, empty and well-formed lists', () => {
    expect(areValidConditions(null)).toBe(true);
    expect(areValidConditions(undefined)).toBe(true);
    expect(areValidConditions([])).toBe(true);
    expect(areValidConditions([{ arg: 'to', match: ALLOWED, negate: true }])).toBe(true);
    expect(areValidConditions([{ arg: 'message.channel', match: 'ops-*' }])).toBe(true);
  });

  test('rejects malformed arg paths', () => {
    for (const arg of ['', '1bad', 'a..b', 'a.', 'a[0]', 'a b', 'a-b']) {
      expect(areValidConditions([{ arg, match: '*' }])).toBe(false);
    }
  });

  test('rejects prototype-chain arg paths', () => {
    for (const arg of ['__proto__', '__proto__.x', 'a.constructor', 'a.prototype.b']) {
      expect(areValidConditions([{ arg, match: '*' }])).toBe(false);
    }
  });

  test('rejects an invalid or catastrophic regex so a rule cannot silently never match', () => {
    expect(areValidConditions([{ arg: 'to', match: '/(/' }])).toBe(false);
    expect(areValidConditions([{ arg: 'to', match: '/(a+)+$/' }])).toBe(false);
  });

  test('rejects wrong shapes and oversized lists', () => {
    expect(areValidConditions('nope')).toBe(false);
    expect(areValidConditions([{ arg: 'to' }])).toBe(false);
    expect(areValidConditions([{ match: '*' }])).toBe(false);
    expect(areValidConditions([{ arg: 'to', match: '*', negate: 'yes' }])).toBe(false);
    expect(areValidConditions(Array(11).fill({ arg: 'to', match: '*' }))).toBe(false);
  });
});

describe('parseStoredConditions', () => {
  test('treats absent and empty as an unconditional rule', () => {
    expect(parseStoredConditions(null)).toEqual({ conditions: null });
    expect(parseStoredConditions(undefined)).toEqual({ conditions: null });
    expect(parseStoredConditions([])).toEqual({ conditions: null });
  });

  test('passes through a well-formed stored list', () => {
    expect(parseStoredConditions([{ arg: 'to', match: ALLOWED }])).toEqual({
      conditions: [{ arg: 'to', match: ALLOWED }],
    });
  });

  test('flags a malformed list instead of silently dropping the restriction', () => {
    expect(parseStoredConditions([{ arg: '__proto__', match: '*' }])).toEqual({
      conditions: null,
      conditionsInvalid: true,
    });
    expect(parseStoredConditions('garbage')).toEqual({
      conditions: null,
      conditionsInvalid: true,
    });
  });
});

describe('malformed stored conditions never widen privilege', () => {
  function withStored(action: Policy['action'], raw: unknown) {
    const policy: Policy = {
      match: 'gmail.send_email',
      action,
      position: 0,
      ...parseStoredConditions(raw),
    };
    return resolveEffectiveAction({
      fullPath: 'gmail.send_email',
      relPath: 'send_email',
      projectPolicies: [policy],
      connectorPolicies: [],
      risk: 'write',
      defaultMode: 'risk',
      args: { to: 'stranger@other-company.test' },
      argsAvailable: true,
    });
  }

  test('a broken permit does NOT become allow-everything', () => {
    const result = withStored('always_run', [{ arg: 'to', match: '/(/' }]);

    expect(result.action).toBe('require_approval');
    expect(result.source).toBe('risk_default');
  });

  test('a broken block still blocks', () => {
    expect(withStored('block', 'garbage').action).toBe('block');
  });

  test('a broken gate still gates', () => {
    expect(withStored('require_approval', 'garbage').action).toBe('require_approval');
  });
});

describe('normalizeConditions', () => {
  test('drops empties and strips unknown fields', () => {
    expect(normalizeConditions(null)).toBeNull();
    expect(normalizeConditions([])).toBeNull();
    expect(normalizeConditions('bad')).toBeNull();
    expect(normalizeConditions([{ arg: 'to', match: '*', extra: 'x', negate: false }])).toEqual([
      { arg: 'to', match: '*' },
    ]);
  });
});
