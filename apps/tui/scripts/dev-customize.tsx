/**
 * Live harness for `features/customize` (wave 2). Not a unit test — it needs a
 * real API and a real token, so `bun test` never runs it.
 *
 * Headless, printing one frame per tab:
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<project> bun run scripts/dev-customize.tsx
 *
 * Interactive, in this terminal (Ctrl+C quits):
 *
 *   … bun run scripts/dev-customize.tsx --interactive
 *
 * Flags:
 *   --secret    create and then delete a REAL project secret named
 *               `TUI_WAVE2_PROBE`, reading the list back after each write.
 *               Off by default so a re-run writes nothing.
 *   --trigger   toggle the FIRST trigger's `enabled` and restore it. This
 *               commits to the project repo manifest, so it is opt-in.
 */

import { createCliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { resolveHost } from '../src/auth/hosts.ts';
import { CustomizeScreen } from '../src/features/customize/index.ts';
import { initKortix, kortix } from '../src/kortix.ts';
import { Panel } from '../src/ui/index.ts';

const INTERACTIVE = process.argv.includes('--interactive');
const WRITE_SECRET = process.argv.includes('--secret');
const WRITE_TRIGGER = process.argv.includes('--trigger');
const PROBE_SECRET = 'TUI_WAVE2_PROBE';
const WIDTH = Number(process.env.CUSTOMIZE_WIDTH ?? 96);
const HEIGHT = Number(process.env.CUSTOMIZE_HEIGHT ?? 22);

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

/** The SDK's own answer, so a frame assertion has a baseline beside it. */
async function secretNames(): Promise<string[]> {
  const response = await kortix()
    .project(projectId as string)
    .secrets.list();
  return response.items.map((item) => item.identifier);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});
const toasts: string[] = [];

function Harness() {
  return (
    <QueryClientProvider client={queryClient}>
      <Panel title="Customize" focused width={WIDTH + 2} height={HEIGHT + 2}>
        <CustomizeScreen
          projectId={projectId as string}
          accountId={accountId}
          focused
          width={WIDTH}
          height={HEIGHT}
          webBaseUrl={process.env.KORTIX_WEB_URL?.trim() || undefined}
          onBack={() => console.log('[onBack]')}
          onToast={(message, kind) => {
            toasts.push(`${kind ?? 'info'}: ${message}`);
            console.log(`[toast/${kind ?? 'info'}] ${message}`);
          }}
        />
      </Panel>
    </QueryClientProvider>
  );
}

if (INTERACTIVE) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(<Harness />);
} else {
  const setup = await createTestRenderer({ width: WIDTH + 6, height: HEIGHT + 6 });
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
  const press = async (key: string, wait = 500) => {
    setup.mockInput.pressKey(key);
    await settle(wait);
  };
  const type = async (text: string) => {
    setup.mockInput.typeText(text, 8);
    await settle(600);
  };

  await settle(4000);
  banner('TAB 1 — Agents');
  console.log(frame());

  await press('2', 3500);
  banner('TAB 2 — Skills');
  console.log(frame());

  await press('3', 3500);
  banner('TAB 3 — Secrets');
  console.log(frame());

  if (WRITE_SECRET) {
    console.log(`secrets before: ${JSON.stringify(await secretNames())}`);
    await press('n');
    banner('SECRET — name step');
    console.log(frame());
    await type(PROBE_SECRET);
    setup.mockInput.pressEnter();
    await settle(600);
    await type('tui-wave2-probe-value');
    banner('SECRET — value step (the value must appear only as bullets)');
    const masked = frame();
    console.log(masked);
    console.log(
      `value leaked into the frame: ${masked.includes('tui-wave2-probe-value') ? 'YES — BUG' : 'no'}`,
    );
    setup.mockInput.pressEnter();
    await settle(6000);
    console.log(`secrets after create: ${JSON.stringify(await secretNames())}`);
    banner('SECRET — list after create');
    console.log(frame());

    // Delete it again. `g` lands on the first row, which is the newest stored
    // secret — the probe. A row the cursor cannot delete (a manifest-only
    // `Not set` key) refuses to open the confirm, so landing on the right row
    // is part of the proof, not an implementation detail.
    await press('g');
    for (let step = 0; step < 12; step += 1) {
      const cursorLine = frame()
        .split('\n')
        .find((line) => line.includes('▌'));
      if (cursorLine?.includes(PROBE_SECRET)) break;
      await press('j', 250);
    }
    console.log(
      `cursor before delete: ${JSON.stringify(
        frame()
          .split('\n')
          .find((line) => line.includes('▌'))
          ?.trim() ?? '',
      )}`,
    );
    await press('d');
    banner('SECRET — delete confirm');
    console.log(frame());
    await press('y');
    await settle(6000);
    console.log(`secrets after delete: ${JSON.stringify(await secretNames())}`);
    banner('SECRET — list after delete');
    console.log(frame());
  }

  await press('4', 3500);
  banner('TAB 4 — Triggers');
  console.log(frame());

  if (WRITE_TRIGGER) {
    const before = await kortix()
      .project(projectId as string)
      .triggers.list();
    console.log(
      `triggers before: ${before.triggers.map((t) => `${t.slug}=${t.enabled}`).join(', ')}`,
    );
    await press('t', 8000);
    const after = await kortix()
      .project(projectId as string)
      .triggers.list();
    console.log(
      `triggers after t: ${after.triggers.map((t) => `${t.slug}=${t.enabled}`).join(', ')}`,
    );
    banner('TRIGGERS — after the toggle');
    console.log(frame());
    await press('t', 8000);
    const restored = await kortix()
      .project(projectId as string)
      .triggers.list();
    console.log(
      `triggers restored: ${restored.triggers.map((t) => `${t.slug}=${t.enabled}`).join(', ')}`,
    );
  }

  await press('5', 4000);
  banner('TAB 5 — Connectors');
  console.log(frame());

  setup.mockInput.pressEnter();
  await settle(1500);
  banner('CONNECTORS — details with the connect URL');
  console.log(frame());

  banner('SUMMARY');
  console.log(JSON.stringify({ toasts }, null, 2));

  root.unmount();
  setup.renderer.destroy();
  process.exit(0);
}
