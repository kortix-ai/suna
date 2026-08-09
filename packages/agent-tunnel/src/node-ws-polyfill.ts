/**
 * WebSocket polyfill for Node.js < 22.
 * If global WebSocket is already available (Node 22+, Bun, browsers), this is a no-op.
 * Otherwise, it loads the `ws` package and assigns it to globalThis.WebSocket.
 */
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    const ws = await import('ws');
    const WebSocketImpl = ws.WebSocket ?? ws.default;
    globalThis.WebSocket = WebSocketImpl as unknown as typeof WebSocket;
  } catch {
    console.error(
      '[agent-tunnel] WebSocket is not available. Install the "ws" package or use Node.js 22+.',
    );
    process.exit(1);
  }
}

export {};
