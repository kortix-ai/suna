/**
 * What a user already saw renders again without waiting on the backend.
 *
 * A reload used to start every surface from nothing: the project gate showed
 * the Kortix mark, the sidebar showed skeleton rows, and the session showed
 * skeleton rows or the boot screen, each until its read answered. On a slow
 * backend that was the whole wait. Now the device keeps the last answers per
 * user: the query cache (project, session list) and the last saved copy of the
 * conversation. They render in the first frame, and the reads reconcile in
 * place.
 *
 * The first arm opens a session once, then HOLDS every read the page makes on
 * a reload — the project, the session list, the session-open snapshot, the
 * saved copy and `/start` — and reloads. The project shell, the session's row
 * in the sidebar and the conversation must all show while nothing answers.
 *
 * The second arm opens a stopped session that has no computer. It used to be a
 * full-screen "This session is stopped" card over a conversation the user
 * could read. Since #9682 the conversation shows with a live composer, whose
 * notice says the next message wakes the computer. No Restart is needed.
 *
 * The third arm saves a turn with a tool call and opens it while the computer
 * never answers, then reloads with every read held. Saved history used to drop
 * each tool call's input and output, so the card was a bare icon until the
 * computer woke; now the saved copy and the copy this device kept both draw
 * the command and its output exactly as the live transcript does.
 *
 * The fourth arm saves a turn that dispatched a sub-agent. A sub-agent runs in
 * its own OpenCode session, and its row opens that transcript, which only the
 * running computer could answer: while it was off, the view waited. Now saved
 * history holds the sub-agent's transcript too: the row opens its steps in
 * place, and its 'View' action opens the whole transcript.
 *
 * The fifth arm stores a tool call the way saved history stored it before it
 * kept tool calls 1:1: no input, no output, only the title (OpenCode titles a
 * command with the command) and the metadata (which keeps its output). The row
 * drew a bare icon; the server now serves it with what it kept.
 *
 * The sixth arm opens a session whose saved copy proves it empty: a complete
 * read of its runtime found no messages. It opened on the boot screen for the
 * whole wake; it now opens on its composer.
 *
 * The seventh arm opens a session, so this device keeps its saved copy, then
 * saves a newer turn on the server and reloads while the computer and the
 * session-open snapshot never answer. The copy the device kept painted first,
 * and the newer saved copy from the history read never replaced it, so the
 * reload showed an older last message until the computer woke. The newer turn
 * now shows at once, from one read of the session log.
 *
 * The eighth arm opens the Sessions page as the project owner, then reloads it
 * with every session-list and permission read held. The page picks the
 * manager-only 'project' scope from a permission probe the device does not
 * keep, so it showed skeleton rows until the probe answered, over a list the
 * device already held. The kept rows now show at once.
 *
 * The ninth arm counts the reads (KRTX-189). An open downloaded the saved
 * window twice: in the session-open snapshot, and again from
 * `GET …/transcript`, because the history read raced the snapshot and the
 * sync layer kept its own read. The snapshot now carries it alone.
 */
import { type Page, expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { journalSessionLog, seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { createManifestProject, fundAccount } from '../helpers/manifest-project';
import { createAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

// Always recorded: the video of the held-network reload is the PR's demo.
test.use({ video: 'on' });

const api = createApiJsonClient(process.env.E2E_API_URL!);
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL!,
  password: 'InstantSessionLoads123!',
};

const SAVED_REPLY = 'This reply is stored in the database.';
const SAVED_PROMPT = 'Show my saved conversation.';
const BOOT_HEADING = 'Starting your session';

/** The API's path prefix (`/v1`), so a held route never matches the page's own URL. */
const API_PATH = new URL(process.env.E2E_API_URL!).pathname.replace(/\/+$/, '');

/**
 * The saved copy this device keeps for one session, or null. The web host keeps
 * saved copies in IndexedDB (`kortix-session-cache`, store `saved-copies`, see
 * the SDK's `idb-sync-cache.ts`), keyed `kortix.saved-copy:<user>:<project>/<session>`.
 * A session whose project has the `session_log` flag on keeps its session-log page
 * instead, under `kortix.saved-copy.log:…` (`savedLogCopyKey`).
 * The read opens the database at its current version and closes it, so it never
 * blocks the page's own upgrade.
 */
function readSavedCopy(page: Page, key: string): Promise<string | null> {
  return page.evaluate(
    (key) =>
      new Promise<string | null>((resolve) => {
        const open = indexedDB.open('kortix-session-cache');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('saved-copies')) {
            db.close();
            return resolve(null);
          }
          const read = db.transaction('saved-copies', 'readonly').objectStore('saved-copies').get(key);
          read.onsuccess = () => {
            db.close();
            resolve(typeof read.result === 'string' ? read.result : null);
          };
          read.onerror = () => {
            db.close();
            resolve(null);
          };
        };
      }),
    key,
  );
}

