// Unit coverage for policy conditions: CIDR matcher + checkConditions().
// Pure functions, no DB.

import { describe, expect, test } from 'bun:test';
import { assertValidCidr, ipMatchesAny, parseCidr } from '../shared/cidr';
import { checkConditions } from '../iam/engine';

describe('parseCidr', () => {
  test('parses bare IPv4 as /32', () => {
    const p = parseCidr('10.0.0.1');
    expect(p).not.toBeNull();
    expect(p!.family).toBe(4);
    expect(p!.prefix).toBe(32);
  });

  test('parses IPv4 CIDR', () => {
    const p = parseCidr('10.0.0.0/8');
    expect(p).not.toBeNull();
    expect(p!.family).toBe(4);
    expect(p!.prefix).toBe(8);
  });

  test('parses IPv6 forms', () => {
    expect(parseCidr('2001:db8::/32')).not.toBeNull();
    expect(parseCidr('::1')).not.toBeNull();
    expect(parseCidr('fe80::1')).not.toBeNull();
    expect(parseCidr('::/0')).not.toBeNull();
  });

  test('rejects malformed input', () => {
    expect(parseCidr('not.an.ip')).toBeNull();
    expect(parseCidr('999.0.0.0')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/-1')).toBeNull();
    expect(parseCidr('::1::2')).toBeNull(); // multiple ::
    expect(parseCidr('')).toBeNull();
    expect(parseCidr('   ')).toBeNull();
  });
});

describe('ipMatchesAny', () => {
  test('matches IPv4 inside CIDR', () => {
    const cidrs = [parseCidr('10.0.0.0/8')!];
    expect(ipMatchesAny('10.1.2.3', cidrs)).toBe(true);
    expect(ipMatchesAny('10.255.255.255', cidrs)).toBe(true);
    expect(ipMatchesAny('11.0.0.1', cidrs)).toBe(false);
  });

  test('bare IP behaves as /32', () => {
    const cidrs = [parseCidr('192.168.1.1')!];
    expect(ipMatchesAny('192.168.1.1', cidrs)).toBe(true);
    expect(ipMatchesAny('192.168.1.2', cidrs)).toBe(false);
  });

  test('IPv4-mapped IPv6 falls through to IPv4 rules', () => {
    const cidrs = [parseCidr('10.0.0.0/8')!];
    expect(ipMatchesAny('::ffff:10.1.2.3', cidrs)).toBe(true);
  });

  test('IPv6 CIDR match', () => {
    const cidrs = [parseCidr('2001:db8::/32')!];
    expect(ipMatchesAny('2001:db8:1::1', cidrs)).toBe(true);
    expect(ipMatchesAny('2001:db9::1', cidrs)).toBe(false);
  });

  test('multiple CIDRs — OR semantics', () => {
    const cidrs = [parseCidr('10.0.0.0/8')!, parseCidr('192.168.0.0/16')!];
    expect(ipMatchesAny('10.5.5.5', cidrs)).toBe(true);
    expect(ipMatchesAny('192.168.5.5', cidrs)).toBe(true);
    expect(ipMatchesAny('172.16.5.5', cidrs)).toBe(false);
  });

  test('/0 matches everything in its family', () => {
    const v4 = [parseCidr('0.0.0.0/0')!];
    expect(ipMatchesAny('1.2.3.4', v4)).toBe(true);
    const v6 = [parseCidr('::/0')!];
    expect(ipMatchesAny('2001:db8::1', v6)).toBe(true);
  });

  test('empty list never matches', () => {
    expect(ipMatchesAny('1.2.3.4', [])).toBe(false);
  });
});

describe('checkConditions', () => {
  test('no conditions → always passes', () => {
    expect(checkConditions({}, {})).toBe(true);
    expect(checkConditions(undefined, {})).toBe(true);
    expect(checkConditions(null, {})).toBe(true);
  });

  test('require_mfa: needs aal2', () => {
    expect(checkConditions({ require_mfa: true }, { mfaAal: 'aal2' })).toBe(true);
    expect(checkConditions({ require_mfa: true }, { mfaAal: 'aal1' })).toBe(false);
    expect(checkConditions({ require_mfa: true }, {})).toBe(false);
  });

  test('require_mfa: false is treated as not configured', () => {
    expect(checkConditions({ require_mfa: false }, {})).toBe(true);
  });

  test('ip_cidrs: must match one entry', () => {
    expect(checkConditions({ ip_cidrs: ['10.0.0.0/8'] }, { ip: '10.0.0.1' })).toBe(true);
    expect(checkConditions({ ip_cidrs: ['10.0.0.0/8'] }, { ip: '11.0.0.1' })).toBe(false);
    expect(checkConditions({ ip_cidrs: ['10.0.0.0/8'] }, {})).toBe(false);
  });

  test('multiple conditions compose with AND', () => {
    const cond = { ip_cidrs: ['10.0.0.0/8'], require_mfa: true };
    expect(checkConditions(cond, { ip: '10.0.0.1', mfaAal: 'aal2' })).toBe(true);
    expect(checkConditions(cond, { ip: '10.0.0.1', mfaAal: 'aal1' })).toBe(false);
    expect(checkConditions(cond, { ip: '11.0.0.1', mfaAal: 'aal2' })).toBe(false);
    expect(checkConditions(cond, {})).toBe(false);
  });

  test('empty ip_cidrs[] = condition not configured', () => {
    expect(checkConditions({ ip_cidrs: [] }, {})).toBe(true);
  });

  test('all-malformed ip_cidrs fails closed (no IP can match)', () => {
    expect(checkConditions({ ip_cidrs: ['garbage'] }, { ip: '10.0.0.1' })).toBe(false);
  });

  test('unknown keys are ignored (forward-compat)', () => {
    const cond = { unknown_key: 'whatever' } as unknown as Parameters<typeof checkConditions>[0];
    expect(checkConditions(cond, {})).toBe(true);
  });
});

describe('assertValidCidr', () => {
  test('returns the trimmed input on success', () => {
    expect(assertValidCidr('  10.0.0.0/8  ')).toBe('10.0.0.0/8');
    expect(assertValidCidr('2001:db8::/32')).toBe('2001:db8::/32');
  });

  test('throws on invalid input', () => {
    expect(() => assertValidCidr('not-a-cidr')).toThrow();
    expect(() => assertValidCidr('999.0.0.0')).toThrow();
    expect(() => assertValidCidr('10.0.0.0/99')).toThrow();
  });
});
