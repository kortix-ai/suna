import { describe, expect, test } from 'bun:test';

import { fetchEventTransport } from './runtime-rest-client';

/**
 * The SSE message parser, pinned through the transport it serves (`fetchEventTransport`
 * yields one message per blank-line-terminated chunk). These pins hold for the
 * parser wherever it lives — the extraction of the per-chunk parse block must
 * not move any of them.
 */

/** Collect the messages a fake streaming body yields for `raw`. */
async function parse(raw: string): Promise<Array<{ id?: string; retry?: number; data?: string }>> {
  const body = new Response(raw).body;
  if (!body) throw new Error('a string body always streams');
  const stubFetch = (() => Promise.resolve(new Response(body))) as unknown as typeof fetch;
  const transport = fetchEventTransport(stubFetch);
  const messages = [];
  for await (const message of transport({ url: 'http://x', headers: new Headers(), signal: new AbortController().signal })) {
    messages.push(message);
  }
  return messages;
}

describe('the SSE message parser', () => {
  test('multi-line data joins with newlines into one message', async () => {
    const messages = await parse('data: one\ndata: two\n\n');
    expect(messages).toEqual([{ data: 'one\ntwo' }]);
  });

  test('a retry field that fails Number.parseInt is dropped; a numeric one is kept', async () => {
    expect(await parse('retry: soon\n\n')).toEqual([{}]);
    expect(await parse('retry: 2500\n\n')).toEqual([{ retry: 2500 }]);
  });

  test('an id-only message carries the id and no data', async () => {
    expect(await parse('id: 42\n\n')).toEqual([{ id: '42' }]);
  });

  test('a comment-only chunk yields a field-less message (it still proves liveness)', async () => {
    expect(await parse(': keepalive\n\n')).toEqual([{}]);
  });

  test('CRLF and lone CR normalize to LF before splitting', async () => {
    expect(await parse('data: a\r\ndata: b\r\n\r\n')).toEqual([{ data: 'a\nb' }]);
  });

  test('the data prefix strips the leading space after the colon', async () => {
    expect(await parse('data:   spaced\n\n')).toEqual([{ data: 'spaced' }]);
  });
});
