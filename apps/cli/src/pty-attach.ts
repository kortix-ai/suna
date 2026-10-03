import { classifyPtyClose, getKortixPtyWebSocketUrl, sanitizePtyChunk, updateKortixPty } from '@kortix/sdk';

import { openKortixPtyWebSocket } from './api/pty-socket.ts';
import { withKortixScope } from './api/sdk.ts';
import type { Auth } from './api/auth.ts';
import { C, status } from './style.ts';

/** Backoff for transport loss. The daemon keeps the PTY alive across a
 *  disconnect and replays its scrollback on the next attach. */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

export interface PtyAttachResult {
  /** The remote process's exit code, or null when it did not end (the PTY was
   *  lost, or every reconnect failed). */
  exitCode: number | null;
}

/** `pty exited (<code>)` is the daemon's close reason for a finished process. */
export function exitCodeFromCloseReason(reason: string): number | null {
  const m = /pty exited \((-?\d+)\)/i.exec(reason);
  return m ? Number(m[1]) : null;
}

/**
 * Attach the local terminal to a remote PTY, ssh-style. A TTY gets raw mode
 * and resize forwarding; a pipe (a script, another agent) gets plain bytes, so
 * `kortix run -- <cmd>` composes in shell pipelines. Reconnects on transport
 * loss and resolves with the remote exit code.
 */
export async function attachPty(
  auth: Auth,
  runtimeUrl: string,
  ptyId: string,
  opts: { goByte?: boolean } = {},
): Promise<PtyAttachResult> {
  // `goByte`: send one byte on the FIRST open only — a process gated on
  // `read -n 1` starts once the client is listening (see run.ts).
  let goPending = opts.goByte === true;
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // One decoder for the whole stream: a multi-byte character split across two
  // frames must not render as two replacement characters.
  const decoder = new TextDecoder();
  let ws: WebSocket | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  const resizeTo = (rows: number, cols: number) =>
    withKortixScope(auth, async () => updateKortixPty(runtimeUrl, ptyId, { size: { rows, cols } })).catch(() => {});
  const sendResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void resizeTo(process.stdout.rows, process.stdout.columns), 100);
  };
  const onStdinData = (chunk: Buffer) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(chunk);
  };

  let rawModeOn = false;
  const cleanup = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    process.stdout.removeListener('resize', sendResize);
    process.stdin.removeListener('data', onStdinData);
    if (rawModeOn) {
      process.stdin.setRawMode(false);
      rawModeOn = false;
    }
    process.stdin.pause();
  };
  // Restore the terminal on any exit path: a terminal left in raw mode looks broken.
  process.once('exit', cleanup);

  const write = (bytes: Uint8Array) => {
    const text = sanitizePtyChunk(decoder.decode(bytes, { stream: true }));
    if (text) process.stdout.write(text);
  };

  const dial = (wake: boolean) =>
    new Promise<{ code: number; reason: string; hadError: boolean; opened: boolean }>((resolve) => {
      void withKortixScope(auth, async () => getKortixPtyWebSocketUrl(ptyId, runtimeUrl, { wake })).then(
        (url) => {
          let hadError = false;
          let opened = false;
          ws = openKortixPtyWebSocket(url);
          ws.binaryType = 'arraybuffer';
          ws.onopen = () => {
            opened = true;
            if (goPending) {
              ws?.send('\r');
              goPending = false;
            }
            if (tty && !rawModeOn) {
              process.stdin.setRawMode(true);
              rawModeOn = true;
            }
            process.stdin.resume();
            process.stdin.removeListener('data', onStdinData);
            process.stdin.on('data', onStdinData);
            if (tty) {
              process.stdout.removeListener('resize', sendResize);
              process.stdout.on('resize', sendResize);
              sendResize();
            }
          };
          ws.onmessage = (event: MessageEvent) => {
            const data = event.data;
            if (typeof data === 'string') write(new TextEncoder().encode(data));
            else if (data instanceof ArrayBuffer) write(new Uint8Array(data));
          };
          ws.onerror = () => {
            hadError = true;
          };
          ws.onclose = (event: CloseEvent) =>
            resolve({ code: event.code, reason: event.reason ?? '', hadError, opened });
        },
        () => resolve({ code: 1006, reason: 'could not resolve terminal url', hadError: true, opened: false }),
      );
    });

  try {
    let attempt = 0;
    let wake = true;
    for (;;) {
      const closed = await dial(wake);
      if (closed.opened) {
        attempt = 0;
        wake = false;
      }
      const action = classifyPtyClose(closed);
      if (action === 'ended') return { exitCode: exitCodeFromCloseReason(closed.reason) ?? 0 };
      if (action === 'replace') {
        process.stderr.write(`\n${status.err('The terminal is gone (the sandbox restarted).')}\n`);
        return { exitCode: null };
      }
      const delay = RECONNECT_DELAYS_MS[attempt];
      if (delay === undefined) {
        process.stderr.write(`\n${status.err('Lost the connection to the sandbox.')}\n`);
        return { exitCode: null };
      }
      if (rawModeOn) {
        process.stdin.setRawMode(false);
        rawModeOn = false;
      }
      process.stderr.write(`\r\n${C.dim}Connection lost — reconnecting…${C.reset}\r\n`);
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
  }
}
