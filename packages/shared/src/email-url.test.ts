import { describe, expect, test } from 'bun:test';

import { EmailUrlError, parseEmailTarget, parseEmailTargets, redactUrl } from './email-url';

describe('parseEmailTarget', () => {
  test('parses an SMTP URL with credentials and an explicit port', () => {
    expect(parseEmailTarget('smtp://alice:s3cret@mail.example.com:2525')).toEqual({
      kind: 'smtp',
      host: 'mail.example.com',
      port: 2525,
      secure: false,
      requireTls: true,
      rejectUnauthorized: true,
      user: 'alice',
      pass: 's3cret',
    });
  });

  test('defaults to 587 with STARTTLS, and to 465 with implicit TLS for smtps', () => {
    expect(parseEmailTarget('smtp://user:pw@mail.example.com')).toMatchObject({
      port: 587,
      secure: false,
      requireTls: true,
    });
    expect(parseEmailTarget('smtps://user:pw@mail.example.com')).toMatchObject({
      port: 465,
      secure: true,
      requireTls: false,
    });
  });

  test('treats port 465 as implicit TLS even under the smtp scheme', () => {
    expect(parseEmailTarget('smtp://user:pw@mail.example.com:465')).toMatchObject({
      secure: true,
      requireTls: false,
    });
  });

  test('an anonymous relay stays opportunistic; credentials force STARTTLS', () => {
    const anonymous = parseEmailTarget('smtp://127.0.0.1:1025');
    expect(anonymous).toMatchObject({ requireTls: false });
    expect(anonymous).not.toHaveProperty('user');
    expect(parseEmailTarget('smtp://u:p@127.0.0.1:1025')).toMatchObject({ requireTls: true });
  });

  test('?tls=off drops the STARTTLS requirement, ?insecure=1 accepts self-signed certs', () => {
    expect(parseEmailTarget('smtp://u:p@relay.internal:587?tls=off')).toMatchObject({
      requireTls: false,
    });
    expect(parseEmailTarget('smtp://u:p@relay.internal:587?insecure=1')).toMatchObject({
      rejectUnauthorized: false,
    });
  });

  test('percent-decodes credentials and splits on the LAST @', () => {
    expect(parseEmailTarget('smtp://user%40corp.com:p%40ss@mail.example.com:587')).toMatchObject({
      user: 'user@corp.com',
      pass: 'p@ss',
      host: 'mail.example.com',
    });
  });

  test('keeps IPv6 hosts intact', () => {
    expect(parseEmailTarget('smtp://[::1]:1025')).toMatchObject({ host: '::1', port: 1025 });
  });

  // The reason this parser is hand-rolled: `new URL()` lowercases the host, so
  // an API key or AWS access key in that position would be silently corrupted.
  test('preserves case in API keys and AWS access keys', () => {
    expect(parseEmailTarget('resend://re_AbC123XyZ')).toEqual({ // gitleaks:allow
      kind: 'resend',
      apiKey: 're_AbC123XyZ', // gitleaks:allow
    });
    expect(parseEmailTarget('ses://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI@us-east-2')).toEqual({
      kind: 'ses',
      region: 'us-east-2',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI',
    });
  });

  test('ses://<region> alone means instance/task-role credentials', () => {
    expect(parseEmailTarget('ses://eu-west-1')).toEqual({ kind: 'ses', region: 'eu-west-1' });
  });

  test('parses mailtrap and mailpit', () => {
    expect(parseEmailTarget('mailtrap://tok_123')).toEqual({ kind: 'mailtrap', token: 'tok_123' });
    expect(parseEmailTarget('mailpit://127.0.0.1:8025')).toEqual({
      kind: 'mailpit',
      baseUrl: 'http://127.0.0.1:8025',
    });
  });

  test('rejects a non-URL, an unknown scheme, and an invalid port', () => {
    expect(() => parseEmailTarget('smtp.example.com')).toThrow(EmailUrlError);
    expect(() => parseEmailTarget('carrier-pigeon://nest')).toThrow(/unsupported email scheme/);
    expect(() => parseEmailTarget('smtp://host:99999')).toThrow(/invalid port/);
    expect(() => parseEmailTarget('resend://')).toThrow(/missing Resend API key/);
  });
});

describe('parseEmailTargets', () => {
  test('builds an ordered chain from a comma-separated list', () => {
    const { targets, errors } = parseEmailTargets('ses://us-east-2, resend://re_key');
    expect(errors).toEqual([]);
    expect(targets.map((target) => target.kind)).toEqual(['ses', 'resend']);
  });

  test('one bad entry is reported but does not discard the good ones', () => {
    const { targets, errors } = parseEmailTargets('nope://x,smtp://127.0.0.1:1025');
    expect(targets.map((target) => target.kind)).toEqual(['smtp']);
    expect(errors).toHaveLength(1);
  });

  test('empty input yields no providers', () => {
    expect(parseEmailTargets('').targets).toEqual([]);
    expect(parseEmailTargets(undefined).targets).toEqual([]);
  });
});

describe('redactUrl', () => {
  test('never leaks credentials into a log line', () => {
    expect(redactUrl('smtp://alice:s3cret@mail.example.com:587')).toBe(
      'smtp://***@mail.example.com:587',
    );
    expect(redactUrl('resend://re_secret')).toBe('resend://***');
    expect(redactUrl('ses://AKIA:secret@us-east-2')).toBe('ses://***@us-east-2');
  });
});
