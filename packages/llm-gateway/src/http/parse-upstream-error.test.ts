import { describe, expect, test } from 'bun:test';

import {
  extractUpstreamErrorDetail,
  isGenericStatusText,
  parseUpstreamErrorBody,
} from './parse-upstream-error';

describe('extractUpstreamErrorDetail', () => {
  test('OpenAI-compatible {error:{message,code}} → real message + code', () => {
    expect(
      extractUpstreamErrorDetail({
        error: { message: 'context length exceeded from messages', code: 'context_length_exceeded' },
      }),
    ).toEqual({ message: 'context length exceeded from messages', code: 'context_length_exceeded' });
  });

  test('OpenAI-compatible with type but no code → code falls back to type', () => {
    expect(
      extractUpstreamErrorDetail({
        error: { message: 'Overloaded', type: 'overloaded_error' },
      }),
    ).toEqual({ message: 'Overloaded', code: 'overloaded_error' });
  });

  test('Anthropic shape {type:"error",error:{type,message}} → real message + type as code', () => {
    expect(
      extractUpstreamErrorDetail({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
    ).toEqual({ message: 'Overloaded', code: 'overloaded_error' });
  });

  test('top-level {message, code} → real message + code', () => {
    expect(extractUpstreamErrorDetail({ message: 'rate limited', code: 429 })).toEqual({
      message: 'rate limited',
      code: 429,
    });
  });

  test('numeric code is preserved', () => {
    expect(
      extractUpstreamErrorDetail({ error: { message: 'nope', code: 400 } }),
    ).toEqual({ message: 'nope', code: 400 });
  });

  test('empty message inside error object → falls through', () => {
    expect(extractUpstreamErrorDetail({ error: { message: '' } })).toBeNull();
  });

  test('non-object / null → null', () => {
    expect(extractUpstreamErrorDetail(null)).toBeNull();
    expect(extractUpstreamErrorDetail('Bad Request')).toBeNull();
    expect(extractUpstreamErrorDetail(undefined)).toBeNull();
  });
});

describe('parseUpstreamErrorBody', () => {
  test('JSON OpenAI-shaped body → real message + code', () => {
    expect(
      parseUpstreamErrorBody(
        '{"error":{"message":"context length exceeded from messages","code":"context_length_exceeded"}}',
      ),
    ).toEqual({ message: 'context length exceeded from messages', code: 'context_length_exceeded' });
  });

  test('non-JSON body (HTML/plain) → trimmed raw body, bounded to 2000 chars', () => {
    const long = '<html>' + 'x'.repeat(3000) + '</html>';
    const out = parseUpstreamErrorBody(long);
    expect(out.message.endsWith('…')).toBe(true);
    expect(out.message.length).toBeLessThanOrEqual(2001);
    expect(out.code).toBeUndefined();
  });

  test('empty body → fallback', () => {
    expect(parseUpstreamErrorBody('', 'Bad Request')).toEqual({ message: 'Bad Request' });
    expect(parseUpstreamErrorBody('   ')).toEqual({ message: 'Upstream request failed' });
  });

  test('JSON without an error/message shape → raw body (bounded)', () => {
    expect(parseUpstreamErrorBody('{"foo":1}')).toEqual({ message: '{"foo":1}' });
  });
});

describe('isGenericStatusText', () => {
  test('recognizes common HTTP status texts the AI SDK falls back to', () => {
    expect(isGenericStatusText('Bad Request')).toBe(true);
    expect(isGenericStatusText('bad request')).toBe(true);
    expect(isGenericStatusText('Internal Server Error')).toBe(true);
    expect(isGenericStatusText('Bad Gateway')).toBe(true);
    expect(isGenericStatusText('  Forbidden  ')).toBe(true);
  });

  test('a real upstream message is NOT treated as generic', () => {
    expect(isGenericStatusText('context length exceeded from messages')).toBe(false);
    expect(isGenericStatusText('Incorrect API key provided')).toBe(false);
    expect(isGenericStatusText('Bad Request: missing field')).toBe(false);
    expect(isGenericStatusText('')).toBe(false);
    expect(isGenericStatusText(undefined)).toBe(false);
  });
});
