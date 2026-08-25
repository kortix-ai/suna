/**
 * Closing the modal must not strand the agent.
 *
 * The browser poll is what persists the credential and tells the waiting agent,
 * so when the human closed the modal the poll died with it: Google completed,
 * the account landed at the provider, and the session was never told. Pipedream
 * masked this with its connect webhook; Composio has none, so the browser was
 * the only completion path.
 */
import { expect, mock, test } from 'bun:test';

let finalizeResults: Array<{ connected: boolean }> = [];
let finalizeCalls = 0;
const notified: Array<Record<string, unknown>> = [];

mock.module('../connectors/db-deps', () => ({
  dbConnectorRouterDeps: {
    connectorFinalize: async () => {
      const next = finalizeResults[Math.min(finalizeCalls, finalizeResults.length - 1)];
      finalizeCalls += 1;
      if (!next) throw new Error('provider blip');
      return { provider: 'composio', ...next };
    },
  },
}));

// Deliberately NOT mocking ../connectors/notify-session: it is shared with the
// public-app suite, and stubbing a shared module leaks across files even under
// --isolate. Mock what it depends on instead, which also exercises the real
// notifier rather than a stand-in.
mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ status: 'stopped', accountId: 'acct-1', metadata: {} }] }),
      }),
    }),
  },
}));
mock.module('../projects/session-lifecycle', () => ({
  enqueueContinueSessionCommand: async (input: Record<string, unknown>) => {
    notified.push({
      sessionId: input.sessionId,
      projectId: input.projectId,
      uid: input.actorUserId,
      slug: 'gmail',
      app: 'gmail',
      idempotencyKey: input.idempotencyKey,
    });
    return { row: {}, deduped: false };
  },
  drainSessionLifecycleQueue: async () => ({}),
}));

const { watchConnectorCompletion, connectorCompletionWatchActive } = await import(
  './connector-completion-watch'
);

const base = { projectId: 'p1', slug: 'gmail', app: 'gmail', sid: 's1', uid: 'u1' };
const noSleep = async () => {};

async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

test('a connect completed after the modal closed still tells the agent', async () => {
  finalizeCalls = 0; notified.length = 0;
  finalizeResults = [{ connected: false }, { connected: false }, { connected: true }];
  watchConnectorCompletion({ ...base, sleep: noSleep });
  await settle();
  expect(notified).toHaveLength(1);
  expect(notified[0]).toMatchObject({
    sessionId: 's1',
    projectId: 'p1',
    idempotencyKey: 'connector-connected:s1:gmail',
  });
});

test('no session waiting → no watch, because there is nobody to tell', async () => {
  finalizeCalls = 0; notified.length = 0;
  finalizeResults = [{ connected: true }];
  watchConnectorCompletion({ ...base, sid: null, sleep: noSleep });
  await settle();
  expect(notified).toHaveLength(0);
  expect(connectorCompletionWatchActive('p1', 'gmail')).toBe(false);
});

test('reopening the link does not stack a second watch', async () => {
  finalizeCalls = 0; notified.length = 0;
  finalizeResults = [{ connected: true }];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  watchConnectorCompletion({ ...base, slug: 'held', sleep: () => held });
  expect(connectorCompletionWatchActive('p1', 'held')).toBe(true);
  watchConnectorCompletion({ ...base, slug: 'held', sleep: () => held });
  release();
  await settle();
  expect(notified).toHaveLength(1);
});

test('the window closes instead of polling forever', async () => {
  finalizeCalls = 0; notified.length = 0;
  finalizeResults = [{ connected: false }];
  let clock = 0;
  watchConnectorCompletion({
    ...base,
    slug: 'never',
    now: () => (clock += 60_000),
    sleep: noSleep,
  });
  await settle();
  expect(notified).toHaveLength(0);
  expect(connectorCompletionWatchActive('p1', 'never')).toBe(false);
});
