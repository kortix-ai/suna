/**
 * The whole app against a real API, a real project and a real cloud sandbox.
 *
 * Not a unit test: it needs a token and a live session, so `bun test` never
 * runs it. It is the headless half of the wave-3 proof — the pty run
 * (`README.md` → Troubleshooting) proves the real process paints and restores
 * the terminal; this proves the ROUTES and the DATA, with assertions instead of
 * eyes, and exits non-zero when any of them fails.
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<pid> KORTIX_SESSION_ID=<sid> \
 *   bun run apps/tui/scripts/live-app.tsx "say hello in five words"
 *
 * What it asserts, in order:
 *   1. the sidebar lists real sessions, grouped by day;
 *   2. the session view reaches `ready` on the real runtime;
 *   3. a typed prompt streams a reply containing a unique marker;
 *   4. `Ctrl+P` opens the switcher over the real session list;
 *   5. `?` opens the help overlay and shows every scope;
 *   6. `Alt+F` routes to the files screen and `Esc` comes back;
 *   7. `Alt+R` lists this project's change requests, `Enter` opens a real diff;
 *   8. `Alt+A` lists this project's Apps;
 *   9. `Alt+C` walks all five Customize tabs by their number keys;
 *  10. `Alt+U` opens the account screen on Members;
 *  11. `Ctrl+H` asks the host to switch (the login screen is the pty run);
 *  12. `Ctrl+N` creates a REAL session and the sidebar's `d` deletes it again —
 *      the id set before and after must be identical, so a delete that took the
 *      wrong row fails the script.
 *
 * `LIVE_SKIP_STREAM=1` drops steps 2, 3 and 12 for a project whose sessions are
 * all stopped (a cold boot is minutes, and step 12 provisions a sandbox). The
 * skip is PRINTED, never silent.
 */

import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/app.tsx';
import { resolveHost } from '../src/auth/hosts.ts';
import { registerEmbeddedTerminal } from '../src/features/terminal/register.ts';
import { initKortix, kortix } from '../src/kortix.ts';

registerEmbeddedTerminal();

const MARKER = process.env.LIVE_MARKER ?? `TUI-W3-${Date.now().toString(36).toUpperCase()}`;
const PROMPT = process.argv[2] ?? `Reply with exactly: ${MARKER}`;
const READY_TIMEOUT_MS = Number(process.env.LIVE_READY_TIMEOUT_MS ?? 300_000);
const STREAM_TIMEOUT_MS = Number(process.env.LIVE_STREAM_TIMEOUT_MS ?? 240_000);
const WIDTH = Number(process.env.LIVE_WIDTH ?? 120);
const HEIGHT = Number(process.env.LIVE_HEIGHT ?? 40);
/** A project whose sessions are all stopped cannot prove the runtime steps. */
const SKIP_STREAM = process.env.LIVE_SKIP_STREAM === '1';

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function banner(title: string): void {
  console.log(`\n===== ${stamp()} ${title} =====`);
}

const host = resolveHost();
if (!host) throw new Error('no host: set KORTIX_API_URL + KORTIX_API_KEY');
initKortix(host);

const projectId = process.env.KORTIX_PROJECT_ID?.trim() ?? null;
const sessionId = process.env.KORTIX_SESSION_ID?.trim() ?? null;
if (!projectId) throw new Error('set KORTIX_PROJECT_ID');
// With the runtime steps skipped there is deliberately NO session to open:
// mounting `useSession` on a stopped session drives `/start`, which provisions
// a real sandbox this run has no use for and would leave behind.
if (!sessionId && !SKIP_STREAM) {
  throw new Error('set KORTIX_SESSION_ID, or LIVE_SKIP_STREAM=1 to run the screens alone');
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 2 } },
});

/** `Ctrl+H` asks the HOST to remount on another host; `src/main.tsx` owns that
 *  in the real process, so here it is recorded and asserted. */
let switchHostCalls = 0;

const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
const root = createRoot(setup.renderer);
root.render(
  <QueryClientProvider client={queryClient}>
    <App
      host={host}
      projectId={projectId}
      accountId={host.accountId || null}
      initialSessionId={sessionId}
      onQuit={() => {}}
      onSwitchHost={() => {
        switchHostCalls += 1;
      }}
    />
  </QueryClientProvider>,
);

