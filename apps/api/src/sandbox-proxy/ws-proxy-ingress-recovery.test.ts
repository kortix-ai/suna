import { afterEach, expect, spyOn, test } from 'bun:test';
import * as backend from './backend';
import { previewWsHandlers, type PreviewWsData } from './ws-proxy';

const originalWebSocket = globalThis.WebSocket;
let invalidation: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  invalidation?.mockRestore();
});

for (const event of ['error', 'close'] as const) {
  test(`a failed upstream handshake drops its cached ingress on ${event}`, () => {
    invalidation = spyOn(backend, 'invalidatePreviewLink').mockImplementation(() => {});
    let socket: any;
    globalThis.WebSocket = class {
      constructor() { socket = this; }
    } as any;
    const data: PreviewWsData = {
      type: 'preview-ws', url: 'wss://provider.test/kortix/pty/pty-1/connect', headers: {},
      ingress: { sandboxId: 'sandbox-1', port: 8000 },
    };
    previewWsHandlers.open({ data, close() {}, send() {} });
    if (event === 'error') socket.onerror();
    else socket.onclose({ code: 1006 });
    expect(invalidation).toHaveBeenCalledWith('sandbox-1', 8000);
  });
}

test('a clean established shell exit keeps the cached ingress', () => {
  invalidation = spyOn(backend, 'invalidatePreviewLink').mockImplementation(() => {});
  let socket: any;
  globalThis.WebSocket = class {
    constructor() { socket = this; }
  } as any;
  const data: PreviewWsData = {
    type: 'preview-ws', url: 'wss://provider.test/kortix/pty/pty-1/connect', headers: {},
    ingress: { sandboxId: 'sandbox-1', port: 8000 },
  };
  previewWsHandlers.open({ data, close() {}, send() {} });
  socket.onopen();
  socket.onclose({ code: 1000 });
  expect(invalidation).not.toHaveBeenCalled();
});