/**
 * Every read of the session's newest saved window from now on: `GET …/transcript?`
 * for the conversation. An older page (`before=`) and a sub-agent's window
 * (`child=`) are other reads.
 */
/**
 * The key of the copy this device keeps for one session. The session log owns the history of a
 * project with the `session_log` flag on (#10305): the device keeps the log's page under the
 * `.log` namespace (the SDK's `saved-log.ts`) and no v1 copy.
 */
const savedLogCopyKey = (userId: string, projectId: string, sessionId: string) =>
  `kortix.saved-copy.log:${userId}:${projectId}/${sessionId}`;

/**
 * Every read of the newest page of the session log's root thread from now on: `GET …/log?`.
 * An older page (`before_seq=`) and a sub-agent's thread (`thread=`) are other reads.
 */
function countOpenLogReads(page: Page, sessionId: string): { urls: string[] } {
  const reads = { urls: [] as string[] };
  page.on('request', (request) => {
    const url = request.url();
    if (
      request.method() === 'GET' &&
      url.includes(`/sessions/${sessionId}/log?`) &&
      !url.includes('before_seq=') &&
      !url.includes('thread=')
    ) {
      reads.urls.push(url);
    }
  });
  return reads;
}

function countOpenTranscriptReads(page: Page, sessionId: string): { urls: string[] } {
  const reads = { urls: [] as string[] };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes(`/sessions/${sessionId}/transcript?`) && !url.includes('before=') && !url.includes('child=')) {
      reads.urls.push(url);
    }
  });
  return reads;
}

