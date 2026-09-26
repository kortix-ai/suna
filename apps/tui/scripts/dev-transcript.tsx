/**
 * Live transcript harness (wave 1). Not a unit test — it needs a real API, a
 * real token, and a real cloud sandbox, so `bun test` never runs it.
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<pid> KORTIX_SESSION_ID=<sid> \
 *     bun run scripts/dev-transcript.tsx "Run `ls -la /workspace`; reply FINISHED"
 *
 * It mounts the real `useSession` + `<Transcript/>` in OpenTUI's headless test
 * renderer, prints the captured frame text at each milestone, sends one prompt
 * through `session.send`, and exits 0 only once the transcript shows the
 * expected word. A single component owns the hook and passes it down, which is
 * exactly the shape `session-view.tsx` will have.
 *
 * Flags:
 *   --expect <word>   the string the final frame must contain (default FINISHED)
 *   --bench           run the markdown-vs-text streaming measurement instead
 */

import { useSession } from '@kortix/sdk/react';
import { SyntaxStyle } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { resolveHost } from '../src/auth/hosts.ts';
import { Transcript } from '../src/features/session/transcript/index.ts';
import { initKortix } from '../src/kortix.ts';

const args = process.argv.slice(2);
const BENCH = args.includes('--bench');
const expectIndex = args.indexOf('--expect');
const EXPECT = expectIndex >= 0 ? (args[expectIndex + 1] ?? 'FINISHED') : 'FINISHED';
const PROMPT =
  args.find((arg) => !arg.startsWith('--') && arg !== EXPECT) ??
  'Run `ls -la /workspace` and then `echo done`; reply with the word FINISHED.';

const READY_TIMEOUT_MS = Number(process.env.PROBE_READY_TIMEOUT_MS ?? 600_000);
const STREAM_TIMEOUT_MS = Number(process.env.PROBE_STREAM_TIMEOUT_MS ?? 300_000);

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function banner(title: string): void {
  console.log(`\n===== ${stamp()} ${title} =====`);
}

// ---------------------------------------------------------------------------
// --bench: the measurement behind the `<markdown>` decision in text-part.tsx
// ---------------------------------------------------------------------------

async function bench(): Promise<never> {
  const { testRender } = await import('@opentui/react/test-utils');
  const { act } = await import('react');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const style = SyntaxStyle.create();
  const words =
    'The quick brown fox jumps over the lazy dog. **Bold** text, `code`, and a list item. '
      .repeat(20)
      .split(' ');

  function Harness({ mode, onDone }: { mode: 'markdown' | 'text'; onDone: (ms: number) => void }) {
    const [count, setCount] = useState(1);
    const [start] = useState(() => performance.now());
    useEffect(() => {
      if (count < words.length) {
        const timer = setTimeout(() => setCount(count + 1), 0);
        return () => clearTimeout(timer);
      }
      onDone(performance.now() - start);
    }, [count, onDone, start]);
    const content = words.slice(0, count).join(' ');
    return mode === 'markdown' ? (
      <markdown content={content} syntaxStyle={style} streaming width={80} />
    ) : (
      <text wrapMode="word">{content}</text>
    );
  }

  async function run(mode: 'markdown' | 'text'): Promise<number> {
    let ms = -1;
    const { flush, renderer } = await testRender(
      <Harness
        mode={mode}
        onDone={(value) => {
          ms = value;
        }}
      />,
      { width: 80, height: 30 },
    );
    const until = Date.now() + 120_000;
    while (ms < 0 && Date.now() < until) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await flush();
    }
    renderer.destroy();
    return ms;
  }

  for (const mode of ['text', 'markdown', 'text', 'markdown'] as const) {
    const ms = await run(mode);
    console.log(
      `${mode.padEnd(9)} ${words.length} content updates in ${ms.toFixed(0)}ms → ` +
        `${(ms / words.length).toFixed(2)}ms/update`,
    );
  }
  process.exit(0);
}

if (BENCH) await bench();

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

