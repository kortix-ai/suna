import { describe, expect, test } from 'bun:test';

import {
  cleanResultSnippet,
  formatRawOutput,
  looksLikeJsonPayload,
  parseEmbeddedFailure,
  recoverLinkResults,
} from './tool-output-format';

describe('tool output formatting', () => {
  test('detects JSON-ish payloads (including truncated)', () => {
    expect(looksLikeJsonPayload('{"a":1}')).toBe(true);
    expect(looksLikeJsonPayload('  [1,2,3]')).toBe(true);
    expect(looksLikeJsonPayload('{ "batch_mode": true, "results": [')).toBe(true); // truncated
    expect(looksLikeJsonPayload('Title: Foo\nURL: bar')).toBe(false);
    expect(looksLikeJsonPayload(undefined)).toBe(false);
  });

  test('pretty-prints parseable JSON', () => {
    const { text, truncatedChars } = formatRawOutput('{"a":1,"b":2}', 2000);
    expect(text).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(truncatedChars).toBe(0);
  });

  test('unwraps double-encoded JSON', () => {
    const { text } = formatRawOutput(JSON.stringify('{"a":1}'), 2000);
    expect(text).toBe('{\n  "a": 1\n}');
  });

  test('caps oversized output and reports dropped characters', () => {
    const big = 'x'.repeat(5000);
    const { text, truncatedChars } = formatRawOutput(big, 2000);
    expect(text.length).toBe(2000);
    expect(truncatedChars).toBe(3000);
  });

  test('leaves truncated/invalid JSON as raw capped text (no throw)', () => {
    const broken = '{ "results": [ { "title": "a", "url": "http://x" }, { "title": "b"';
    const { text } = formatRawOutput(broken, 2000);
    expect(text).toBe(broken);
  });

  test('cleans scraped content into a tidy snippet', () => {
    const messy =
      'Aa\\n\\n![alt](img.png) # Marko O. Kraemer spawner spawner Spawned in Frankfurt. Plutus Plutus Plutus';
    const snippet = cleanResultSnippet(messy, 200);
    expect(snippet).not.toContain('![');
    expect(snippet).not.toContain('\\n');
    expect(snippet).not.toContain('spawner spawner');
    expect(snippet).not.toContain('Plutus Plutus');
    expect(snippet).toContain('Spawned in Frankfurt');
  });

  test('truncates long snippets with an ellipsis', () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    expect(cleanResultSnippet(long, 40)).toMatch(/…$/);
  });

  test('recovers result cards from a truncated batch web-search blob', () => {
    // Strict JSON.parse would throw on this (snippet cut off, brackets unclosed).
    const truncated =
      '{"batch_mode":true,"results":[' +
      '{"query":"q1","answer":"a1","results":[' +
      '{"title":"From Teen Entrepreneur","url":"https://linkedin.com/posts/abc","snippet":"At just 12 he founded BluePage"},' +
      '{"title":"CEO & Founder of Kortix","url":"https://markokraemer.com","snippet":"Started selling websites"}]},' +
      '{"query":"q2","results":[' +
      '{"title":"Plutus Groupware","url":"https://hightechbox.de/x","snippet":"Die beiden Plutus-Gru';
    expect(() => JSON.parse(truncated)).toThrow();

    const recovered = recoverLinkResults(truncated);
    expect(recovered.map((r) => r.url)).toEqual([
      'https://linkedin.com/posts/abc',
      'https://markokraemer.com',
      'https://hightechbox.de/x', // title+url complete even though its snippet was cut
    ]);
    expect(recovered[0].title).toBe('From Teen Entrepreneur');
    expect(recovered[0].snippet).toBe('At just 12 he founded BluePage');
    expect(recovered[2].snippet).toBeUndefined();
  });

  test('recovers scrape records (url-first ordering) and dedupes', () => {
    const raw =
      '{"results":[{"url":"https://a.com","success":true,"title":"Alpha","content":"x"},' +
      '{"url":"https://a.com","success":true,"title":"Alpha dup"},' +
      '{"url":"not-a-url","title":"skip me"';
    const recovered = recoverLinkResults(raw);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ url: 'https://a.com', title: 'Alpha' });
  });

  test('recovers nothing from plain prose', () => {
    expect(recoverLinkResults('just some text, no json here')).toEqual([]);
    expect(recoverLinkResults(undefined)).toEqual([]);
  });
});

describe('parseEmbeddedFailure', () => {
  test('unwraps the real web_search 402 transcript to the innermost message', () => {
    const output = JSON.stringify({
      query: 'best financial benchmarks',
      success: false,
      error:
        'Error: 402 Error: {"error":true,"message":"Insufficient credits","status":402}',
    });
    expect(parseEmbeddedFailure(output)).toEqual({
      message: 'Insufficient credits',
      status: 402,
    });
  });

  test('keeps a flat error message as-is when there is no nested JSON', () => {
    const output = JSON.stringify({ success: false, error: 'Search provider timed out' });
    expect(parseEmbeddedFailure(output)).toEqual({
      message: 'Search provider timed out',
      status: undefined,
    });
  });

  test('handles a double-encoded (stringified) failure payload', () => {
    const inner = JSON.stringify({ success: false, error: 'Rate limited' });
    expect(parseEmbeddedFailure(JSON.stringify(inner))).toEqual({
      message: 'Rate limited',
      status: undefined,
    });
  });

  test('returns null for a successful payload', () => {
    const output = JSON.stringify({ query: 'x', results: [{ title: 'a', url: 'http://a.com' }] });
    expect(parseEmbeddedFailure(output)).toBeNull();
  });

  test('returns null for success:false without a string error', () => {
    expect(parseEmbeddedFailure(JSON.stringify({ success: false }))).toBeNull();
    expect(parseEmbeddedFailure(JSON.stringify({ success: false, error: 123 }))).toBeNull();
  });

  test('returns null for non-JSON, empty, or undefined input', () => {
    expect(parseEmbeddedFailure('not json')).toBeNull();
    expect(parseEmbeddedFailure('')).toBeNull();
    expect(parseEmbeddedFailure(undefined)).toBeNull();
  });
});
