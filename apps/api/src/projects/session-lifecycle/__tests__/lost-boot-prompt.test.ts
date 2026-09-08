// reconcileLostBootPrompts() — the BOOT-prompt loss backstop.
//
// A session created with `initial_prompt` never enters the prompt inbox: the
// daemon claims the text at boot and POSTs it to its own OpenCode. When
// OpenCode does not persist that message the daemon reports `turn_abandoned`,
// the record is deleted, and nothing retries — the run is silently empty
// forever (local incident, 2026-08-31: 7 of 10 sessions).
//
// The rules this pins are the ones that make the recovery SAFE to run
// automatically against work that costs real money:
//   - a session with ANY accepted turn is never recovered (it already ran);
//   - recovery is at most once per session;
//   - it is bounded to a window, so a stale run is left to the next trigger.
//
// Mocks are process-global (`mock.module`) — run this file in its own
// `bun test <file>` invocation, same caveat as ./undelivered-prompts.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface EnqueueCall {
  sessionId: string;
  idempotencyKey?: string | null;
  text: string;
  source: string;
  actorUserId: string | null;
  overrides?: { agent?: string };
}

let enqueueCalls: EnqueueCall[] = [];
let dedupeNext = false;
let enqueueThrows: string | null = null;
let errorLogs: Array<{ message: string; context?: Record<string, unknown> }> = [];
/** Rows the mocked drizzle chain answers with. */
let queryRows: Array<Record<string, unknown>> = [];
let queryThrows: string | null = null;
let capturedLimit: number | null = null;

mock.module('../../../lib/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, context?: Record<string, unknown>) => {
      errorLogs.push({ message, context });
    },
  },
}));

// `selectDistinct(...).from(...).innerJoin(...).where(...).limit(n)` is the
// whole chain; `limit` is the awaited terminal.
mock.module('../../../shared/db', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['selectDistinct', 'from', 'innerJoin', 'where']) {
    chain[method] = () => chain;
  }
  chain.limit = (n: number) => {
    capturedLimit = n;
    if (queryThrows) return Promise.reject(new Error(queryThrows));
    return Promise.resolve(queryRows);
  };
  return { db: chain };
});

mock.module('../store', () => ({
  enqueueContinueSessionCommand: async (input: EnqueueCall) => {
    enqueueCalls.push(input);
    if (enqueueThrows) throw new Error(enqueueThrows);
    return { row: { commandId: `cmd-${enqueueCalls.length}` }, deduped: dedupeNext };
  },
}));

const {
  LOST_BOOT_PROMPT_BATCH,
  LOST_BOOT_PROMPT_GRACE_MS,
  LOST_BOOT_PROMPT_MAX_AGE_MS,
  lostBootPromptIdempotencyKey,
  lostBootPromptOverrides,
  normalizeSource,
  reconcileLostBootPrompts,
} = await import('../lost-boot-prompt');

/** The real shape of a stuck trigger run (ca470c15 in the incident). */
function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'ca470c15-d7e7-482a-9dac-7e457d0ed9a2',
    projectId: 'a8c26b38-36c8-4677-9786-afa0f73047f2',
    accountId: 'e512c414-f24e-4316-92cb-26a5f914038e',
    createdBy: 'ec96de50-1e2a-4a33-a5a1-bda7a81c082e',
    agentName: 'kortix-monalisa',
    initialPrompt: 'Load the `monalisa-monday` skill and run the pipeline',
    source: 'trigger:cron',
    ...overrides,
  };
}

beforeEach(() => {
  enqueueCalls = [];
  dedupeNext = false;
  enqueueThrows = null;
  errorLogs = [];
  queryRows = [];
  queryThrows = null;
  capturedLimit = null;
});

describe('lostBootPromptIdempotencyKey', () => {
  test('is per session, so a session can only ever be recovered once', () => {
    expect(lostBootPromptIdempotencyKey('sess-a')).toBe('lost-boot-prompt:sess-a');
    expect(lostBootPromptIdempotencyKey('sess-a')).toBe(lostBootPromptIdempotencyKey('sess-a'));
    expect(lostBootPromptIdempotencyKey('sess-b')).not.toBe(lostBootPromptIdempotencyKey('sess-a'));
  });
});

describe('lostBootPromptOverrides', () => {
  test("carries the trigger's own agent so the rerun is not the runtime default", () => {
    expect(lostBootPromptOverrides('kortix-monalisa')).toEqual({ agent: 'kortix-monalisa' });
  });

  test('omits the sentinel and empty names', () => {
    expect(lostBootPromptOverrides('default')).toBeUndefined();
    expect(lostBootPromptOverrides('   ')).toBeUndefined();
    expect(lostBootPromptOverrides(null)).toBeUndefined();
  });
});

