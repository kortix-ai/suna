import { describe, expect, test } from 'bun:test';
import { REDACTED, buildArgsPreview, isSecretKey, summarizeArgsPreview } from './args-preview';

describe('isSecretKey', () => {
  test('redacts credential-shaped keys across naming styles', () => {
    for (const key of [
      'password',
      'apiKey',
      'api_key',
      'API-KEY',
      'access_token',
      'refreshToken',
      'authorization',
      'Cookie',
      'client_secret',
      'private_key',
      'signature',
      'oauth.access_token',
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  test('preserves keys that merely contain a secret word as a substring', () => {
    for (const key of ['keyword', 'monkey', 'authors', 'passage', 'keys_count', 'to', 'subject']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  test('leaves a bare map key readable but redacts a qualified one', () => {
    expect(isSecretKey('key')).toBe(false);
    expect(isSecretKey('signing_key')).toBe(true);
  });
});

describe('buildArgsPreview', () => {
  test('keeps the fields a human needs to judge an email send', () => {
    const preview = buildArgsPreview({
      to: 'stranger@other-company.test',
      cc: ['ops@example.com'],
      subject: 'Delivery instructions',
      body: 'Hi, could you confirm the pickup window?',
    });

    expect(preview).toEqual({
      to: 'stranger@other-company.test',
      cc: ['ops@example.com'],
      subject: 'Delivery instructions',
      body: 'Hi, could you confirm the pickup window?',
    });
  });

  test('never copies a secret value, not even truncated', () => {
    const secret = 'ya29.a0ARrdaM-super-secret-oauth-token-value';
    const preview = buildArgsPreview({ to: 'a@b.com', access_token: secret });

    expect(preview?.access_token).toBe(REDACTED);
    expect(JSON.stringify(preview)).not.toContain('ya29');
  });

  test('describes an opaque blob instead of sampling its prefix', () => {
    const blob = 'A'.repeat(400);
    const preview = buildArgsPreview({ attachment: blob });

    expect(preview?.attachment).toBe('[400 chars omitted]');
    expect(String(preview?.attachment)).not.toContain('AAAA');
  });

  test('truncates long prose but keeps it readable', () => {
    const body = `${'word '.repeat(80)}end`;
    const preview = buildArgsPreview({ body });

    expect(String(preview?.body)).toStartWith('word word');
    expect(String(preview?.body)).toContain('chars]');
  });

  test('caps array breadth with a remainder note', () => {
    const preview = buildArgsPreview({ bcc: Array.from({ length: 15 }, (_, i) => `u${i}@x.com`) });

    const bcc = preview?.bcc as unknown[];
    expect(bcc).toHaveLength(11);
    expect(bcc[10]).toBe('… [+5 more]');
  });

  test('collapses beyond the depth cap rather than walking forever', () => {
    const preview = buildArgsPreview({ a: { b: { c: { d: { e: 1 } } } } });

    expect(preview).toEqual({ a: { b: { c: '[object]' } } });
  });

  test('redacts a secret nested inside an object', () => {
    const preview = buildArgsPreview({ headers: { authorization: 'Bearer abc123' } });

    expect(preview).toEqual({ headers: { authorization: REDACTED } });
    expect(JSON.stringify(preview)).not.toContain('abc123');
  });

  test('holds the total size cap on a huge payload', () => {
    const args: Record<string, string> = {};
    for (let i = 0; i < 60; i++) args[`field_${i}`] = 'x'.repeat(150);

    const preview = buildArgsPreview(args);

    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(4_200);
  });

  test('returns null when there is nothing to show', () => {
    expect(buildArgsPreview(null)).toBeNull();
    expect(buildArgsPreview(undefined)).toBeNull();
    expect(buildArgsPreview({})).toBeNull();
    expect(buildArgsPreview('nope')).toBeNull();
  });

  test('does not walk class instances', () => {
    class Weird {
      constructor(readonly hidden = 'leak') {}
    }
    const preview = buildArgsPreview({ thing: new Weird() });

    expect(preview).toEqual({ thing: '[object]' });
  });

  test('survives a circular payload', () => {
    const circular: Record<string, unknown> = { to: 'a@b.com' };
    circular.self = circular;

    expect(() => buildArgsPreview(circular)).not.toThrow();
  });
});

describe('summarizeArgsPreview', () => {
  test('leads with the recipient so the one-liner answers "where is this going"', () => {
    const summary = summarizeArgsPreview({
      subject: 'Delivery instructions',
      to: 'stranger@other-company.test',
      body: 'hello',
    });

    expect(summary).toBe('to: stranger@other-company.test · subject: Delivery instructions');
  });

  test('skips redacted and empty fields', () => {
    expect(summarizeArgsPreview({ to: REDACTED })).toBeNull();
    expect(summarizeArgsPreview(null)).toBeNull();
    expect(summarizeArgsPreview({})).toBeNull();
  });
});
