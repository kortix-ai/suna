/**
 * Live harness for the terminal panel (SPEC §5.4). Not a unit test: it needs a
 * real API, a real token, and a real cloud sandbox, so `bun test` never runs
 * it.
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<pid> KORTIX_SESSION_ID=<sid> \
 *   bun run scripts/dev-terminal.tsx
 *
 * What it proves, in order:
 *   1. The panel reaches `Terminal · connected` against the session's sandbox.
 *   2. The remote shell's prompt paints inside `<embedded-terminal>`.
 *   3. A keystroke typed into the focused panel reaches the shell, and the
 *      shell's answer paints (a unique `TUI-PTY-<n>` marker, so the assertion
 *      cannot pass on output an earlier run left in the ambient shell).
 *   4. Dropping the socket moves the title to `reconnecting (1)` and then back
 *      to `connected` on its own.
 *
 * Exits 0 only when all four happened.
 */

import { useSession } from '@kortix/sdk/react';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { resolveHost } from '../src/auth/hosts.ts';
import { openPtyWebSocket } from '../src/features/terminal/open-socket.ts';
import type { PtySocket } from '../src/features/terminal/pty-session.ts';
import { TerminalPanel } from '../src/features/terminal/terminal-panel.tsx';
import { initKortix } from '../src/kortix.ts';

const WIDTH = Number(process.env.PROBE_WIDTH ?? 100);
const HEIGHT = Number(process.env.PROBE_HEIGHT ?? 30);
const READY_TIMEOUT_MS = Number(process.env.PROBE_READY_TIMEOUT_MS ?? 420_000);
const SHELL_TIMEOUT_MS = Number(process.env.PROBE_SHELL_TIMEOUT_MS ?? 120_000);
const MARKER = `TUI-PTY-${Math.floor(Math.random() * 1_000_000)}`;

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function banner(title: string): void {
  console.log(`\n===== ${stamp()} ${title} =====`);
}

const host = resolveHost();
if (!host) throw new Error('no host: set KORTIX_API_URL + KORTIX_API_KEY');
initKortix(host);

const projectId = process.env.KORTIX_PROJECT_ID?.trim();
const sessionId = process.env.KORTIX_SESSION_ID?.trim();
if (!projectId || !sessionId) throw new Error('set KORTIX_PROJECT_ID and KORTIX_SESSION_ID');

/** The live socket, so the probe can drop it and watch the panel recover. */
let liveSocket: PtySocket | null = null;
let socketsOpened = 0;
const captureSocket = (url: string): PtySocket => {
  socketsOpened += 1;
  liveSocket = openPtyWebSocket(url);
  return liveSocket;
};

function Harness() {
  const session = useSession(projectId as string, sessionId as string);
  return (
    <box width={WIDTH} height={HEIGHT} flexDirection="column">
      <TerminalPanel
        projectId={projectId as string}
        sessionId={sessionId as string}
        session={session}
        focused
        width={WIDTH}
        height={HEIGHT}
        onClose={() => console.log('[panel] onClose')}
        onToast={(message, kind) => console.log(`[toast:${kind ?? 'info'}] ${message}`)}
        openSocket={captureSocket}
      />
    </box>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 2 } },
});
const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
const root = createRoot(setup.renderer);
root.render(
  <QueryClientProvider client={queryClient}>
    <Harness />
  </QueryClientProvider>,
);

async function settle(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await setup.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForFrame(match: RegExp, timeoutMs: number, label: string): Promise<string> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    await setup.renderOnce();
    last = setup.captureCharFrame();
    if (match.test(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  banner(`TIMEOUT waiting for ${label}`);
  console.log(last);
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
}

await settle(1500);
banner('FRAME 0 — first paint');
console.log(setup.captureCharFrame());

const connected = await waitForFrame(/Terminal · connected/, READY_TIMEOUT_MS, 'connected');
banner('FRAME 1 — connected');
console.log(connected);

const prompt = await waitForFrame(/kortix@[^\s]*:[^\s]*[$#]/, SHELL_TIMEOUT_MS, 'a shell prompt');
banner('FRAME 2 — the remote shell prompt');
console.log(prompt);

// Type into the FOCUSED panel. The keys go through the same path a user's do:
// global dispatch → the focused EmbeddedTerminalRenderable → encodeKey →
// onData → the socket.
await setup.mockInput.typeText(`echo ${MARKER}`, 8);
await settle(400);
banner('FRAME 3 — the command typed into the shell');
console.log(setup.captureCharFrame());

setup.mockInput.pressEnter();
const echoed = await waitForFrame(
  new RegExp(`${MARKER}[\\s\\S]*${MARKER}`),
  SHELL_TIMEOUT_MS,
  `the shell to echo ${MARKER}`,
);
banner(`FRAME 4 — the shell answered ${MARKER}`);
console.log(echoed);

// Drop the socket the way a network does: an abrupt close, not a clean one.
// `close()` would be reported as code 1000 and classified as a finished shell.
banner('DROPPING THE SOCKET');
const socket = liveSocket as unknown as {
  terminate?: () => void;
  close: (c?: number, r?: string) => void;
};
if (typeof socket.terminate === 'function') socket.terminate();
else socket.close(4999, 'upstream error');

const reconnecting = await waitForFrame(
  /Terminal · reconnecting \(1\)/,
  30_000,
  'the panel to report reconnecting (1)',
);
banner('FRAME 5 — reconnecting (1)');
console.log(reconnecting);

const recovered = await waitForFrame(
  /Terminal · connected/,
  60_000,
  'the panel to reconnect on its own',
);
banner('FRAME 6 — connected again');
console.log(recovered);

banner('RESULT');
console.log(`sockets opened: ${socketsOpened}`);
console.log(`marker: ${MARKER}`);
console.log('OK — connected, prompt, keystroke round-trip, reconnect.');

root.unmount();
setup.renderer.destroy();
process.exit(0);
