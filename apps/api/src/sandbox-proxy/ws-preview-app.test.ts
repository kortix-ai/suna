import { afterEach, expect, test } from 'bun:test';
import * as proxy from './ws-proxy';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) server.stop(true);
});

test.each([true, false])('the preview preserves HMR messages with negotiated protocol=%s', async (offerProtocol) => {
  const app = Bun.serve({
    port: 0,
    fetch(req, server) {
      expect(req.headers.get('sec-websocket-protocol')).toBe(offerProtocol ? 'first, vite-hmr' : null);
      return server.upgrade(req, { headers: offerProtocol ? { 'Sec-WebSocket-Protocol': 'vite-hmr' } : undefined })
        ? undefined : new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws) { ws.send('connected'); },
      message(ws, message) { ws.send(message); },
    },
  });
  servers.push(app);
  const front = Bun.serve<proxy.PreviewWsData>({
    port: 0,
    async fetch(req, server) {
      const data: proxy.PreviewWsData = {
        type: 'preview-ws', url: `ws://localhost:${app.port}/`,
        headers: offerProtocol ? { 'sec-websocket-protocol': req.headers.get('sec-websocket-protocol')! } : {},
      };
      await proxy.connectPreviewAppWebSocket(data, req.signal);
      const headers = proxy.previewWsUpgradeHeaders(data);
      expect(headers).toEqual(offerProtocol ? { 'Sec-WebSocket-Protocol': 'vite-hmr' } : undefined);
      if (server.upgrade(req, { data, headers })) return;
      data.upstream?.close();
      return new Response('upgrade failed', { status: 400 });
    },
    websocket: proxy.previewWsHandlers,
  });
  servers.push(front);
  const received: string[] = [];
  const ws = new WebSocket(`ws://localhost:${front.port}/`, offerProtocol ? ['first', 'vite-hmr'] : []);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HMR messages not delivered')), 2000);
    ws.onopen = () => { expect(ws.protocol).toBe(offerProtocol ? 'vite-hmr' : ''); ws.send('update'); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
    ws.onmessage = event => {
      received.push(String(event.data));
      if (received.length === 2) { clearTimeout(timer); resolve(); }
    };
  });
  expect(received).toEqual(['connected', 'update']);
});
