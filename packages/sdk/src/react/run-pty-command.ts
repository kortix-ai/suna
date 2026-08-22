import {
  createKortixPty,
  getKortixPtyWebSocketUrl,
  removeKortixPty,
} from '../core/runtime/pty';
import { getActiveOpenCodeUrl } from '../browser/stores/server-store';

export async function runPtyCommand(
  command: string,
  options?: { timeoutMs?: number; title?: string },
): Promise<string> {
  const baseUrl = getActiveOpenCodeUrl();
  const pty = await createKortixPty(baseUrl, {
    command: '/bin/sh',
    args: ['-c', command],
    title: options?.title ?? '__sdk-command__',
  });
  const connectUrl = await getKortixPtyWebSocketUrl(pty.id, baseUrl);
  const timeoutMs = options?.timeoutMs ?? 15_000;

  try {
    return await new Promise<string>((resolve) => {
      const chunks: string[] = [];
      let settled = false;
      const socket = new WebSocket(connectUrl);
      socket.binaryType = 'arraybuffer';
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(chunks.join(''));
      };
      const timer = setTimeout(() => {
        socket.close();
        finish();
      }, timeoutMs);
      socket.onmessage = (event) => {
        chunks.push(
          event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : String(event.data),
        );
      };
      socket.onclose = finish;
      socket.onerror = finish;
    });
  } finally {
    void removeKortixPty(baseUrl, pty.id).catch(() => {});
  }
}