describe('normalizeSource', () => {
  test('keeps a known invocation source', () => {
    expect(normalizeSource('trigger:cron')).toBe('trigger:cron');
    expect(normalizeSource('trigger:webhook')).toBe('trigger:webhook');
    expect(normalizeSource('slack')).toBe('slack');
  });

  test('falls back for free-form or missing metadata text', () => {
    // `metadata.source` is untyped text in the row; an unknown value must not
    // reach the enum-typed column.
    expect(normalizeSource('trigger:cron:v2')).toBe('trigger:cron');
    expect(normalizeSource(undefined)).toBe('trigger:cron');
    expect(normalizeSource(42)).toBe('trigger:cron');
  });
});

describe('window constants', () => {
  test('grace is shorter than the max age, so the window is non-empty', () => {
    expect(LOST_BOOT_PROMPT_GRACE_MS).toBeLessThan(LOST_BOOT_PROMPT_MAX_AGE_MS);
  });

  test('the batch is bounded — this is a backstop, not a queue', () => {
    expect(LOST_BOOT_PROMPT_BATCH).toBeGreaterThan(0);
    expect(LOST_BOOT_PROMPT_BATCH).toBeLessThanOrEqual(50);
  });
});

describe('reconcileLostBootPrompts', () => {
  test('no candidates is a silent no-op', async () => {
    const result = await reconcileLostBootPrompts(new Date('2026-08-31T15:10:00.000Z'));

    expect(result).toEqual({ scanned: 0, requeued: 0, deduped: 0, errors: 0 });
    expect(enqueueCalls).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });

  test('requeues a lost boot prompt into the inbox with its own agent', async () => {
    queryRows = [candidateRow()];

    const result = await reconcileLostBootPrompts(new Date('2026-08-31T15:10:00.000Z'));

    expect(result).toEqual({ scanned: 1, requeued: 1, deduped: 0, errors: 0 });
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0].sessionId).toBe('ca470c15-d7e7-482a-9dac-7e457d0ed9a2');
    expect(enqueueCalls[0].text).toBe('Load the `monalisa-monday` skill and run the pipeline');
    expect(enqueueCalls[0].idempotencyKey).toBe(
      'lost-boot-prompt:ca470c15-d7e7-482a-9dac-7e457d0ed9a2',
    );
    // Attributed to the trigger, not to a human.
    expect(enqueueCalls[0].source).toBe('trigger:cron');
    expect(enqueueCalls[0].actorUserId).toBe('ec96de50-1e2a-4a33-a5a1-bda7a81c082e');
    expect(enqueueCalls[0].overrides).toEqual({ agent: 'kortix-monalisa' });
  });

  test('a requeue is LOUD — the runtime dropped a prompt', async () => {
    queryRows = [candidateRow()];

    await reconcileLostBootPrompts(new Date('2026-08-31T15:10:00.000Z'));

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].message).toContain('boot prompt was never delivered');
    expect(errorLogs[0].context?.session_id).toBe('ca470c15-d7e7-482a-9dac-7e457d0ed9a2');
  });

  test('a deduped enqueue is not counted as a rerun and is not loud', async () => {
    // The second sweep over a session already recovered. This is what keeps a
    // trigger from being run twice by a repeating maintenance tick.
    queryRows = [candidateRow()];
    dedupeNext = true;

    const result = await reconcileLostBootPrompts(new Date('2026-08-31T15:10:00.000Z'));

    expect(result).toEqual({ scanned: 1, requeued: 0, deduped: 1, errors: 0 });
    expect(errorLogs).toHaveLength(0);
  });

  test('drops a row whose prompt text is blank rather than sending an empty turn', async () => {
    queryRows = [candidateRow({ initialPrompt: '   ' }), candidateRow({ initialPrompt: null })];

    const result = await reconcileLostBootPrompts(new Date('2026-08-31T15:10:00.000Z'));

    expect(result.scanned).toBe(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  test('one failed requeue does not abort the batch', async () => {
    queryRows = [candidateRow({ sessionId: 'sess-1' }), candidateRow({ sessionId: 'sess-2' })];
    enqueueThrows = 'unique violation';

    const result = await reconcileLostBootPrompts(new Date('2026-08-31T15:10:00.000Z'));

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(2);
    expect(enqueueCalls).toHaveLength(2);
  });

  test('a failed scan is reported, never thrown into the maintenance sweep', async () => {
    queryThrows = 'connection terminated';

    const result = await reconcileLostBootPrompts(new Date('2026-08-31T15:10:00.000Z'));

    expect(result).toEqual({ scanned: 0, requeued: 0, deduped: 0, errors: 1 });
    expect(errorLogs[0].message).toContain('candidate scan failed');
  });

  test('the scan is bounded to the batch size', async () => {
    await reconcileLostBootPrompts(new Date('2026-08-31T15:10:00.000Z'));

    expect(capturedLimit).toBe(LOST_BOOT_PROMPT_BATCH);
  });
});
