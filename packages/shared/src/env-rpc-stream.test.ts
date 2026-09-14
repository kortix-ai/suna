import { expect, test } from 'bun:test';
import { RpcStreamDecoder, readRpcResponse } from './env-rpc-stream';

test.each(['', '\n'])('rejects an oversized frame with terminator %j', (terminator) => {
  const decoder = new RpcStreamDecoder();
  expect(() =>
    decoder.push(
      JSON.stringify({
        type: 'progress',
        progress: { stream: 'stdout', chunk: 'x'.repeat(32 * 1024 * 1024) },
      }) + terminator,
    ),
  ).toThrow('RPC stream frame exceeds');
});

test('incremental RPC frames deliver progress before the terminal result', () => {
  const progress: unknown[] = [];
  const decoder = new RpcStreamDecoder((value) => progress.push(value));
  const line =
    JSON.stringify({ type: 'progress', progress: { stream: 'stdout', chunk: 'hello\n' } }) + '\n';
  for (const char of line) decoder.push(char);
  expect(progress).toEqual([{ stream: 'stdout', chunk: 'hello\n' }]);
  decoder.push(
    JSON.stringify({
      type: 'result',
      body: { ok: true, value: { stdout: 'hello\n', stderr: '', exitCode: 0 } },
    }) + '\n',
  );
  expect(decoder.finish()).toEqual({
    ok: true,
    value: { stdout: 'hello\n', stderr: '', exitCode: 0 },
  });
});

test.each([
  '',
  '{',
  '{"type":"progress","progress":{"stream":"stdin","chunk":"bad"}}\n',
  '{"type":"result","body":{"ok":true}}\n{"type":"progress","progress":{"stream":"stdout","chunk":"late"}}\n',
  '{"type":"result","body":{"ok":true}}\n{"type":"result","body":{"ok":true}}\n',
])('rejects malformed or unfinished RPC streams %j', (input) => {
  expect(() => {
    const decoder = new RpcStreamDecoder();
    decoder.push(input);
    decoder.finish();
  }).toThrow();
});

test('an older JSON response remains compatible without synthetic progress frames', async () => {
  const progress: unknown[] = [];
  const body = { ok: true, value: { stdout: 'legacy', stderr: '', exitCode: 0 } };
  expect(await readRpcResponse(Response.json(body), (value) => progress.push(value))).toEqual(body);
  expect(progress).toEqual([]);
});

test('stream decoding preserves multibyte text split between HTTP chunks', async () => {
  const bytes = new TextEncoder().encode(
    '{"type":"progress","progress":{"stream":"stdout","chunk":"😀"}}\n{"type":"result","body":{"ok":true}}\n',
  );
  const progress: unknown[] = [];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  );
  expect(await readRpcResponse(response, (value) => progress.push(value))).toEqual({ ok: true });
  expect(progress).toEqual([{ stream: 'stdout', chunk: '😀' }]);
});
