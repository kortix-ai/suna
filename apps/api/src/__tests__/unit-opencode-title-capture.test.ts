// Deferred title capture (scheduled off the prompt proxy): dedupe per session,
// skip when a real/user title already exists, retry once while OpenCode's
// summarizer is still working, and never surface a failure. Dependencies are
// injected (TitleCaptureOptions) — no process-global module mocks, so this file
// can never contaminate sibling test files in the shared bun process.
import { afterEach, describe, expect, test } from 'bun:test';

import {
  captureTitleAfterRuntimeEvent,
  pendingTitleCaptures,
  scheduleTitleCaptureAfterPrompt,
} from '../projects/opencode-title-capture';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function row(
  metadata: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    accountId: 'account-1',
    opencodeSessionId: null,
    metadata,
    ...overrides,
  } as any;
}

const input = (sessionId = 'session-1') => ({
  sessionId,
  projectId: 'project-1',
  externalId: 'sandbox-ext-1',
});

function harness(opts: {
  loaded: Record<string, unknown> | null;
  syncResult?: Record<string, unknown>;
  syncError?: Error;
}) {
  const syncCalls: Array<Record<string, unknown>> = [];
  return {
    syncCalls,
    options: {
      firstMs: 1,
      retryMs: 1,
      loadRow: async () => opts.loaded as any,
      sync: async (args: any) => {
        syncCalls.push(args);
        if (opts.syncError) throw opts.syncError;
        return (opts.syncResult ?? args.row) as any;
      },
    },
  };
}

afterEach(async () => {
  // Drain any in-flight capture so pending state never leaks across tests.
  await sleep(30);
});

describe('scheduleTitleCaptureAfterPrompt', () => {
  test('dedupes: repeat prompts while a capture is pending schedule nothing new', async () => {
    const h = harness({ loaded: row({ custom_name: 'My session' }) });
    scheduleTitleCaptureAfterPrompt(input(), h.options);
    scheduleTitleCaptureAfterPrompt(input(), h.options);
    expect(pendingTitleCaptures()).toBe(1);
    await sleep(30);
    expect(pendingTitleCaptures()).toBe(0);
  });

  test('skips the sandbox round-trip when a user-set name already exists', async () => {
    const h = harness({ loaded: row({ custom_name: 'My session' }) });
    scheduleTitleCaptureAfterPrompt(input(), h.options);
    await sleep(30);
    expect(h.syncCalls.length).toBe(0);
  });

  test('skips when a real auto title is already mirrored', async () => {
    const h = harness({ loaded: row({ name: 'Ship the wizard' }) });
    scheduleTitleCaptureAfterPrompt(input(), h.options);
    await sleep(30);
    expect(h.syncCalls.length).toBe(0);
  });

  test('captures once when the sync yields a real title (placeholder before)', async () => {
    const h = harness({
      loaded: row({ name: 'New session - 2026-06-29T10:00:00Z' }),
      syncResult: row({ name: 'Ship the wizard' }),
    });
    scheduleTitleCaptureAfterPrompt(input(), h.options);
    await sleep(30);
    expect(h.syncCalls.length).toBe(1);
    expect(pendingTitleCaptures()).toBe(0);
  });

  test('retries exactly once while the summarizer has not titled yet', async () => {
    const h = harness({
      loaded: row({}),
      syncResult: row({ name: 'New session - 2026-06-29T10:00:00Z' }),
    });
    scheduleTitleCaptureAfterPrompt(input(), h.options);
    await sleep(40);
    expect(h.syncCalls.length).toBe(2);
    expect(pendingTitleCaptures()).toBe(0);
  });

  test('a failing sync never throws and clears the pending slot', async () => {
    const h = harness({ loaded: row({}), syncError: new Error('sandbox unreachable') });
    scheduleTitleCaptureAfterPrompt(input(), h.options);
    await sleep(30);
    expect(pendingTitleCaptures()).toBe(0);
  });

  test('missing identifiers are ignored outright', () => {
    const h = harness({ loaded: null });
    scheduleTitleCaptureAfterPrompt({ sessionId: '', projectId: 'p', externalId: 'x' }, h.options);
    expect(pendingTitleCaptures()).toBe(0);
  });
});

describe('captureTitleAfterRuntimeEvent', () => {
  test('persists the exact runtime title without another sandbox read', async () => {
    const persistCalls: unknown[] = [];
    const options = {
      loadRow: async () => row({}),
      persistTitle: async (args: unknown) => {
        persistCalls.push(args);
      },
    };

    await captureTitleAfterRuntimeEvent(
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        opencodeSessionId: 'opencode-root-1',
        title: 'Research Marko Kraemer',
      },
      options,
    );

    expect(persistCalls).toEqual([
      {
        row: expect.objectContaining({ sessionId: 'session-1', projectId: 'project-1' }),
        title: 'Research Marko Kraemer',
      },
    ]);
  });

  test('rejects a child-session title when the Kortix row pins another root', async () => {
    const persistCalls: unknown[] = [];
    await captureTitleAfterRuntimeEvent(
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        opencodeSessionId: 'opencode-child-1',
        title: 'Child task',
      },
      {
        loadRow: async () => row({}, { opencodeSessionId: 'opencode-root-1' }),
        persistTitle: async (args: unknown) => {
          persistCalls.push(args);
        },
      },
    );
    expect(persistCalls).toEqual([]);
  });

  test('deduplicates concurrent runtime title events for one Kortix session', async () => {
    let release = () => {};
    const persistStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistCalls: unknown[] = [];
    const options = {
      loadRow: async () => row({}),
      persistTitle: async (args: unknown) => {
        persistCalls.push(args);
        await persistStarted;
      },
    };
    const event = {
      sessionId: 'session-1',
      projectId: 'project-1',
      opencodeSessionId: 'opencode-root-1',
      title: 'Research Marko Kraemer',
    };

    const first = captureTitleAfterRuntimeEvent(event, options);
    const second = captureTitleAfterRuntimeEvent(event, options);
    await sleep(1);
    expect(persistCalls).toHaveLength(1);
    release();
    await Promise.all([first, second]);
  });

  test('does not discard a distinct root title while another title persists', async () => {
    let release = () => {};
    const persistBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistCalls: Array<{ title: string }> = [];
    const options = {
      loadRow: async () => row({}, { opencodeSessionId: 'opencode-root-1' }),
      persistTitle: async (args: { title: string }) => {
        persistCalls.push(args);
        if (args.title === 'First title') await persistBlocked;
      },
    };

    const first = captureTitleAfterRuntimeEvent(
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        opencodeSessionId: 'opencode-root-1',
        title: 'First title',
      },
      options as Parameters<typeof captureTitleAfterRuntimeEvent>[1],
    );
    const second = captureTitleAfterRuntimeEvent(
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        opencodeSessionId: 'opencode-root-1',
        title: 'Second title',
      },
      options as Parameters<typeof captureTitleAfterRuntimeEvent>[1],
    );

    await sleep(1);
    expect(persistCalls.map((call) => call.title)).toEqual(['First title', 'Second title']);
    release();
    await Promise.all([first, second]);
  });
});
