/**
 * Live harness for `features/sidebar` (wave 1). Not a unit test — it needs a
 * real API and a real token, so `bun test` never runs it.
 *
 * Headless, printing the captured frames and the callback payloads:
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   bun run scripts/dev-sidebar.tsx
 *
 * Interactive, in this terminal (Ctrl+C quits):
 *
 *   KORTIX_API_URL=… KORTIX_API_KEY=… bun run scripts/dev-sidebar.tsx --interactive
 *
 * `--create` additionally presses `n`, which creates a REAL session and
 * provisions a REAL cloud sandbox. It is off by default so a re-run is free.
 *
 * `KORTIX_PROJECT_ID` pins the project; without it the harness takes the first
 * project the token can see.
 */

import { createCliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { resolveHost } from '../src/auth/hosts.ts';
import { Sidebar } from '../src/features/sidebar/index.ts';
import { initKortix, kortix } from '../src/kortix.ts';
import { sessionActivityMs } from '../src/lib/session-groups.ts';
import { Panel } from '../src/ui/index.ts';

const INTERACTIVE = process.argv.includes('--interactive');
const ALLOW_CREATE = process.argv.includes('--create');
const WIDTH = 30;
const HEIGHT = Number(process.env.SIDEBAR_HEIGHT ?? 46);

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
const accountId = project?.account_id ?? host.accountId ?? null;
console.log(
  `host=${host.backendUrl} project=${projectId} (${project?.name ?? '?'}) account=${accountId}`,
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const opened: string[] = [];
const created: string[] = [];
const toasts: string[] = [];
let selectedSessionId: string | null = null;

/** `SIDEBAR_NO_PANEL=1` drops the bordered wrapper. `ui/panel.tsx` sets
 *  `overflow: hidden`, which clips anything a descendant draws outside the
 *  column — including a centered `Modal`/`Picker` — so this flag isolates
 *  whether a clipped overlay is the panel's doing. */
const NO_PANEL = process.env.SIDEBAR_NO_PANEL === '1';

function Harness() {
  const body = (
    <Sidebar
      host={host as NonNullable<typeof host>}
      accountId={accountId}
      projectId={projectId as string}
      selectedSessionId={selectedSessionId}
      focused
      width={WIDTH}
      height={HEIGHT}
      onOpenSession={(id) => {
        selectedSessionId = id;
        opened.push(id);
        console.log(`[onOpenSession] ${id}`);
      }}
      onNewSession={(id) => {
        created.push(id);
        console.log(`[onNewSession] ${id}`);
      }}
      onNavigate={(screen) => console.log(`[onNavigate] ${screen}`)}
      onProjectChange={(pid, aid) => console.log(`[onProjectChange] ${pid} ${aid}`)}
      onAccountChange={(aid) => console.log(`[onAccountChange] ${aid}`)}
      onAttach={(id) => console.log(`[onAttach] ${id}`)}
      onToast={(message, kind) => {
        toasts.push(`${kind ?? 'info'}: ${message}`);
        console.log(`[toast/${kind ?? 'info'}] ${message}`);
      }}
    />
  );
  return (
    <QueryClientProvider client={queryClient}>
      {NO_PANEL ? (
        body
      ) : (
        <Panel title={host?.name ?? 'kortix'} focused width={WIDTH + 2} height={HEIGHT + 2}>
          {body}
        </Panel>
      )}
    </QueryClientProvider>
  );
}

if (INTERACTIVE) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(<Harness />);
} else {
  // The pickers are centered over the WHOLE terminal, not over the sidebar
  // column, so the harness screen is a realistic 100 columns wide.
  const setup = await createTestRenderer({ width: 100, height: HEIGHT + 4 });
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
  /** The frame's content lines with the harness Panel's border stripped, so a
   *  row assertion sees exactly what the sidebar drew. */
  const lines = () =>
    frame()
      .split('\n')
      .map((line) =>
        line
          .replace(/^[┌│└][─]*/, '')
          .replace(/[┐│┘]\s*$/, '')
          .trimEnd(),
      );
  const press = async (key: string) => {
    setup.mockInput.pressKey(key);
    await settle(220);
  };
  // A lone ESC is the prefix of every escape sequence: the parser holds it
  // until a timeout proves nothing follows, so the wait is load-bearing.
  const pressEscape = async () => {
    setup.mockInput.pressEscape();
    await settle(400);
  };

  // The first keyset page, straight from the SDK, so the paging assertion
  // below has a baseline that does not depend on the rendered frame.
  const page1 = await kortix()
    .project(projectId as string)
    .sessions.listPage();
  const page1OldestIso = new Date(Math.min(...page1.items.map((item) => sessionActivityMs(item))))
    .toISOString()
    .slice(0, 10);
  console.log(
    `page 1: ${page1.items.length} rows, next_cursor=${page1.next_cursor ? 'yes' : 'no'}, oldest activity ${page1OldestIso}`,
  );

  await settle(4000);
  banner('FRAME 1 — sidebar mounted against the live API');
  console.log(frame());

  const dayHeaders = lines().filter((line) =>
    /^(Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{4}-\d{2}-\d{2})$/.test(
      line,
    ),
  );
  console.log(`day sections on screen: ${JSON.stringify(dayHeaders)}`);

  // Walk to the bottom until a spawned child row appears, paging as the cursor
  // reaches the last loaded row.
  let childLine = lines().find((line) => /^\s+·\s/.test(line));
  for (let round = 0; round < 8 && !childLine; round += 1) {
    setup.mockInput.pressKey('G');
    await settle(1200);
    childLine = lines().find((line) => /^\s+·\s/.test(line));
  }
  banner('FRAME 2 — after paging to the end (G)');
  console.log(frame());
  console.log(`child row: ${childLine ? JSON.stringify(childLine.trimEnd()) : 'NOT FOUND'}`);

  // A day header older than page 1's oldest row can only come from a later
  // keyset page, so it is proof that `fetchNextPage` ran.
  const olderThanPage1 = lines().filter(
    (line) => /^\d{4}-\d{2}-\d{2}$/.test(line) && line < page1OldestIso,
  );
  console.log(
    `day sections older than page 1 (${page1OldestIso}): ${JSON.stringify(olderThanPage1)}`,
  );

  // Enter on a session row must hand the host that row's id.
  setup.mockInput.pressKey('g');
  await settle(300);
  for (let step = 0; step < 7; step += 1) await press('j');
  const cursorLine = lines().find((line) => line.startsWith('▌'));
  banner('FRAME 3 — cursor on the first session row');
  console.log(frame());
  console.log(`cursor row: ${JSON.stringify(cursorLine?.trimEnd() ?? '')}`);
  setup.mockInput.pressEnter();
  await settle(600);
  console.log(`opened: ${JSON.stringify(opened)}`);

  // The account picker, then the project picker, both listing real rows.
  await press('g');
  setup.mockInput.pressEnter();
  await settle(800);
  banner('FRAME 4 — account picker');
  console.log(frame());
  // Enter picks the highlighted row and must hand the host that account's id.
  setup.mockInput.pressEnter();
  await settle(600);

  await press('g');
  await press('j');
  setup.mockInput.pressEnter();
  await settle(800);
  banner('FRAME 5 — project picker');
  console.log(frame());
  setup.mockInput.pressEnter();
  await settle(600);
  // Esc must also leave a picker without picking anything.
  await press('g');
  setup.mockInput.pressEnter();
  await settle(600);
  await pressEscape();
  banner('FRAME 6 — Esc left the picker');
  console.log(frame());

  if (ALLOW_CREATE) {
    banner('CREATE — pressing n (this provisions a real sandbox)');
    setup.mockInput.pressKey('n');
    await settle(60_000);
    console.log(frame());
    console.log(`created: ${JSON.stringify(created)}`);
    if (created.length !== 1) throw new Error('expected exactly one created session');
    const newId = created[0] as string;
    const readBack = await kortix()
      .session(projectId as string, newId)
      .get();
    console.log(`read-back after create: ${readBack.session_id} status=${readBack.status}`);

    // RENAME — the cursor is on the newest row, which is the session just
    // created (a fresh session's activity is its creation stamp).
    await press('g');
    for (let step = 0; step < 7; step += 1) await press('j');
    console.log(`cursor before rename: ${JSON.stringify(lines().find((l) => l.startsWith('▌')))}`);
    await press('r');
    await setup.mockInput.typeText(' RENAMED', 8);
    await settle(400);
    banner('FRAME 7 — inline rename input');
    console.log(frame());
    setup.mockInput.pressEnter();
    await settle(4000);
    const renamed = await kortix()
      .session(projectId as string, newId)
      .get();
    console.log(
      `read-back after rename: name=${JSON.stringify(renamed.name)} custom_name=${JSON.stringify(renamed.custom_name)}`,
    );

    // DELETE — removes the session this run created, sandbox included.
    await press('d');
    banner('FRAME 8 — delete confirm');
    console.log(frame());
    await press('y');
    await settle(8000);
    const stillThere = (
      await kortix()
        .project(projectId as string)
        .sessions.listPage({ limit: 5 })
    ).items.some((item) => item.session_id === newId);
    console.log(`session still listed after delete: ${stillThere}`);
    banner('FRAME 9 — after delete');
    console.log(frame());
  }

  banner('SUMMARY');
  console.log(
    JSON.stringify(
      { dayHeaders, childFound: Boolean(childLine), opened, created, toasts },
      null,
      2,
    ),
  );

  root.unmount();
  setup.renderer.destroy();
  process.exit(0);
}