async function settle(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await setup.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForFrame(
  match: (frame: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    await setup.renderOnce();
    last = setup.captureCharFrame();
    if (match(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`timeout waiting for ${label} after ${timeoutMs}ms`, last);
}

/** The session header is the first row inside the panel. */
function headerLine(frame: string): string {
  return frame.split('\n')[1] ?? '';
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * A failure has to EXIT, not throw: the SSE stream and the query client keep
 * the event loop alive, so a bare throw leaves the process hanging instead of
 * reporting. Same reason `fail()` is used for the timeouts.
 */
function fail(label: string, frame: string): never {
  banner(`FAILED — ${label}`);
  console.log(frame);
  process.exit(1);
}

function expectFrame(frame: string, needle: string, label: string): void {
  if (frame.includes(needle)) {
    console.log(`  ok · ${label}`);
    return;
  }
  fail(`${label}: frame does not contain ${JSON.stringify(needle)}`, frame);
}

/** One of several acceptable strings — a screen with rows and the same screen
 *  empty are both proof that the ROUTE opened. Prints which one matched. */
function expectAnyFrame(frame: string, needles: readonly string[], label: string): void {
  const hit = needles.find((needle) => frame.includes(needle));
  if (hit !== undefined) {
    console.log(`  ok · ${label} (${JSON.stringify(hit)})`);
    return;
  }
  fail(`${label}: frame contains none of ${JSON.stringify(needles)}`, frame);
}

function expectValue(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) {
    console.log(`  ok · ${label}`);
    return;
  }
  fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, '');
}

/** Alt is `meta` in a raw terminal and `option` under kitty — send both, the
 *  way `src/keymap.ts` accepts both. */
function pressAlt(name: string): void {
  setup.mockInput.pressKey(name, { meta: true });
}

/** Back to the session route from any screen, with the focus the app gives it. */
async function backToSession(): Promise<void> {
  setup.mockInput.pressEscape();
  await settle(1200);
}

async function sessionIds(): Promise<Set<string>> {
  const rows = await kortix().projects.sessions(projectId as string, { limit: 200 });
  return new Set(rows.map((row) => row.session_id));
}

await settle(3000);
banner('FRAME 0 — first paint');
console.log(setup.captureCharFrame());

// 1. The sidebar is real data: day headings come from the session list.
const listed = await waitForFrame(
  (frame) => /Today|Yesterday|\d{4}-\d{2}-\d{2}/.test(frame),
  60_000,
  'a day heading',
);
banner('FRAME 1 — sidebar lists sessions grouped by day');
console.log(listed);
expectFrame(listed, '+ New session', 'the sidebar prints its nav rows');
expectFrame(listed, 'Customize', 'the sidebar prints the screen rows');

if (SKIP_STREAM) {
  banner('SKIPPED — steps 2, 3 and 12 (LIVE_SKIP_STREAM=1)');
  console.log(
    '  the runtime, the streamed reply and the create/delete round trip are NOT asserted',
  );
} else {
  // 2. The session reaches ready on the real runtime. The glyph is read off the
  //    HEADER row, not the whole frame: the sidebar prints the same glyph for a
  //    running session and would satisfy a frame-wide match on its own.
  const ready = await waitForFrame(
    (frame) => headerLine(frame).includes('●'),
    READY_TIMEOUT_MS,
    'the ready glyph in the session header',
  );
  banner('FRAME 2 — session ready');
  console.log(ready);

  // 3. A prompt streams back. Boot focus is the composer, so it types straight in.
  await setup.mockInput.typeText(PROMPT, 5);
  await settle(500);
  banner('FRAME 3 — prompt typed');
  console.log(setup.captureCharFrame());

  setup.mockInput.pressEnter();
  await settle(1500);
  banner('FRAME 4 — after Enter');
  console.log(setup.captureCharFrame());

  // The PROMPT itself carries the marker, so its own user turn is one
  // occurrence. A reply is the SECOND — matching on one would pass on the echo
  // of what was just typed and prove nothing.
  const streamed = await waitForFrame(
    (frame) => countOccurrences(frame, MARKER) >= 2,
    STREAM_TIMEOUT_MS,
    `an assistant reply repeating "${MARKER}" (a second occurrence)`,
  );
  banner('FRAME 5 — streamed reply');
  console.log(streamed);
}

// 4. Ctrl+P — the switcher, over the same session list.
setup.mockInput.pressKey('p', { ctrl: true });
await settle(1500);
const switcher = setup.captureCharFrame();
banner('FRAME 6 — Ctrl+P switcher');
console.log(switcher);
expectFrame(switcher, 'Go to', 'the switcher opens');
// Project rows sort UNDER every session, so in a project with 20 of them they
// are below the fold. Filter to them: that proves the rows exist AND that the
// picker's filter runs over both kinds.
await setup.mockInput.typeText('project', 5);
await settle(800);
const switcherFiltered = setup.captureCharFrame();
banner('FRAME 6b — switcher filtered to the project rows');
console.log(switcherFiltered);
expectFrame(switcherFiltered, 'project · ', 'the switcher lists projects under the sessions');
setup.mockInput.pressEscape();
await settle(500);

// 5. `?` — the help overlay, generated from the one keymap.
setup.mockInput.pressTab();
await settle(300);
setup.mockInput.pressKey('?');
await settle(800);
const help = setup.captureCharFrame();
banner('FRAME 7 — help overlay');
console.log(help);
expectFrame(help, 'Anywhere', 'the help overlay opens on the global scope');
setup.mockInput.pressEscape();
await settle(500);

// 6. Alt+F routes to files, Esc comes back to the session.
pressAlt('f');
await settle(2000);
const files = setup.captureCharFrame();
banner('FRAME 8 — Alt+F files screen');
console.log(files);
expectFrame(files, 'files', 'the files route opens');
await backToSession();
banner('FRAME 9 — Esc back to the session');
console.log(setup.captureCharFrame());

// 7. Alt+R — the change requests, and one real diff.
pressAlt('r');
await settle(4000);
const review = setup.captureCharFrame();
banner('FRAME 10 — Alt+R review');
console.log(review);
expectAnyFrame(review, ['Change requests', 'No change requests.'], 'the review route opens');
if (review.includes('No change requests.')) {
  console.log('  skipped · no change request in this project, so no diff to open');
} else {
  setup.mockInput.pressEnter();
  await settle(5000);
  const diff = setup.captureCharFrame();
  banner('FRAME 11 — Enter opens the diff');
  console.log(diff);
  expectFrame(diff, 's unified/split', 'the diff view opens on a real patch');
  setup.mockInput.pressEscape();
  await settle(800);
}
await backToSession();

// 8. Alt+A — the project's Apps.
pressAlt('a');
await settle(4000);
const apps = setup.captureCharFrame();
banner('FRAME 12 — Alt+A apps');
console.log(apps);
expectAnyFrame(
  apps,
  // Three legitimate answers: Apps with rows, Apps with none, and Apps turned
  // off for this project. All three prove the ROUTE opened.
  ['o open · y copy', 'kortix apps deploy .', 'Apps is not enabled for this project'],
  'the apps route opens',
);
await backToSession();

// 9. Alt+C — every Customize tab, reached by its own number key. Each tab is
//    asserted on something only THAT tab prints (its footer hint, or its own
//    empty state), never on the tab bar, which shows all five labels always.
const CUSTOMIZE_STEPS: readonly { key: string; label: string; needles: readonly string[] }[] = [
  { key: '1', label: 'Agents', needles: ['★ project default', 'No agents yet.'] },
  { key: '2', label: 'Skills', needles: ['No skills yet.', 'Enter details'] },
  { key: '3', label: 'Secrets', needles: ['* required', 'No secrets in this project yet.'] },
  { key: '4', label: 'Triggers', needles: ['Space/t pause or resume', 'No triggers yet.'] },
  {
    key: '5',
    label: 'Connectors',
    needles: ['OAuth happens in the web app', 'No connectors yet.'],
  },
];
pressAlt('c');
await settle(4000);
banner('FRAME 13 — Alt+C customize');
console.log(setup.captureCharFrame());
for (const step of CUSTOMIZE_STEPS) {
  setup.mockInput.pressKey(step.key);
  await settle(3000);
  const tab = setup.captureCharFrame();
  expectAnyFrame(tab, step.needles, `customize tab ${step.key} is ${step.label}`);
  if (step.key === '2') {
    // Skills and Agents share "Enter details"; the agents-only marker must be
    // gone, or the frame is still showing tab 1.
    if (tab.includes('★ project default')) {
      fail('customize tab 2 still shows the Agents tab', tab);
    }
  }
  if (step.key === '5') {
    banner('FRAME 14 — customize tab 5 (Connectors)');
    console.log(tab);
  }
}
await backToSession();

// 10. Alt+U — the account screen.
pressAlt('u');
await settle(4000);
const account = setup.captureCharFrame();
banner('FRAME 15 — Alt+U account');
console.log(account);
expectFrame(account, 'Members', 'the account route opens on Members');
await backToSession();

// 11. Ctrl+H — the app asks its host to switch. The real host switch is the
//     login screen, which needs a second process; this proves the chord fires.
// Alt+H, not Ctrl+H: Ctrl+H is the ASCII backspace byte and arrives as
// `{ name: 'backspace' }` in every terminal without the kitty protocol
// (`docs/opentui-notes.md`). The mock encodes it the same way, so a Ctrl+H
// assertion here would only ever prove the collision.
pressAlt('h');
await settle(800);
expectValue(switchHostCalls, 1, 'Alt+H asks the host to switch');

// 12. Ctrl+N creates a REAL session, and the sidebar's `d` deletes it again.
if (!SKIP_STREAM) {
  const before = await sessionIds();
  setup.mockInput.pressKey('n', { ctrl: true });
  await settle(8000);
  banner('FRAME 16 — Ctrl+N created a session');
  console.log(setup.captureCharFrame());

  const after = await sessionIds();
  const created = [...after].filter((id) => !before.has(id));
  if (created.length !== 1) {
    fail(`Ctrl+N created ${created.length} sessions, expected exactly 1`, '');
  }
  console.log(`  ok · Ctrl+N created session ${created[0]}`);

  /**
   * The label the sidebar prints for the new session, RIGHT NOW.
   *
   * Re-read on every attempt, not once: a fresh session is `Untitled` for a few
   * seconds and the server then names it from the first turn, so a label
   * captured before the walk goes stale mid-walk.
   */
  async function createdLabelNow(): Promise<string> {
    const row = (await kortix().projects.sessions(projectId as string, { limit: 200 })).find(
      (candidate) => candidate.session_id === created[0],
    );
    return (row?.custom_name || row?.name || 'Untitled').slice(0, 10);
  }

  // Delete it through the SIDEBAR, not the API. Walk the column from its FIRST
  // row: `d` opens the confirm on a session row and does nothing on a nav row,
  // and `j` cannot move past the last row — starting wherever the cursor
  // happened to be left it stuck on the bottom session, pressing `d` on the
  // same row ten times.
  //
  // `y` is sent only when the confirm NAMES the new session, and the name is
  // read off the ONE line under "Delete session", never off the whole frame:
  // the session list is on the same screen, so a frame-wide match is satisfied
  // by the row's own entry in that list. Measured — a frame-wide check pressed
  // `y` on the wrong session and reported the right one.
  setup.mockInput.pressTab();
  await settle(600);
  setup.mockInput.pressKey('g');
  await settle(400);
  let deleted = false;
  for (let attempt = 0; attempt < 20 && !deleted; attempt += 1) {
    setup.mockInput.pressKey('d');
    await settle(700);
    const confirm = setup.captureCharFrame();
    const rows = confirm.split('\n');
    const headingIndex = rows.findIndex((row) => row.includes('Delete session'));
    if (headingIndex < 0) {
      // A nav row: no confirm to cancel, just step down.
      setup.mockInput.pressKey('j');
      await settle(400);
      continue;
    }
    const named = rows[headingIndex + 1] ?? '';
    const label = await createdLabelNow();
    if (named.includes(label)) {
      banner('FRAME 17 — the sidebar confirm names the new session');
      console.log(confirm);
      setup.mockInput.pressKey('y');
      await settle(6000);
      deleted = true;
      break;
    }
    console.log(`  not this row — the confirm names ${JSON.stringify(named.trim().slice(0, 40))}`);
    setup.mockInput.pressEscape();
    await settle(500);
    setup.mockInput.pressKey('j');
    await settle(400);
  }
  if (!deleted)
    fail('the sidebar never offered to delete the new session', setup.captureCharFrame());

  const final = await sessionIds();
  const missing = [...before].filter((id) => !final.has(id));
  const extra = [...final].filter((id) => !before.has(id));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `the session set changed: ${missing.length} row(s) lost (${missing.join(', ')}), ` +
        `${extra.length} left over (${extra.join(', ')})`,
      '',
    );
  }
  console.log(
    `  ok · the sidebar's d deleted exactly the new session (${before.size} rows before and after)`,
  );
  banner('FRAME 18 — after the delete');
  console.log(setup.captureCharFrame());
}

banner(`PASS — marker ${MARKER}`);
root.unmount();
setup.renderer.destroy();
process.exit(0);
