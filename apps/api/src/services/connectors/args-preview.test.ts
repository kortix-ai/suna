import { describe, expect, test } from 'bun:test';
import {
  REDACTED,
  approvalPreviewReviewable,
  buildArgsPreview,
  buildArgsPreviewDetails,
  isSecretKey,
  summarizeArgsPreview,
} from './args-preview';

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
    expect(isSecretKey('access')).toBe(false);
    expect(isSecretKey('access_key')).toBe(true);
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

  test('keeps a normal Gmail body complete and approvable', () => {
    const body = `${'Delivery details for the customer. '.repeat(200)}Please reply today.`;
    const details = buildArgsPreviewDetails({
      to: 'customer@example.com',
      subject: 'Delivery update',
      body,
    });

    expect(details.complete).toBe(true);
    expect(details.preview?.body).toBe(body);
  });

  test('never copies a secret value, not even truncated', () => {
    const secret = 'ya29.a0ARrdaM-super-secret-oauth-token-value';
    const preview = buildArgsPreview({ to: 'a@b.com', access_token: secret });

    expect(preview?.access_token).toBe(REDACTED);
    expect(JSON.stringify(preview)).not.toContain('ya29');
  });

  test('describes an opaque blob instead of sampling its prefix', () => {
    const blob = 'A'.repeat(400);
    const details = buildArgsPreviewDetails({ attachment: blob });
    const preview = details.preview;

    expect(preview?.attachment).toBe('[400 chars omitted]');
    expect(String(preview?.attachment)).not.toContain('AAAA');
    expect(details.complete).toBe(false);
  });

  test('truncates long prose but keeps it readable', () => {
    const body = `${'word '.repeat(4_100)}end`;
    const details = buildArgsPreviewDetails({ body });
    const preview = details.preview;

    expect(String(preview?.body)).toStartWith('word word');
    expect(String(preview?.body)).toContain('chars]');
    expect(details.complete).toBe(false);
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

describe('approvalPreviewReviewable', () => {
  test('a truncated preview is still reviewable — the elision is shown in place', () => {
    // The exact shape the builder writes for an email carrying an attachment:
    // recipient and subject are legible, the blob is described, `complete` is
    // false. This used to be un-approvable, so the run could only be killed.
    const details = buildArgsPreviewDetails({
      to: 'customer@example.com',
      subject: 'Signed contract',
      attachment: 'A'.repeat(400),
    });

    expect(details.complete).toBe(false);
    expect(
      approvalPreviewReviewable({
        args_preview: details.preview,
        args_preview_complete: details.complete,
      }),
    ).toBe(true);
  });

  test('an argument-less call is reviewable — there is nothing to withhold', () => {
    const details = buildArgsPreviewDetails(undefined);

    expect(details).toEqual({ preview: null, complete: true });
    expect(approvalPreviewReviewable({ args_preview: null, args_preview_complete: true })).toBe(
      true,
    );
  });

  test('an empty argument object is reviewable', () => {
    const details = buildArgsPreviewDetails({});

    expect(details).toEqual({ preview: null, complete: true });
  });

  test('a row with no preview at all is NOT reviewable', () => {
    // Legacy rows written before previews existed, and callers not authorised
    // to see connector arguments. Approving those is approving blind.
    expect(approvalPreviewReviewable({ reason: 'policy_require_approval' })).toBe(false);
    expect(approvalPreviewReviewable({ args_preview: null, args_preview_complete: false })).toBe(
      false,
    );
    expect(approvalPreviewReviewable({ args_preview: {}, args_preview_complete: false })).toBe(
      false,
    );
    expect(approvalPreviewReviewable(null)).toBe(false);
  });
});