const host = resolveHost();
if (!host) throw new Error('no host: set KORTIX_API_URL + KORTIX_API_KEY');
initKortix(host);

const projectId = process.env.KORTIX_PROJECT_ID?.trim();
const sessionId = process.env.KORTIX_SESSION_ID?.trim();
if (!projectId || !sessionId) throw new Error('set KORTIX_PROJECT_ID and KORTIX_SESSION_ID');

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 2 } },
});

/**
 * What the harness last saw. `assistantText` and `toolCalls` are read from the
 * SESSION, never from the captured frame: the frame also holds the user's own
 * prompt, so a frame-text assertion for the expected word passed the instant
 * the prompt echoed — before the agent had answered anything. Assert on the
 * data, print the frame.
 */
const live = {
  phase: '',
  messages: 0,
  busy: false,
  assistantText: '',
  toolCalls: 0,
  send: null as ((t: string) => void) | null,
};

/**
 * The shape `session-view.tsx` will have: ONE `useSession`, handed down.
 * The harness reads a few fields for its own logging; the transcript renders.
 */
function Harness() {
  const session = useSession(projectId as string, sessionId as string);
  live.phase = session.phase;
  live.messages = session.messages.length;
  live.busy = session.isBusy;
  live.assistantText = session.messages
    .filter((entry) => entry.info.role === 'assistant')
    .flatMap((entry) => entry.parts)
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text?: string }).text ?? '')
    .join('\n');
  live.toolCalls = session.messages
    .flatMap((entry) => entry.parts)
    .filter((part) => part.type === 'tool').length;
  live.send = (text: string) => {
    void session.send(text);
  };
  return (
    <box flexDirection="column" width={100} height={34} padding={1}>
      <text>{`phase ${session.phase} · stage ${session.stage ?? '-'} · messages ${session.messages.length}`}</text>
      <Transcript session={session} focused width={96} height={30} />
    </box>
  );
}

const setup = await createTestRenderer({ width: 100, height: 36 });
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

async function waitFor(done: () => boolean, timeoutMs: number, label: string): Promise<string> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    await setup.renderOnce();
    last = setup.captureCharFrame();
    if (done()) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  banner(`TIMEOUT waiting for ${label}`);
  console.log(last);
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
}

await settle(3000);
banner('FRAME 0 — first paint');
console.log(setup.captureCharFrame());

const ready = await waitFor(() => live.phase === 'ready', READY_TIMEOUT_MS, 'phase ready');
banner('FRAME 1 — phase ready');
console.log(ready);

live.send?.(PROMPT);
await settle(4000);
banner('FRAME 2 — prompt sent, first stream frames');
console.log(setup.captureCharFrame());

await waitFor(() => live.toolCalls > 0, STREAM_TIMEOUT_MS, 'a tool call');
banner('FRAME 3 — a tool call');
console.log(setup.captureCharFrame());

const done = await waitFor(
  () => live.assistantText.includes(EXPECT),
  STREAM_TIMEOUT_MS,
  `an ASSISTANT text part containing "${EXPECT}"`,
);
banner(`FRAME 4 — the assistant reply contains "${EXPECT}"`);
console.log(done);

await settle(4000);
banner('FRAME 5 — final (idle)');
console.log(setup.captureCharFrame());

// Prove the collapse toggle on the real transcript, not only in tests: Enter
// with no cursor opens the NEWEST collapsible row.
setup.mockInput.pressEnter();
await settle(2000);
banner('FRAME 6 — Enter expanded the newest collapsible row');
console.log(setup.captureCharFrame());

setup.mockInput.pressEnter();
await settle(2000);
banner('FRAME 7 — Enter collapsed it again');
console.log(setup.captureCharFrame());

// `K` walks the cursor back to the previous collapsible row — the steps group.
setup.mockInput.pressKey('K');
setup.mockInput.pressEnter();
await settle(2000);
banner('FRAME 8 — K then Enter expanded the steps group');
console.log(setup.captureCharFrame());

root.unmount();
setup.renderer.destroy();
process.exit(0);
