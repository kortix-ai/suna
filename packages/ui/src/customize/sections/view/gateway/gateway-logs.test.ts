import { describe, expect, test } from 'bun:test';

import { formatPayload, logMeta, logTitle } from './gateway-logs';

describe('logTitle / logMeta', () => {
  test('uses the requested model when there is one', () => {
    expect(logTitle({ requested_model: 'openai/gpt-5', resolved_model: '' })).toContain('gpt-5');
  });

  test('falls back to the resolved model', () => {
    expect(logTitle({ requested_model: '', resolved_model: 'openai/gpt-5' })).toContain('gpt-5');
  });

  test('names a gate rejection instead of rendering a blank title', () => {
    // Real local rows: task_liveness_in_flight logs store '' for every model
    // and provider column, which used to render as an empty line.
    expect(logTitle({ requested_model: '', resolved_model: '' })).toBe('Blocked before routing');
  });

  test('never emits a separator around a missing part', () => {
    expect(logMeta(['', 'Aug 9, 07:50:43 PM', 'task_liveness_in_flight'])).toBe(
      'Aug 9, 07:50:43 PM · task_liveness_in_flight',
    );
    expect(logMeta(['openrouter', 'Aug 17', false])).toBe('openrouter · Aug 17');
    expect(logMeta([null, undefined, ''])).toBe('');
  });
});

describe('formatPayload', () => {
  test('pretty-prints an object across multiple lines', () => {
    const { text, language } = formatPayload({ model: 'gpt-5', messages: [{ role: 'user' }] });
    expect(language).toBe('json');
    expect(text.split('\n').length).toBeGreaterThan(1);
    expect(text).toContain('  "model": "gpt-5"');
  });

  test('parses a JSON string body instead of rendering one unbroken line', () => {
    // Streamed / non-parsed upstream bodies land in the column as a raw string.
    const raw = '{"id":"chatcmpl-1","choices":[{"index":0}]}';
    const { text, language } = formatPayload(raw);
    expect(language).toBe('json');
    expect(text.split('\n').length).toBeGreaterThan(1);
    expect(text).toContain('"id": "chatcmpl-1"');
  });

  test('leaves a non-JSON string alone and marks it plain text', () => {
    const { text, language } = formatPayload('upstream connection reset');
    expect(language).toBe('text');
    expect(text).toBe('upstream connection reset');
  });

  test('does not mangle a string that only looks like JSON', () => {
    const { text, language } = formatPayload('{not really json');
    expect(language).toBe('text');
    expect(text).toBe('{not really json');
  });

  test('unwraps a streamed body stored as { value: "<raw SSE>" }', () => {
    // Real shape observed on a local streamed response: stringifying the wrapper
    // re-escapes the newlines and renders the whole stream as one line.
    const sse = ': keep-alive\n\ndata: {"id":"chatcmpl-1"}\n\ndata: [DONE]\n';
    const naive = JSON.stringify({ value: sse }, null, 2);
    expect(naive.split('\n').length).toBe(3); // the bug: 3 lines for a 5-line stream

    const { text, language } = formatPayload({ value: sse });
    expect(language).toBe('text');
    expect(text).toBe(sse);
    expect(text.split('\n').length).toBeGreaterThan(3);
    expect(text).not.toContain('\\n');
  });

  test('leaves a normal multi-key object as pretty JSON', () => {
    const { text, language } = formatPayload({ a: 'x\ny', b: 2 });
    expect(language).toBe('json');
    expect(text).toContain('"b": 2');
  });

  test('leaves a single-key object holding a short single-line string as JSON', () => {
    const { language } = formatPayload({ value: 'ok' });
    expect(language).toBe('json');
  });
});

/**
 * The all/success/error filter maps to the route's `ok` query param. `err` must
 * send `ok=false`, which is the case a truthiness check silently drops — the
 * classic way an "Errors" tab ends up listing everything.
 */
function filterToQuery(filter: 'all' | 'ok' | 'err'): { ok?: boolean } | undefined {
  return filter === 'all' ? undefined : { ok: filter === 'ok' };
}

describe('log filter → API query', () => {
  test('all sends no ok param', () => {
    expect(filterToQuery('all')).toBeUndefined();
  });

  test('success sends ok=true', () => {
    expect(filterToQuery('ok')).toEqual({ ok: true });
  });

  test('errors sends ok=false, not undefined', () => {
    const q = filterToQuery('err');
    expect(q).toEqual({ ok: false });
    // `ok` must survive an `!== undefined` serializer check.
    expect(q?.ok).not.toBeUndefined();
  });
});
