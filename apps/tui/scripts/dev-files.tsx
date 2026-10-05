/**
 * Live harness for `features/files` (wave 2). Not a unit test — it needs a real
 * API, a real token and a real cloud sandbox, so `bun test` never runs it.
 *
 * Headless, printing the captured frames:
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<pid> KORTIX_SESSION_ID=<sid> \
 *   bun run scripts/dev-files.tsx
 *
 * Interactive, in this terminal (Ctrl+C quits):
 *
 *   … bun run scripts/dev-files.tsx --interactive
 *
 * Without `KORTIX_SESSION_ID` the harness takes the most recent session of the
 * project. The session's sandbox must be running: `files.list` awaits
 * `ensureReady()`, and a cold box takes minutes.
 */

import { createCliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { resolveHost } from '../src/auth/hosts.ts';
import { ALWAYS_VISIBLE_DOTFILES, FilesScreen } from '../src/features/files/index.ts';
import { initKortix, kortix } from '../src/kortix.ts';

const INTERACTIVE = process.argv.includes('--interactive');
const WIDTH = Number(process.env.FILES_WIDTH ?? 100);
const HEIGHT = Number(process.env.FILES_HEIGHT ?? 30);

function banner(title: string): void {
  console.log(`\n===== ${new Date().toISOString().slice(11, 19)} ${title} =====`);
}

const host = resolveHost();
if (!host) throw new Error('no host: set KORTIX_API_URL + KORTIX_API_KEY');
initKortix(host);

const projects = await kortix().projects.list();
const projectId = process.env.KORTIX_PROJECT_ID?.trim() || projects[0]?.project_id;
if (!projectId) throw new Error('no project visible to this token');

let sessionId = process.env.KORTIX_SESSION_ID?.trim();
if (!sessionId) {
  const page = await kortix().project(projectId).sessions.listPage({ limit: 5 });
  sessionId = page.items[0]?.session_id;
}
if (!sessionId) throw new Error('no session in this project');
console.log(`host=${host.backendUrl} project=${projectId} session=${sessionId}`);

const start = await kortix().session(projectId, sessionId).start();
console.log(`/start stage=${start?.stage ?? '?'} sandbox=${start?.sandbox?.external_id ?? '?'}`);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const toasts: string[] = [];

function Harness() {
  return (
    <QueryClientProvider client={queryClient}>
      <FilesScreen
        projectId={projectId as string}
        sessionId={sessionId as string}
        focused
        width={WIDTH}
        height={HEIGHT}
        onBack={() => console.log('[onBack]')}
        onToast={(message, kind) => {
          toasts.push(`${kind ?? 'info'}: ${message}`);
          console.log(`[toast/${kind ?? 'info'}] ${message}`);
        }}
      />
    </QueryClientProvider>
  );
}

if (INTERACTIVE) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(<Harness />);
} else {
  // The SDK's own answer first, so every frame assertion below has a baseline
  // that does not depend on what was rendered.
  const rootListing = await kortix().session(projectId, sessionId).files.list('/workspace');
  console.log(
    `SDK files.list('/workspace') → ${rootListing.length} nodes: ${rootListing
      .map((node) => `${node.type === 'directory' ? 'd' : 'f'} ${node.name}`)
      .join(', ')}`,
  );
  // The screen hides dot entries by default (`.kortix`/`.opencode` exempt), so
  // the walk below targets the rows that are actually on screen.
  const onScreenNodes = rootListing.filter(
    (node) => !node.name.startsWith('.') || ALWAYS_VISIBLE_DOTFILES.has(node.name),
  );
  const firstDirectory = onScreenNodes.find((node) => node.type === 'directory');
  const firstFile = onScreenNodes.find((node) => node.type === 'file');

  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const root = createRoot(setup.renderer);
  root.render(<Harness />);

  const settle = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await setup.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  };
  const frame = () => setup.captureCharFrame();
  const lines = () => frame().split('\n');
  const cursorRow = () =>
    lines()
      .find((line) => line.startsWith('▌'))
      ?.trimEnd() ?? '';
  const press = async (key: string, ms = 400) => {
    setup.mockInput.pressKey(key);
    await settle(ms);
  };
  /** Move the cursor down until it is on `name`, or give up after every row. */
  const walkTo = async (name: string) => {
    await press('g', 250);
    for (let step = 0; step < 40; step += 1) {
      if (cursorRow().includes(name)) return true;
      await press('j', 160);
    }
    return false;
  };

  await settle(6000);
  banner('FRAME 1 — /workspace listed from the real sandbox (dot entries hidden)');
  console.log(frame());
  const hiddenNames = rootListing
    .filter((node) => node.name.startsWith('.') && !ALWAYS_VISIBLE_DOTFILES.has(node.name))
    .map((node) => node.name);
  console.log(
    `dot entries hidden: ${JSON.stringify(hiddenNames)} — on screen: ${hiddenNames.filter((name) => frame().includes(name)).length}`,
  );

  await press('.', 600);
  banner('FRAME 2 — after . (dot entries shown)');
  console.log(frame());
  console.log(
    `dot entries now on screen: ${hiddenNames.filter((name) => frame().includes(name)).length}/${hiddenNames.length}`,
  );
  await press('.', 600);

  if (firstDirectory) {
    const landed = await walkTo(firstDirectory.name);
    console.log(`cursor before expand (landed=${landed}): ${JSON.stringify(cursorRow())}`);
    setup.mockInput.pressEnter();
    await settle(6000);
    banner(`FRAME 3 — ${firstDirectory.name}/ expanded`);
    console.log(frame());
    const childListing = await kortix()
      .session(projectId, sessionId)
      .files.list(firstDirectory.path);
    console.log(
      `SDK files.list('${firstDirectory.path}') → ${childListing.length} nodes: ${childListing
        .map((node) => node.name)
        .slice(0, 12)
        .join(', ')}`,
    );
    const onScreen = childListing.filter((node) => frame().includes(node.name)).length;
    console.log(
      `children of ${firstDirectory.name} visible on screen: ${onScreen}/${childListing.length}`,
    );
    await press('h', 600);
  }

  if (firstFile) {
    const landed = await walkTo(firstFile.name);
    console.log(`cursor before open (landed=${landed}): ${JSON.stringify(cursorRow())}`);
    setup.mockInput.pressEnter();
    await settle(6000);
    banner(`FRAME 4 — ${firstFile.name} in the viewer`);
    console.log(frame());

    const content = await kortix().session(projectId, sessionId).files.read(firstFile.path);
    const head = (content.content ?? '').split('\n')[0] ?? '';
    console.log(
      `SDK files.read('${firstFile.path}') → type=${content.type} bytes=${(content.content ?? '').length} first line=${JSON.stringify(head.slice(0, 60))}`,
    );
    console.log(`first line is on screen: ${frame().includes(head.slice(0, 40))}`);

    await press('J', 700);
    banner('FRAME 5 — after J (viewer page down)');
    console.log(frame());

    await press('y', 900);
    banner('FRAME 6 — after y (copy the path)');
    console.log(frame());
  }

  banner('SUMMARY');
  console.log(JSON.stringify({ projectId, sessionId, toasts }, null, 2));

  root.unmount();
  setup.renderer.destroy();
  process.exit(0);
}
