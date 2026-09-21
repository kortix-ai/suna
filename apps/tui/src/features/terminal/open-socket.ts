/**
 * Open the PTY WebSocket with an explicit `User-Agent`.
 *
 * Bun's WebSocket client sends no `User-Agent`, and Cloudflare rejects that
 * handshake before it reaches the Kortix API. The workaround is
 * `apps/cli/src/api/pty-socket.ts`'s, verbatim; only the product name in the
 * header differs, so a deployment's logs can tell a TUI attach from a CLI one.
 *
 * This is the ONE raw transport `apps/tui` is allowed (SPEC §3): the URL,
 * including its `?token=` auth, is resolved by the SDK
 * (`getKortixPtyWebSocketUrl`) and never built here.
 */

import type { PtySocket } from './pty-session.ts';

export function ptyUserAgent(env: Record<string, string | undefined> = process.env): string {
  return `kortix-tui/${env.KORTIX_TUI_VERSION ?? 'dev'}`;
}

export function openPtyWebSocket(url: string): PtySocket {
  const BunWebSocket = WebSocket as unknown as new (
    url: string | URL,
    options?: Bun.WebSocketOptions,
  ) => WebSocket;
  return new BunWebSocket(url, {
    headers: { 'User-Agent': ptyUserAgent() },
  }) as unknown as PtySocket;
}
