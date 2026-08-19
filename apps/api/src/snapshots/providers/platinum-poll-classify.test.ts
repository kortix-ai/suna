import { describe, expect, test } from 'bun:test';
import {
  classifyPlatinumPollError,
  isTerminalPollError,
  retryAfterMsFromError,
  walkErrorCauseCodes,
  httpStatusFromMessage,
} from './platinum-poll-classify';

describe('walkErrorCauseCodes', () => {
  test('walks the cause chain collecting codes + names', () => {
    const inner = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    const codes = walkErrorCauseCodes(outer);
    expect(codes).toContain('ECONNRESET');
    expect(codes).toContain('TypeError');
  });

  test('descends into AggregateError.errors (undici connect failures)', () => {
    const agg = Object.assign(new AggregateError([], 'all failed'), {
      errors: [Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })],
    });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: agg });
    expect(walkErrorCauseCodes(outer)).toContain('UND_ERR_CONNECT_TIMEOUT');
  });

  test('is cycle-safe', () => {
    const a: any = new Error('a');
    const b: any = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(() => walkErrorCauseCodes(a)).not.toThrow();
  });
});

describe('httpStatusFromMessage', () => {
  test.each([
    ['platinum GET /v1/templates/abc -> 404 not found', 404],
    ['platinum POST /x -> 429 slow down', 429],
    ['platinum GET /y -> 503 unavailable', 503],
    ['no status here', undefined],
  ])('%s → %s', (msg, expected) => {
    expect(httpStatusFromMessage(msg)).toBe(expected as any);
  });
});

describe('classifyPlatinumPollError (PHASE 2)', () => {
  test('401/403 → auth-permanent (terminal)', () => {
    expect(classifyPlatinumPollError(new Error('platinum GET /v1/templates/x -> 401 bad key'))).toBe('auth-permanent');
    expect(classifyPlatinumPollError(new Error('platinum GET /v1/templates/x -> 403 forbidden'))).toBe('auth-permanent');
    expect(isTerminalPollError('auth-permanent')).toBe(true);
  });

  test('404 → not-visible (healthy, not terminal)', () => {
    expect(classifyPlatinumPollError(new Error('platinum GET /v1/templates/x -> 404 gone'))).toBe('not-visible');
    expect(isTerminalPollError('not-visible')).toBe(false);
  });

  test('429 → rate-limited (transient)', () => {
    expect(classifyPlatinumPollError(new Error('platinum GET /x -> 429 too many retry-after=5'))).toBe('rate-limited');
    expect(isTerminalPollError('rate-limited')).toBe(false);
  });

  test('5xx → transient-5xx', () => {
    expect(classifyPlatinumPollError(new Error('platinum GET /x -> 502 bad gateway'))).toBe('transient-5xx');
    expect(classifyPlatinumPollError(new Error('platinum GET /x -> 503 unavailable'))).toBe('transient-5xx');
  });

  test('native socket errors (via cause) → transient-transport', () => {
    const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    expect(classifyPlatinumPollError(outer)).toBe('transient-transport');
  });

  test('DNS failure (ENOTFOUND via cause) → transient-transport', () => {
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    expect(classifyPlatinumPollError(outer)).toBe('transient-transport');
  });

  test('our AbortSignal timeout → transient-transport', () => {
    expect(classifyPlatinumPollError(new Error('platinum GET /x timed out after 20000ms (default)'))).toBe('transient-transport');
  });

  test('TLS/cert failure → security-terminal (terminal)', () => {
    const inner = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    expect(classifyPlatinumPollError(outer)).toBe('security-terminal');
    expect(isTerminalPollError('security-terminal')).toBe(true);
  });

  test('hostname mismatch → security-terminal', () => {
    const inner = Object.assign(new Error("Hostname/IP does not match"), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    expect(classifyPlatinumPollError(outer)).toBe('security-terminal');
  });

  test('unrecognized → unknown (bounded retry, not instant fail)', () => {
    expect(classifyPlatinumPollError(new Error('unexpected token in JSON'))).toBe('unknown');
    expect(isTerminalPollError('unknown')).toBe(false);
  });
});

describe('retryAfterMsFromError', () => {
  test('parses retry-after seconds → ms', () => {
    expect(retryAfterMsFromError(new Error('-> 429 slow retry-after=7'))).toBe(7000);
  });
  test('undefined when absent', () => {
    expect(retryAfterMsFromError(new Error('-> 429 slow'))).toBeUndefined();
  });
});
