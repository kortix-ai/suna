/**
 * Live composer harness. Not a unit test — it needs a real API, a real token
 * and a real cloud sandbox, so `bun test` never runs it.
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<pid> KORTIX_SESSION_ID=<sid> \
 *   bun run scripts/dev-composer.tsx "say hello in five words"
 *
 * It mounts the real `useSession` plus the real `<Composer>` and a five-line
 * transcript tail in OpenTUI's headless renderer, then drives the composer with
 * mocked keys and prints the captured frames at each milestone:
 *
 *   FRAME 1  ready
 *   FRAME 2  the prompt typed into the composer
 *   FRAME 3  after Enter
 *   FRAME 4  the assistant's reply in the tail
 *   FRAME 5  the `/` palette, listing the project's REAL runtime commands
 *   FRAME 6  the model picker, listing the REAL catalog grouped by provider
 *   FRAME 7  after picking a model — the footer states it
 *   FRAME 8  the pick re-read from the SDK store (persistence proof)
 *   FRAME 9  a slow turn running
 *   FRAME 10 a second Enter while busy — `queued N`, plus the SERVER inbox row
 *   FRAME 11 Esc Esc stopped the run
 *
 * Exit 0 only when the reply contains `PROBE_EXPECT` and the model pick was
 * read back. `KORTIX_TUI_STEPS` narrows the run (`send`, `pickers`, `queue`,
 * `all`).
 */

import { type UseSessionResult, useSession } from '@kortix/sdk/react';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';

import { resolveHost } from '../src/auth/hosts.ts';
import { Composer } from '../src/features/session/composer/composer.tsx';
import { initKortix } from '../src/kortix.ts';
import { lastTextMessage, messageText, oneLine } from '../src/lib/transcript-view.ts';
import { theme } from '../src/theme.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROMPT = process.argv[2] ?? 'Reply with exactly: COMPOSER-OK';
const EXPECT = process.env.PROBE_EXPECT ?? 'COMPOSER-OK';
const STEPS = process.env.KORTIX_TUI_STEPS ?? 'all';
const READY_TIMEOUT_MS = Number(process.env.PROBE_READY_TIMEOUT_MS ?? 420_000);
const STREAM_TIMEOUT_MS = Number(process.env.PROBE_STREAM_TIMEOUT_MS ?? 240_000);

function banner(title: string): void {
  console.log(`\n===== ${new Date().toISOString().slice(11, 19)} ${title} =====`);
}

const host = resolveHost();
if (!host) throw new Error('no host: set KORTIX_API_URL + KORTIX_API_KEY');
initKortix(host);

const projectId = process.env.KORTIX_PROJECT_ID?.trim();
const sessionId = process.env.KORTIX_SESSION_ID?.trim();
if (!projectId || !sessionId) throw new Error('set KORTIX_PROJECT_ID and KORTIX_SESSION_ID');

/**
 * The last observed session state, so the script can assert on SDK values.
 *
 * Read through `latest()`: a plain `let` assigned only inside the component
 * narrows to `never` at the top level, because TypeScript's control-flow
 * analysis cannot see the render that writes it.
 */
let observed: UseSessionResult | null = null;
function latest(): UseSessionResult | null {
  return observed;
}

function Harness() {
  const session = useSession(projectId as string, sessionId as string);
  observed = session;
  const tail = lastTextMessage(session.messages as never);
  const tailText = tail ? messageText(tail) : '';
  const lines =
    oneLine(tailText, 60 * 5)
      .match(/.{1,60}/g)
      ?.slice(-5) ?? [];

  return (
    <box flexDirection="column" width={80} height={30} backgroundColor={theme.bg}>
      <text fg={theme.dim}>
        {`phase ${session.phase} · messages ${session.messages.length} · busy ${session.isBusy}`}
      </text>
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        {lines.length === 0 ? (
          <text fg={theme.faint}>No text parts yet.</text>
        ) : (
          lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length tail
            <text key={index} fg={theme.fg}>
              {`${tail?.info.role ?? ''}: ${line}`}
            </text>
          ))
        )}
      </box>
      <Composer
        session={session}
        projectId={projectId as string}
        sessionId={sessionId as string}
        focused
        width={80}
        onCommand={(command) => console.log(`[onCommand] ${command}`)}
        onToast={(message, kind) => console.log(`[toast:${kind ?? 'info'}] ${message}`)}
      />
    </box>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 2 } },
});
const setup = await createTestRenderer({ width: 80, height: 30 });
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  banner(`TIMEOUT waiting for ${label}`);
  console.log(last);
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
}

