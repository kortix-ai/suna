/**
 * Live harness for `features/review` (wave 2). Not a unit test — it needs a
 * real API and a real token, so `bun test` never runs it.
 *
 * Headless, printing the captured frames:
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<pid> bun run scripts/dev-review.tsx
 *
 * Interactive, in this terminal (Ctrl+C quits):
 *
 *   … bun run scripts/dev-review.tsx --interactive
 *
 * The harness NEVER merges or closes anything: `m` and `x` only open the
 * confirm, and the confirm is left with Esc. `--write` is deliberately not a
 * flag — a merge writes to a real repository.
 */

import { createCliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { resolveHost } from '../src/auth/hosts.ts';
import { ReviewScreen } from '../src/features/review/index.ts';
import { initKortix, kortix } from '../src/kortix.ts';

const INTERACTIVE = process.argv.includes('--interactive');
const WIDTH = Number(process.env.REVIEW_WIDTH ?? 100);
const HEIGHT = Number(process.env.REVIEW_HEIGHT ?? 30);

function banner(title: string): void {
  console.log(`\n===== ${new Date().toISOString().slice(11, 19)} ${title} =====`);
}

const host = resolveHost();
if (!host) throw new Error('no host: set KORTIX_API_URL + KORTIX_API_KEY');
initKortix(host);

const projects = await kortix().projects.list();
const projectId = process.env.KORTIX_PROJECT_ID?.trim() || projects[0]?.project_id;
if (!projectId) throw new Error('no project visible to this token');
const project = projects.find((entry) => entry.project_id === projectId);
console.log(`host=${host.backendUrl} project=${projectId} (${project?.name ?? '?'})`);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const toasts: string[] = [];
const openedSessions: string[] = [];

function Harness() {
  return (
    <QueryClientProvider client={queryClient}>
      <ReviewScreen
        projectId={projectId as string}
        focused
        width={WIDTH}
        height={HEIGHT}
        onBack={() => console.log('[onBack]')}
        onOpenSession={(sessionId) => {
          openedSessions.push(sessionId);
          console.log(`[onOpenSession] ${sessionId}`);
        }}
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
  // The SDK's own answer first, as the baseline for every frame below.
  const listed = await kortix().project(projectId).changeRequests.list();
  console.log(`SDK changeRequests.list() → ${listed.change_requests.length} open`);
  for (const cr of listed.change_requests.slice(0, 6)) {
    console.log(`  #${cr.number} ${cr.status} → ${cr.base_ref} — ${cr.title.slice(0, 50)}`);
  }

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
  const press = async (key: string, ms = 400) => {
    setup.mockInput.pressKey(key);
    await settle(ms);
  };
  const pressEscape = async () => {
    setup.mockInput.pressEscape();
    await settle(500);
  };

  await settle(4000);
  banner('FRAME 1 — change requests from the live API');
  console.log(frame());

  // Walk to the first change request whose diff has files.
  let opened: string | null = null;
  for (const cr of listed.change_requests) {
    const diff = await kortix().project(projectId).changeRequests.diff(cr.cr_id);
    console.log(
      `SDK diff(#${cr.number}) → ${diff.files_changed} files, +${diff.additions} -${diff.deletions}, patch ${diff.patch.length} bytes`,
    );
    if (diff.files_changed > 0) {
      opened = cr.cr_id;
      break;
    }
    await press('j', 250);
  }

  if (opened) {
    setup.mockInput.pressEnter();
    await settle(6000);
    banner('FRAME 2 — the real diff, unified');
    console.log(frame());

    await press('J', 900);
    banner('FRAME 3 — the first file scrolled one page (J)');
    console.log(frame());
    await press('K', 900);

    await press('s', 900);
    banner('FRAME 4 — the same diff, split');
    console.log(frame());

    await press('s', 900);
    await press('n', 900);
    banner('FRAME 5 — next file (n)');
    console.log(frame());

    await pressEscape();
    banner('FRAME 6 — back on the list (Esc)');
    console.log(frame());
  } else {
    console.log('no change request in this project has a non-empty diff');
  }

  // The read-only paths: `a` explains, `m` only opens the confirm, Esc leaves.
  await press('a', 400);
  await press('m', 600);
  banner('FRAME 7 — the merge confirm (NOT confirmed)');
  console.log(frame());
  await pressEscape();
  await press('o', 500);

  banner('SUMMARY');
  console.log(JSON.stringify({ projectId, toasts, openedSessions }, null, 2));

  root.unmount();
  setup.renderer.destroy();
  process.exit(0);
}
