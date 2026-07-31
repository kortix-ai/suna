/**
 * Open a PTY WebSocket with an explicit User-Agent.
 *
 * Bun's WebSocket client does not send User-Agent by default, and Cloudflare
 * rejects that handshake before it reaches the Kortix API. This is a Bun
 * runtime workaround, not Kortix transport: the URL (including its `?token=`
 * auth, which a WebSocket cannot send as a header) is resolved by the SDK's
 * `getKortixPtyWebSocketUrl`.
 */
export function openKortixPtyWebSocket(url: string): WebSocket {
  const version = process.env.KORTIX_CLI_VERSION ?? 'dev';
  const BunWebSocket = WebSocket as unknown as new (
    url: string | URL,
    options?: Bun.WebSocketOptions,
  ) => WebSocket;
  return new BunWebSocket(url, {
    headers: { 'User-Agent': `kortix-cli/${version}` },
  });
}