async function type(text: string): Promise<void> {
  await act(async () => {
    await setup.mockInput.typeText(text, 5);
  });
  await setup.renderOnce();
}

async function press(run: () => void, waitMs = 150): Promise<void> {
  await act(async () => {
    run();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  });
  await setup.renderOnce();
}

await settle(2000);
const readyFrame = await waitForFrame(/phase ready/, READY_TIMEOUT_MS, 'phase ready');
banner('FRAME 1 — ready');
console.log(readyFrame);

if (STEPS === 'all' || STEPS === 'send') {
  await type(PROMPT);
  banner('FRAME 2 — prompt typed into the composer');
  console.log(setup.captureCharFrame());

  await press(() => setup.mockInput.pressEnter(), 800);
  banner('FRAME 3 — after Enter');
  console.log(setup.captureCharFrame());

  const escaped = EXPECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const streamed = await waitForFrame(
    new RegExp(`assistant: .*${escaped}`),
    STREAM_TIMEOUT_MS,
    `an assistant reply containing "${EXPECT}"`,
  );
  banner('FRAME 4 — the reply streamed into the tail');
  console.log(streamed);
}

if (STEPS === 'all' || STEPS === 'pickers') {
  await type('/');
  banner("FRAME 5 — the / palette with the project's real runtime commands");
  console.log(setup.captureCharFrame());
  await press(() => setup.mockInput.pressEscape(), 250);

  await press(() => setup.mockInput.pressKey('m', { meta: true }), 250);
  banner('FRAME 6 — the model picker, real catalog grouped by provider');
  console.log(setup.captureCharFrame());

  const before = latest()?.picks.model ?? null;
  console.log(`picks.model BEFORE = ${JSON.stringify(before)}`);

  // Take the row below the first, so the pick is always a CHANGE.
  await press(() => setup.mockInput.pressArrow('down'), 120);
  await press(() => setup.mockInput.pressEnter(), 400);
  banner('FRAME 7 — after picking a model, the footer states it');
  console.log(setup.captureCharFrame());

  await settle(500);
  const after = latest()?.picks.model ?? null;
  console.log(`picks.model AFTER  = ${JSON.stringify(after)}`);
  if (!after) throw new Error('the model pick did not reach session.picks');
  if (before && after.modelID === before.modelID) {
    throw new Error('the model pick did not change');
  }

  // Re-open the picker: the SDK store is re-read, so the pick must still be
  // there and marked. That is the persistence proof, not the React state.
  await press(() => setup.mockInput.pressKey('m', { meta: true }), 250);
  const reopened = setup.captureCharFrame();
  banner('FRAME 8 — the pick re-read from the SDK store on reopen');
  console.log(reopened);
  if (!reopened.includes('●')) throw new Error('the reopened picker does not mark the pick');
  await press(() => setup.mockInput.pressEscape(), 250);
}

if (STEPS === 'all' || STEPS === 'queue') {
  // Start a slow turn, then press Enter again while it runs. The second prompt
  // must go to the SERVER inbox, not straight at the runtime, and the footer
  // must read it back as `queued N`.
  await type('Count slowly from 1 to 40, one number per line.');
  await press(() => setup.mockInput.pressEnter(), 800);
  await waitForFrame(/busy true/, 60_000, 'the first turn to start');
  banner('FRAME 9 — the first turn is running');
  console.log(setup.captureCharFrame());

  await type('QUEUED-SECOND');
  await press(() => setup.mockInput.pressEnter(), 1200);
  const queuedFrame = await waitForFrame(/queued \d/, 60_000, 'the footer to read `queued N`');
  banner('FRAME 10 — the second prompt went to the durable inbox');
  console.log(queuedFrame);

  const inbox = await fetch(
    `${host.backendUrl}/projects/${projectId}/sessions/${sessionId}/prompts`,
    { headers: { Authorization: `Bearer ${host.token}` } },
  ).then((response) => response.json() as Promise<{ prompts?: unknown[] }>);
  console.log(`server inbox rows = ${JSON.stringify(inbox).slice(0, 400)}`);

  await press(() => setup.mockInput.pressEscape(), 250);
  await press(() => setup.mockInput.pressEscape(), 2000);
  banner('FRAME 11 — Esc Esc stopped the run');
  console.log(setup.captureCharFrame());
}

banner('DONE');
root.unmount();
setup.renderer.destroy();
process.exit(0);