/** First moment each surface is PAINTED after the reload: hit-testable at its center. */
async function installFirstShown(page: Page, sessionId: string) {
  await page.addInitScript(
    ({ reply, heading, sessionHref }) => {
      const state = { from: performance.now(), marks: {} as Record<string, number> };
      (window as unknown as { __firstShown: typeof state }).__firstShown = state;
      const mark = (key: string) => {
        if (!(key in state.marks)) state.marks[key] = performance.now() - state.from;
      };
      const shown = (el: Element) => {
        if (el.closest('[aria-hidden="true"], [inert]')) return false;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      };
      // A PLACEHOLDER counts once any trace of it is painted: a dismissed
      // overlay fading out is `aria-hidden`, `inert` and click-through, yet the
      // user watches its skeleton rows dissolve over the conversation.
      const painted = (el: Element) => {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        if (box.bottom < 0 || box.right < 0 || box.top > window.innerHeight || box.left > window.innerWidth) {
          return false;
        }
        let opacity = 1;
        for (let node: Element | null = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          opacity *= Number.parseFloat(style.opacity || '1');
        }
        return opacity > 0.05;
      };
      const scan = () => {
        for (const el of Array.from(document.querySelectorAll('[data-testid="saved-session-skeleton"]'))) {
          if (painted(el)) mark('skeleton');
        }
        // The Sessions page's placeholder rows (`SessionListSkeleton`).
        for (const el of Array.from(document.querySelectorAll('[data-testid="session-list-skeleton"]'))) {
          if (painted(el)) mark('listSkeleton');
        }
        for (const h2 of Array.from(document.querySelectorAll('h2'))) {
          if (h2.textContent?.trim() === heading && painted(h2)) mark('bootScreen');
        }
        for (const link of Array.from(document.querySelectorAll(`a[href$="${sessionHref}"]`))) {
          if (shown(link)) mark('sidebarRow');
        }
        const replies = document.evaluate(
          `//*[text()[contains(., "${reply}")]]`,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        for (let i = 0; i < replies.snapshotLength; i++) {
          const node = replies.snapshotItem(i);
          if (node instanceof Element && shown(node)) mark('reply');
        }
      };
      // Sampled once per frame, not on every mutation: a placeholder that a
      // layout effect replaces inside the same task is never painted, and a
      // mutation observer would still count it.
      const frame = () => {
        scan();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    { reply: SAVED_REPLY, heading: BOOT_HEADING, sessionHref: `/sessions/${sessionId}` },
  );
}

async function firstShown(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    () => (window as unknown as { __firstShown: { marks: Record<string, number> } }).__firstShown.marks,
  );
}

type SavedMessages = Parameters<typeof seedSessionTranscript>[1]['messages'];

/**
 * A user, a project and a stopped session with saved history. `store`: the session log, or an
 * old session's v1 mirror, which the first read converts into the log (P8.2).
 */
async function setup(page: Page, label: string, messages?: SavedMessages, store: 'log' | 'mirror' = 'log') {
  const env = loadEnv();
  const email = `instant-${label}-${Date.now()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  const auth = await signIn(email, authOptions);
  const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
    auth.access_token,
    'GET',
    '/accounts',
  );
  const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0]).account_id;
  await fundAccount(env.databaseUrl!, accountId);
  const project = await createManifestProject({
    api,
    accessToken: auth.access_token,
    databaseUrl: env.databaseUrl!,
    accountId,
    userId: user.id,
    name: `Instant loads ${label}`,
  });
  const sessionId = await createDatabaseSession(env, {
    projectId: project.id,
    accountId,
    userId: user.id,
  });
  const seeded = await seedSessionTranscript(env, {
    projectId: project.id,
    accountId,
    sessionId,
    messages,
    ...(store === 'log' && { log: { bearer: auth.access_token } }),
  });
  await runDatabaseSql(
    "UPDATE kortix.project_sessions SET agent_name='kortix' WHERE session_id=$1",
    [sessionId],
    env.databaseUrl ?? undefined,
  );
  // The recordings are PR demos: keep the personal welcome card a new account
  // gets off the session pages they show.
  await page.addInitScript(() => localStorage.setItem('kortix:marko-welcome-dismissed', '1'));
  await installBrowserSessionDirect(page, auth, `/projects/${project.id}`, authOptions);
  await selectAccountForUi(page, accountId);
  await dismissOnboarding(page);
  return { user, auth, accountId, project, sessionId, root: seeded.root, seeded: seeded.messages };
}

test('34 — a reload with every read held shows the project, its session list and the conversation', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { user, project, sessionId } = await setup(page, 'reload');
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  const hold = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    if (holding) await held;
    await route.continue().catch(() => {});
  };
  try {
    // The computer never comes up: the conversation can only come from a saved copy.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    // Once `holding`, every read the reload depends on waits for the end of the test.
    for (const path of ['snapshot', 'transcript', 'log']) {
      await page.route(`**/sessions/${sessionId}/${path}*`, hold);
    }
    await page.route(
      (url) =>
        url.pathname === `${API_PATH}/projects/${project.id}` ||
        url.pathname === `${API_PATH}/projects/${project.id}/sessions`,
      hold,
    );

    // First open, with nothing held: the device keeps what it was shown.
    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(`a[href$="/sessions/${sessionId}"]`).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(
        () =>
          Promise.all([
            readSavedCopy(page, savedLogCopyKey(user.id, project.id, sessionId)),
            page.evaluate(
              (userId) => Object.keys(localStorage).includes(`kortix.query-cache:${userId}`),
              user.id,
            ),
          ]).then(([copy, queryCache]) => ({ savedCopy: copy !== null, queryCache })),
        { timeout: 30_000, message: 'the device keeps the saved copy and the query cache' },
      )
      .toEqual({ savedCopy: true, queryCache: true });

    // Reload with every read held.
    holding = true;
    await installFirstShown(page, sessionId);
    await page.reload({ waitUntil: 'commit' });

    await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(SAVED_PROMPT, { exact: true })).toBeVisible();
    await expect(page.locator(`a[href$="/sessions/${sessionId}"]`).first()).toBeVisible();
    const marks = await firstShown(page);
    await testInfo.attach('first shown after reload (every read held)', {
      body: JSON.stringify(marks, null, 2),
      contentType: 'application/json',
    });
    expect(marks.bootScreen, 'the boot screen must not appear').toBeUndefined();
    expect(marks.skeleton, 'no placeholder rows: the kept copy paints at once').toBeUndefined();
    // One story about the computer: the page's own start is waking it, so the
    // composer says so too, never "idle — your next message wakes it".
    await expect(page.getByText("Waking this session's computer.", { exact: false })).toBeVisible();
    await expect(page.getByText('This session is idle', { exact: false })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('reload-held.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

test('34 — a stopped session with no computer shows its conversation and a live composer, not a card', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { project, sessionId, root } = await setup(page, 'dormant');
  try {
    // A session whose computer was released: `/start` answers stopped, no
    // sandbox row, not retriable — the state that painted a full-screen card.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200,
        json: {
          stage: 'stopped',
          agent_name: 'kortix',
          retriable: false,
          sandbox: null,
          opencode_session_id: root,
          failure: null,
        },
      });
    });

    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });

    await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
    // The SDK's `SESSION_NOTICE.idle`: a sent message wakes the computer and
    // is delivered, so the composer stays and no terminal banner replaces it.
    await expect(
      page.getByText("This session's computer is asleep. Your next message wakes it up and is delivered.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(page.locator('[data-session-notice-banner]')).toHaveCount(0);
    await expect(page.getByText('This session is stopped', { exact: false })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('stopped-composer.png') });
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

const TOOL_COMMAND = 'ls -la dist';
// Only in the tool's output: the reply never names the file, so seeing it
// proves the output itself was drawn.
const TOOL_OUTPUT = 'bundle.min.js';
const TOOL_REPLY = 'The build produced one file.';

/** One saved turn with a finished bash call, exactly as OpenCode stores it. */
const savedToolTurn: SavedMessages = (root) => {
  const created = Date.now() - 60_000;
  const user = 'msg_000000000000000000000001';
  const call = 'msg_000000000000000000000002';
  const reply = 'msg_000000000000000000000003';
  const assistant = (id: string, at: number) => ({
    id,
    sessionID: root,
    parentID: user,
    role: 'assistant',
    time: { created: at, completed: at + 1 },
    agent: 'kortix',
    mode: 'build',
    providerID: 'kortix',
    modelID: 'openai/gpt-5.6-sol',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'stop',
  });
  return [
    {
      info: { id: user, sessionID: root, role: 'user', time: { created }, agent: 'kortix' },
      parts: [
        { id: 'prt_tool_prompt', sessionID: root, messageID: user, type: 'text', text: 'Build the app and list the output.' },
      ],
    },
    {
      info: assistant(call, created + 1),
      parts: [
        {
          id: 'prt_tool_call',
          sessionID: root,
          messageID: call,
          type: 'tool',
          tool: 'bash',
          callID: 'call_list_output',
          state: {
            status: 'completed',
            input: { command: TOOL_COMMAND, description: 'List the build output' },
            output: `total 8\n-rw-r--r--  1 kortix  staff  42 ${TOOL_OUTPUT}\n`,
            title: 'List the build output',
            metadata: { exit: 0, description: 'List the build output' },
            time: { start: created + 1, end: created + 2 },
          },
        },
      ],
    },
    {
      info: assistant(reply, created + 3),
      parts: [{ id: 'prt_tool_reply', sessionID: root, messageID: reply, type: 'text', text: TOOL_REPLY }],
    },
  ];
};

/** A settled turn folds its work behind one "Worked for …" row (#9558); open it. */
const openWork = (scope: Pick<Page, 'getByText'>) => scope.getByText(/^Worked( for .+)?$/).first().click();

test('34 — a saved tool call shows its command and output, from the server and from this device', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { project, sessionId } = await setup(page, 'tools', savedToolTurn);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  const hold = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    if (holding) await held;
    await route.continue().catch(() => {});
  };
  const commandRow = () => page.getByText(TOOL_COMMAND, { exact: true }).first();
  try {
    // The computer never comes up: every tool detail can only come from a saved copy.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    for (const path of ['snapshot', 'transcript', 'log']) {
      await page.route(`**/sessions/${sessionId}/${path}*`, hold);
    }
    await page.route(
      (url) =>
        url.pathname === `${API_PATH}/projects/${project.id}` ||
        url.pathname === `${API_PATH}/projects/${project.id}/sessions`,
      hold,
    );

    // From the server's saved copy.
    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByText(TOOL_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
    await openWork(page);
    await expect(commandRow()).toBeVisible();
    await commandRow().click();
    await expect(page.getByText(TOOL_OUTPUT, { exact: false })).toBeVisible();
    await page.waitForTimeout(500); // the card's open animation, for the screenshot only
    await page.screenshot({ path: testInfo.outputPath('saved-tool-call.png') });

    // From the copy this device kept, with every read held.
    holding = true;
    await page.reload({ waitUntil: 'commit' });
    await expect(page.getByText(TOOL_REPLY, { exact: true })).toBeVisible({ timeout: 15_000 });
    await openWork(page);
    await expect(commandRow()).toBeVisible();
    await commandRow().click();
    await expect(page.getByText(TOOL_OUTPUT, { exact: false })).toBeVisible();
    await page.waitForTimeout(500); // the card's open animation, for the screenshot only
    await page.screenshot({ path: testInfo.outputPath('kept-tool-call.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

const SUBAGENT_TASK = 'Explore the source tree';
const SUBAGENT_COMMAND = 'ls src';
const SUBAGENT_REPLY = 'The sub-agent found two files.';

/** One saved turn that dispatched a sub-agent, and the sub-agent's own transcript. */
const savedSubagentTurn: SavedMessages = (root) => {
  const created = Date.now() - 60_000;
  const child = `ses_sub${root.slice(4, 20)}`;
  const assistant = (session: string, id: string, parent: string, at: number) => ({
    id,
    sessionID: session,
    parentID: parent,
    role: 'assistant',
    time: { created: at, completed: at + 1 },
    agent: 'kortix',
    mode: 'build',
    providerID: 'kortix',
    modelID: 'openai/gpt-5.6-sol',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'stop',
  });
  const text = (session: string, message: string, id: string, value: string) => ({
    id,
    sessionID: session,
    messageID: message,
    type: 'text',
    text: value,
  });
  return [
    {
      info: { id: 'msg_000000000000000000000001', sessionID: root, role: 'user', time: { created }, agent: 'kortix' },
      parts: [text(root, 'msg_000000000000000000000001', 'prt_sub_prompt', 'Delegate the exploration.')],
    },
    {
      info: assistant(root, 'msg_000000000000000000000002', 'msg_000000000000000000000001', created + 1),
      parts: [
        {
          id: 'prt_sub_reasoning',
          sessionID: root,
          messageID: 'msg_000000000000000000000002',
          type: 'reasoning',
          text: 'The tree is large, so a helper lists it.',
          time: { start: created + 1, end: created + 1 },
        },
        {
          id: 'prt_sub_task',
          sessionID: root,
          messageID: 'msg_000000000000000000000002',
          type: 'tool',
          tool: 'task',
          callID: 'call_explore',
          state: {
            status: 'completed',
            input: { description: SUBAGENT_TASK, prompt: 'List the source files.', subagent_type: 'general' },
            output: 'Found two files.',
            title: SUBAGENT_TASK,
            metadata: { sessionId: child },
            time: { start: created + 1, end: created + 5 },
          },
        },
      ],
    },
    {
      info: assistant(root, 'msg_000000000000000000000003', 'msg_000000000000000000000001', created + 6),
      parts: [text(root, 'msg_000000000000000000000003', 'prt_sub_reply', SUBAGENT_REPLY)],
    },
    // The sub-agent's own session.
    {
      info: { id: 'msg_000000000000000000000101', sessionID: child, role: 'user', time: { created: created + 2 }, agent: 'general' },
      parts: [text(child, 'msg_000000000000000000000101', 'prt_child_prompt', 'List the source files.')],
    },
    {
      info: assistant(child, 'msg_000000000000000000000102', 'msg_000000000000000000000101', created + 3),
      parts: [
        {
          id: 'prt_child_call',
          sessionID: child,
          messageID: 'msg_000000000000000000000102',
          type: 'tool',
          tool: 'bash',
          callID: 'call_list_src',
          state: {
            status: 'completed',
            input: { command: SUBAGENT_COMMAND, description: 'List the source files' },
            output: 'main.ts\nutil.ts\n',
            title: 'List the source files',
            metadata: { exit: 0, description: 'List the source files' },
            time: { start: created + 3, end: created + 4 },
          },
        },
      ],
    },
  ];
};

test("34 — a saved sub-agent's steps open while the computer is off", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const { project, sessionId } = await setup(page, 'subagent', savedSubagentTurn);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    // The computer never comes up: the sub-agent's steps can only come from saved history.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });

    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByText(SUBAGENT_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });

    // A finished turn folds its work; the sub-agent row is part of it. Since
    // #9774 each run of work under the fold has its own closed, named line.
    await openWork(page);
    await page.getByRole('button', { name: 'Asked a helper agent', exact: true }).click();
    // The row reads the sub-agent's thread from the session log as it mounts. Until the
    // steps are in hand it is a plain button onto the full view; with them it is a
    // closed disclosure that opens them in place (`TaskTool`). Click it only then.
    const agentRow = page.getByRole('button', { name: new RegExp(SUBAGENT_TASK), expanded: false });
    await expect(agentRow).toBeVisible({ timeout: 30_000 });
    await page.getByText(SUBAGENT_TASK, { exact: true }).first().click();
    await expect(page.getByRole('button', { name: `List the source files ${SUBAGENT_COMMAND}` })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The row's 'View' action opens the sub-agent's whole transcript.
    await page.getByRole('button', { name: 'Open full view', exact: true }).click();
    const view = page.getByRole('dialog');
    await expect(view).toBeVisible();
    // The sub-agent's own settled turn folds the same way.
    await openWork(view);
    await expect(view.getByText(SUBAGENT_COMMAND, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(view.getByText('List the source files.', { exact: true })).toBeVisible();
    await page.waitForTimeout(400); // the view's open animation, for the screenshot only
    await page.screenshot({ path: testInfo.outputPath('saved-subagent.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

/** The same turn, as saved history stored it before it kept tool calls 1:1. */
const strippedToolTurn: SavedMessages = (root) =>
  savedToolTurn(root).map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'tool'
        ? {
            ...part,
            state: {
              status: 'completed',
              title: TOOL_COMMAND,
              metadata: { output: `total 8\n-rw-r--r--  1 kortix  staff  42 ${TOOL_OUTPUT}\n`, exit: 0, truncated: false },
              time: (part.state as { time: unknown }).time,
            },
          }
        : part,
    ),
  }));

test('34 — a tool call saved before tool calls were kept 1:1 shows its command and output', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { project, sessionId } = await setup(page, 'stripped', strippedToolTurn);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commandRow = () => page.getByText(TOOL_COMMAND, { exact: true }).first();
  try {
    // The computer never comes up: the command can only come from saved history.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });

    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByText(TOOL_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
    await openWork(page);
    await expect(commandRow()).toBeVisible();
    await commandRow().click();
    await expect(page.getByText(TOOL_OUTPUT, { exact: false })).toBeVisible();
    await page.waitForTimeout(500); // the card's open animation, for the screenshot only
    await page.screenshot({ path: testInfo.outputPath('stripped-tool-call.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

test('34 — a session proven empty opens on its composer, not the boot screen', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  // A stored session log whose root thread holds no message: what a box that journaled an
  // empty conversation stores. The page's empty root thread proves the session empty.
  const { project, sessionId } = await setup(page, 'empty', () => []);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    // The computer never comes up: nothing but the saved copy can answer.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    await installFirstShown(page, sessionId);

    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(1_000); // long enough for a boot screen to paint, were it coming
    // Never painted in any frame since the navigation. (The collapsed side
    // panel mounts its own hidden loader, as it does for a new session.)
    expect((await firstShown(page)).bootScreen).toBeUndefined();
    await expect(page.getByText(BOOT_HEADING, { exact: true })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('empty-session-composer.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

test("34 — a reload shows the server's newer saved copy, not only the one this device kept", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const env = loadEnv();
  const { user, auth, accountId, project, sessionId, root, seeded } = await setup(page, 'newer-copy');
  const newerPrompt = 'How many tasks are in progress?';
  const newerReply = 'Three tasks are in progress.';
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  try {
    // The computer never comes up: the conversation can only come from a saved copy.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    // After the first open, the session-open snapshot never answers either, so
    // only the saved-history read can bring the newer copy. It waits for a
    // snapshot in flight for 2 s at most (KRTX-189), then asks its route.
    await page.route(`**/sessions/${sessionId}/snapshot*`, async (route) => {
      if (holding) await held;
      await route.continue().catch(() => {});
    });

    // First open: the device keeps the saved copy it was shown.
    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect
      .poll(
        () =>
          readSavedCopy(page, savedLogCopyKey(user.id, project.id, sessionId)).then(
            (copy) => copy?.includes('This reply is stored in the database.') === true,
          ),
        { timeout: 30_000, message: 'the device keeps the saved copy' },
      )
      .toBe(true);

    // A later turn ends while this page is closed: the server saves it.
    const created = Date.now();
    const turn = [
      {
        info: { id: 'msg_000000000000000000000003', sessionID: root, role: 'user', time: { created } },
        parts: [{ id: 'prt_newer_user', type: 'text', text: newerPrompt }],
      },
      {
        info: {
          id: 'msg_000000000000000000000004',
          sessionID: root,
          parentID: 'msg_000000000000000000000003',
          role: 'assistant',
          time: { created: created + 1, completed: created + 2 },
          finish: 'stop',
        },
        parts: [{ id: 'prt_newer_reply', type: 'text', text: newerReply }],
      },
    ];
    await journalSessionLog(env, {
      projectId: project.id,
      accountId,
      sessionId,
      bearer: auth.access_token,
      root,
      messages: [...seeded, ...turn],
    });

    holding = true;
    const transcriptReads = countOpenTranscriptReads(page, sessionId);
    const reads = countOpenLogReads(page, sessionId);
    // The session log owns this history (#10305): the newer turn comes from `GET …/log`.
    const history = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        r.url().includes(`/sessions/${sessionId}/log?`) &&
        !r.url().includes('before_seq=') &&
        !r.url().includes('thread='),
    );
    await page.reload({ waitUntil: 'commit' });
    // The newer turn shows while the computer and the snapshot are still held.
    expect((await history).status()).toBe(200);
    await expect(page.getByText(newerReply, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(newerPrompt, { exact: true })).toBeVisible();
    await expect(page.getByText(SAVED_REPLY, { exact: true })).toHaveCount(1);
    // One saved-history read, not that one plus a second read of the window, and no v1 read.
    expect(reads.urls).toHaveLength(1);
    expect(transcriptReads.urls).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('reload-newer-copy.png') });
    // And the device keeps the newer copy for the next open.
    await expect
      .poll(
        () =>
          readSavedCopy(page, savedLogCopyKey(user.id, project.id, sessionId)).then(
            (copy) => copy?.includes(newerReply) === true,
          ),
        { timeout: 15_000, message: 'the device keeps the newer copy' },
      )
      .toBe(true);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

test('34 — a Sessions page reload shows the kept rows while the manager probe is held', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const env = loadEnv();
  const { user, project, sessionId } = await setup(page, 'sessions-page');
  const title = 'Quarterly report draft';
  await runDatabaseSql(
    "UPDATE kortix.project_sessions SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('custom_name', $2::text) WHERE session_id=$1",
    [sessionId, title],
    env.databaseUrl ?? undefined,
  );
  const row = () => page.getByLabel(`Show details for ${title}`, { exact: true });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  let heldManagerProbes = 0;
  const hold = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    if (holding) await held;
    await route.continue().catch(() => {});
  };
  try {
    // The project row and every session list.
    await page.route(
      (url) =>
        url.pathname === `${API_PATH}/projects/${project.id}` ||
        url.pathname === `${API_PATH}/projects/${project.id}/sessions`,
      hold,
    );
    // Every permission probe, single and batched. The page's scope comes from
    // the single `project.members.manage` probe (`useProjectCan`).
    await page.route(
      (url) => /\/iam\/members\/[^/]+\/effective(:batch)?$/.test(url.pathname),
      async (route) => {
        if (holding && route.request().url().includes('action=project.members.manage')) {
          heldManagerProbes += 1;
        }
        await hold(route);
      },
    );

    // First visit, nothing held: the owner manages the project, so the page
    // reads the 'project' scope, and the device keeps that list. GET only: on a
    // split origin the CORS preflight matches the same URL first.
    const inventory = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `${API_PATH}/projects/${project.id}/sessions` &&
        new URL(response.url()).searchParams.get('scope') === 'project',
      { timeout: 120_000 },
    );
    await page.goto(`/projects/${project.id}/sessions`, { waitUntil: 'commit' });
    expect((await inventory).status()).toBe(200);
    await expect(row()).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(
        () =>
          page.evaluate((userId) => {
            const raw = localStorage.getItem(`kortix.query-cache:${userId}`);
            const stored = raw ? (JSON.parse(raw) as { queries?: { k: unknown[] }[] }) : null;
            return (stored?.queries ?? []).some((entry) => entry.k[4] === 'list-paged' && entry.k[5] === 'project');
          }, user.id),
        { timeout: 30_000, message: "the device keeps the 'project' scope list" },
      )
      .toBe(true);

    // Reload with every session-list and permission read held.
    holding = true;
    await installFirstShown(page, sessionId);
    await page.reload({ waitUntil: 'commit' });

    // Fails on a page that waits for the probe before it picks a scope (the
    // view before KRTX-261): while the probe is pending it reads the 'visible'
    // key, which the device never stored for this owner, so it shows only
    // skeleton rows, and the held probe never answers.
    await expect(row()).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => heldManagerProbes, { message: 'the reload ran with the manager probe unanswered' })
      .toBeGreaterThan(0);
    await page.waitForTimeout(500); // more frames, for a placeholder that comes late
    const marks = await firstShown(page);
    await testInfo.attach('first shown after the Sessions page reload (every read held)', {
      body: JSON.stringify(marks, null, 2),
      contentType: 'application/json',
    });
    expect(marks.listSkeleton, 'no placeholder rows: the kept list paints at once').toBeUndefined();
    await expect(page.getByTestId('session-list-skeleton')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('sessions-page-reload-held.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

test('34 — an open reads the saved copy once: the session-open snapshot carries it, and no transcript read runs', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { project, sessionId } = await setup(page, 'one-read');
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    // The computer never comes up: the conversation can only come from a saved copy.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    const reads = countOpenTranscriptReads(page, sessionId);

    // A first open and a reload. Each one's snapshot answers, and each one
    // used to read the same window again from `GET …/transcript`.
    for (const open of ['first open', 'reload'] as const) {
      const snapshot = page.waitForResponse((r) => r.url().includes(`/sessions/${sessionId}/snapshot`));
      if (open === 'first open') {
        await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
      } else {
        await page.reload({ waitUntil: 'commit' });
      }
      expect((await snapshot).status()).toBe(200);
      await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
      // The racing read started in the mount's first effects, before the
      // snapshot answered; two more seconds catch any late reader.
      await page.waitForTimeout(2_000);
      expect(reads.urls, `${open}: no transcript read beside the snapshot`).toEqual([]);
    }
    await page.screenshot({ path: testInfo.outputPath('one-saved-history-read.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

/** `count` saved turns: a one-line prompt and a three-line reply each, a second apart. */
const savedTurns =
  (count: number): SavedMessages =>
  (root) => {
    const created = Date.now() - 600_000;
    const id = (n: number) => `msg_${String(n).padStart(24, '0')}`;
    return Array.from({ length: count }, (_, k) => {
      const i = k + 1;
      const at = created + i * 1000;
      return [
        {
          info: { id: id(2 * i - 1), sessionID: root, role: 'user', time: { created: at }, agent: 'kortix' },
          parts: [
            {
              id: `prt_older_prompt_${i}`,
              sessionID: root,
              messageID: id(2 * i - 1),
              type: 'text',
              text: `Question ${i}: what is special about the number ${i}?`,
            },
          ],
        },
        {
          info: {
            id: id(2 * i),
            sessionID: root,
            parentID: id(2 * i - 1),
            role: 'assistant',
            time: { created: at + 1, completed: at + 2 },
            agent: 'kortix',
            mode: 'build',
            providerID: 'kortix',
            modelID: 'openai/gpt-5.6-sol',
            path: { cwd: '/workspace', root: '/workspace' },
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: 'stop',
          },
          parts: [
            {
              id: `prt_older_reply_${i}`,
              sessionID: root,
              messageID: id(2 * i),
              type: 'text',
              text: `Answer ${i}.\n\n- ${i} is a whole number.\n- ${i} comes after ${i - 1}.\n- ${i} comes before ${i + 1}.`,
            },
          ],
        },
      ];
    }).flat();
  };

test('34 — loading older messages leaves the turn the reader is reading where it is on screen', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { project, sessionId, root } = await setup(page, 'older', savedTurns(60), 'mirror');
  try {
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200,
        json: { stage: 'stopped', agent_name: 'kortix', retriable: false, sandbox: null, opencode_session_id: root, failure: null },
      });
    });
    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByText('Answer 60.', { exact: true })).toBeVisible({ timeout: 120_000 });
    // The newest page only: the first turn is older history, not drawn yet.
    await expect(page.getByText('Question 1: what is special about the number 1?', { exact: true })).toHaveCount(0);

    // The reader scrolls up into the history sentinel and stops. Their turn is pinned, and its
    // on-screen top is read in every layout pass from the moment the pull starts. The observer is
    // created once the loading row is up — after the page's own observers — so it reads what the
    // browser paints. A read of 0 is the contract: nothing above the reader moves them.
    const result = await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>('[data-follow]')!;
      const content = el.firstElementChild!;
      const turns = () => el.querySelectorAll<HTMLElement>('[data-turn-id]');
      const before = turns().length;
      const rowUp = () => Array.from(el.querySelectorAll('[role="status"]')).some((n) => /older/i.test(n.textContent ?? ''));
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      el.scrollTop = 150;
      const top = el.getBoundingClientRect().top;
      const anchor = Array.from(turns()).find((t) => t.getBoundingClientRect().bottom >= top)!;
      const seen = () => anchor.getBoundingClientRect().top - el.getBoundingClientRect().top;
      const start = seen();
      const shifts: number[] = [];
      let ro: ResizeObserver | null = null;
      let sawRow = false;
      const mo = new MutationObserver(() => {
        if (!rowUp()) return;
        sawRow = true;
        ro ??= new ResizeObserver(() => shifts.push(seen() - start));
        ro.observe(content);
      });
      mo.observe(content, { childList: true, subtree: true });
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const t0 = performance.now();
      while (performance.now() - t0 < 30_000 && !(turns().length > before && sawRow && !rowUp())) await wait(50);
      await wait(1000); // the new turns are contained 500ms after they render
      mo.disconnect();
      ro?.disconnect();
      return {
        turnsBefore: before,
        turnsAfter: turns().length,
        sawRow,
        layoutPasses: shifts.length,
        maxShiftPx: Math.max(0, ...shifts.map((s) => Math.abs(s))),
        finalShiftPx: seen() - start,
      };
    });
    await page.screenshot({ path: testInfo.outputPath('older-history.png') });
    expect(result.sawRow, 'the pull ran and showed its loading row').toBe(true);
    expect(result.turnsAfter, 'the older page rendered above the reader').toBeGreaterThan(result.turnsBefore);
    expect(result.maxShiftPx, `the reader's turn never moved on screen (${JSON.stringify(result)})`).toBeLessThanOrEqual(1);
    expect(Math.abs(result.finalShiftPx), 'and ends where it started').toBeLessThanOrEqual(1);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});
