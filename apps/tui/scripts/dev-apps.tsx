/**
 * Live harness for `features/apps` (wave 2). Not a unit test — it needs a real
 * API and a real token, so `bun test` never runs it.
 *
 * Headless, printing the captured frames and the callback payloads:
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<project> bun run scripts/dev-apps.tsx
 *
 * Interactive, in this terminal (Ctrl+C quits):
 *
 *   … bun run scripts/dev-apps.tsx --interactive
 *
 * Flags:
 *   --browser   let `o` really launch the desktop browser. Off by default: the
 *               harness injects a spawner that only records the argv, which is
 *               what the assertion needs.
 *   --write     allow the writes `d` (start/suspend) and `v` (access mode).
 *               Off by default so a re-run changes nothing.
 */

import { createCliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { resolveHost } from '../src/auth/hosts.ts';
import { AppsScreen } from '../src/features/apps/index.ts';
import { initKortix, kortix } from '../src/kortix.ts';
import { openUrl } from '../src/lib/open-url.ts';
import { Panel } from '../src/ui/index.ts';

const INTERACTIVE = process.argv.includes('--interactive');
const REAL_BROWSER = process.argv.includes('--browser');
const ALLOW_WRITE = process.argv.includes('--write');
const WIDTH = Number(process.env.APPS_WIDTH ?? 96);
const HEIGHT = Number(process.env.APPS_HEIGHT ?? 24);

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

// The SDK's own answer, so the frame assertions have a baseline that does not
// depend on what was rendered.
const apps = await kortix().project(projectId).apps.list();
console.log(
  `apps.list(): ${apps.length} rows${apps
    .map(
      (app) =>
        `\n  ${app.slug} url=${app.url} desired=${app.desired_state} active_deployment=${app.active_deployment_id ?? 'none'} access=${app.access_mode}`,
    )
    .join('')}`,
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const spawned: string[][] = [];
const toasts: string[] = [];
const copied: string[] = [];

function Harness() {
  return (
    <QueryClientProvider client={queryClient}>
      <Panel title="Apps" focused width={WIDTH + 2} height={HEIGHT + 2}>
        <AppsScreen
          projectId={projectId as string}
          accountId={accountId}
          focused
          width={WIDTH}
          height={HEIGHT}
          onBack={() => console.log('[onBack]')}
          onCopy={(text) => {
            copied.push(text);
            console.log(`[onCopy] ${text}`);
          }}
          openUrlImpl={
            REAL_BROWSER
              ? openUrl
              : (url: string) =>
                  openUrl(url, {
                    spawn: (argv) => {
                      spawned.push(argv);
                      console.log(`[spawn] ${JSON.stringify(argv)}`);
                    },
                  })
          }
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
  const setup = await createTestRenderer({ width: WIDTH + 6, height: HEIGHT + 4 });
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
  const press = async (key: string) => {
    setup.mockInput.pressKey(key);
    await settle(400);
  };
  // A lone ESC is the prefix of every escape sequence: the parser holds it
  // until a timeout proves nothing follows, so the wait is load-bearing.
  const pressEscape = async () => {
    setup.mockInput.pressEscape();
    await settle(400);
  };

  await settle(4000);
  banner('FRAME 1 — Apps list against the live API');
  console.log(frame());

  banner('FRAME 2 — Enter: deploy details');
  setup.mockInput.pressEnter();
  await settle(3000);
  console.log(frame());
  await pressEscape();

  banner('FRAME 3 — o: the URL reaches the platform opener');
  await press('o');
  await settle(2000);
  console.log(frame());
  console.log(`spawned: ${JSON.stringify(spawned)}`);

  banner('FRAME 4 — y: the URL reaches the copier');
  await press('y');
  console.log(`copied: ${JSON.stringify(copied)}`);

  banner('FRAME 5 — v: the access-mode picker');
  await press('v');
  console.log(frame());
  if (ALLOW_WRITE) {
    // Move to `project` and apply, read back, then restore `private`.
    await press('j');
    setup.mockInput.pressEnter();
    await settle(5000);
    const widened = await kortix()
      .project(projectId as string)
      .apps.list();
    console.log(
      `read-back after v: ${widened.map((app) => `${app.slug}=${app.access_mode}`).join(', ')}`,
    );
    await press('v');
    await press('k');
    setup.mockInput.pressEnter();
    await settle(5000);
    const restored = await kortix()
      .project(projectId as string)
      .apps.list();
    console.log(
      `read-back after restore: ${restored.map((app) => `${app.slug}=${app.access_mode}`).join(', ')}`,
    );
  } else {
    await pressEscape();
  }

  banner('FRAME 6 — d: the start/suspend confirm');
  await press('d');
  console.log(frame());
  if (ALLOW_WRITE) {
    await press('y');
    await settle(4000);
    const after = await kortix()
      .project(projectId as string)
      .apps.list();
    console.log(
      `read-back after d: ${after.map((app) => `${app.slug}=${app.desired_state}`).join(', ')}`,
    );
  } else {
    await pressEscape();
    console.log('(write skipped — pass --write to confirm it)');
  }
  banner('FRAME 7 — back on the list');
  console.log(frame());

  banner('SUMMARY');
  console.log(JSON.stringify({ apps: apps.length, spawned, copied, toasts }, null, 2));

  root.unmount();
  setup.renderer.destroy();
  process.exit(0);
}
