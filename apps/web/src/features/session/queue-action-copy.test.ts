import type { CreateSessionPromptInput, RemovedSessionPrompt } from '@kortix/sdk';
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realToast from '@/components/ui/toast';

const errorToast = mock((_message: string, _options?: Record<string, unknown>) => {});
const infoToast = mock((_message: string, _options?: Record<string, unknown>) => {});
const dismissToast = mock((_id: string) => {});
mock.module('@/components/ui/toast', () => ({
  ...realToast,
  errorToast,
  infoToast,
  dismissToast,
}));

const {
  QUEUE_REMOVED_KEY,
  QUEUE_RESUME_FAILED_DESCRIPTION_KEY,
  QUEUE_RESUME_FAILED_KEY,
  QUEUE_UNDO_KEY,
  createQueueRemoveHandler,
  queueResumeFailedToast,
  removeFailureCopyKey,
  restoreFailureCopyKey,
  retryFailureCopyKey,
} = await import('./queue-action-copy');

type PromptActionFailure = import('./queue-action-copy').PromptActionFailure;

/** The classifier's own vocabulary, so the table cannot drift from the SDK. */
const failures = [
  'gone',
  'already_sent',
  'unreachable',
  'pending',
  'failed',
] as const satisfies readonly PromptActionFailure[];

/**
 * `tsc --noEmit` fails here the day the SDK adds a sixth classification and
 * this file's table does not list it. Without this the runtime loops below
 * would keep passing over a stale five-value tuple.
 */
type AssertNever<T extends never> = T;
type _FailuresTupleIsExhaustive = AssertNever<
  Exclude<PromptActionFailure, (typeof failures)[number]>
>;

function removed(overrides: Partial<RemovedSessionPrompt> = {}): RemovedSessionPrompt {
  return {
    prompt_id: 'cmd_1',
    client_message_id: 'cm_1',
    message_id: 'msg_1',
    parts: [{ type: 'text', text: 'ship it' }],
    overrides: null,
    ...overrides,
  };
}

function apiError(status: number, code?: string): Error {
  return Object.assign(new Error('Not found'), { name: 'ApiError', status, code });
}

beforeEach(() => {
  errorToast.mockClear();
  infoToast.mockClear();
  dismissToast.mockClear();
});

describe('removeFailureCopyKey', () => {
  const table = [
    ['gone', 'i18nComplete.text128773c76940'],
    ['already_sent', 'i18nComplete.text3e739b3b4329'],
    ['unreachable', 'i18nComplete.text42fcd9dda5f6'],
    ['failed', 'i18nComplete.text42fcd9dda5f6'],
    ['pending', null],
  ] as const;
  for (const [failure, key] of table) {
    test(`${failure} → ${key}`, () => {
      expect(removeFailureCopyKey(failure)).toBe(key);
    });
  }

  test("every classification in this file's tuple maps to a key or to null", () => {
    // The tuple itself is held to the SDK's union by `_FailuresTupleIsExhaustive`.
    for (const failure of failures) expect(removeFailureCopyKey(failure)).not.toBeUndefined();
  });
});

describe('retryFailureCopyKey', () => {
  const table = [
    // The row is gone from the list, and it is being sent: both are the outcome
    // the user asked for, so neither is an error.
    ['gone', null],
    ['already_sent', null],
    ['pending', null],
    ['unreachable', 'i18nComplete.text4869b2a820dd'],
    ['failed', 'i18nComplete.text4869b2a820dd'],
  ] as const;
  for (const [failure, key] of table) {
    test(`${failure} → ${key}`, () => {
      expect(retryFailureCopyKey(failure)).toBe(key);
    });
  }

  test("every classification in this file's tuple maps to a key or to null", () => {
    for (const failure of failures) expect(retryFailureCopyKey(failure)).not.toBeUndefined();
  });
});

describe('restoreFailureCopyKey', () => {
  test('a refused restore says so once', () => {
    expect(restoreFailureCopyKey(apiError(409, 'prompt_already_sent'))).toBe(
      'i18nComplete.text8af21acebf14',
    );
    expect(restoreFailureCopyKey(new Error('boom'))).toBe('i18nComplete.text8af21acebf14');
  });

  test('a 402 paints nothing — the host upgrade dialog owns that outcome', () => {
    expect(restoreFailureCopyKey(apiError(402))).toBeNull();
  });
});

describe('createQueueRemoveHandler', () => {
  const copy = (key: string) => `copy:${key}`;

  test('a removal paints one "Removed from queue" toast with an Undo button', async () => {
    const enqueued: CreateSessionPromptInput[] = [];
    const seen: RemovedSessionPrompt[] = [];
    const handle = createQueueRemoveHandler({
      sessionId: 's1',
      copy,
      remove: async () => removed(),
      enqueue: async (input) => void enqueued.push(input),
      mintMessageId: () => 'msg_fresh',
      onRemoved: (row) => seen.push(row),
    });

    await handle('cmd_1');

    expect(errorToast).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(infoToast).toHaveBeenCalledTimes(1);
    const [message, options] = infoToast.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe(copy(QUEUE_REMOVED_KEY));
    // One id per removed row, so two removals stack and a repeat collapses.
    expect(options.id).toBe('queue-undo-s1-cmd_1');
    const button = options.button as { props: { onClick: () => void; children: string } };
    expect(button.props.children).toBe(copy(QUEUE_UNDO_KEY));

    button.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].clientMessageId).toBe('cm_1');
    expect(dismissToast).toHaveBeenCalledWith('queue-undo-s1-cmd_1');
  });

  const refusals = [
    [404, 'prompt_not_found', 'i18nComplete.text128773c76940'],
    [409, 'prompt_already_sent', 'i18nComplete.text3e739b3b4329'],
    [409, 'prompt_cancel_unreachable', 'i18nComplete.text42fcd9dda5f6'],
    [500, undefined, 'i18nComplete.text42fcd9dda5f6'],
  ] as const;
  for (const [status, code, key] of refusals) {
    test(`a ${status} ${code ?? 'bare'} refusal paints exactly one mapped toast`, async () => {
      const handle = createQueueRemoveHandler({
        sessionId: 's1',
        copy,
        remove: async () => {
          throw apiError(status, code);
        },
        enqueue: async () => {},
        mintMessageId: () => 'msg_fresh',
      });

      await handle('cmd_1');

      expect(infoToast).not.toHaveBeenCalled();
      expect(errorToast.mock.calls).toEqual([[copy(key)]]);
    });
  }

  test('the raw server prose never reaches a toast', async () => {
    const handle = createQueueRemoveHandler({
      sessionId: 's1',
      copy,
      remove: async () => {
        throw apiError(404, 'prompt_not_found');
      },
      enqueue: async () => {},
      mintMessageId: () => 'msg_fresh',
    });

    await handle('cmd_1');

    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(errorToast.mock.calls[0][0]).not.toContain('Not found');
  });

  test('the other action on the row is still running: nothing is said', async () => {
    const handle = createQueueRemoveHandler({
      sessionId: 's1',
      copy,
      remove: async () => {
        throw Object.assign(new Error('retry in flight'), { code: 'prompt_action_pending' });
      },
      enqueue: async () => {},
      mintMessageId: () => 'msg_fresh',
    });

    await handle('cmd_1');

    expect(errorToast).not.toHaveBeenCalled();
    expect(infoToast).not.toHaveBeenCalled();
  });

  test('a refused Undo paints one toast, and a 402 paints none', async () => {
    const undoOf = async (cause: unknown) => {
      const handle = createQueueRemoveHandler({
        sessionId: 's1',
        copy,
        remove: async () => removed(),
        enqueue: async () => {
          throw cause;
        },
        mintMessageId: () => 'msg_fresh',
      });
      await handle('cmd_1');
      const options = infoToast.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      (options.button as { props: { onClick: () => void } }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    };

    await undoOf(apiError(409, 'prompt_already_sent'));
    expect(errorToast.mock.calls).toEqual([[copy('i18nComplete.text8af21acebf14')]]);

    errorToast.mockClear();
    await undoOf(apiError(402));
    expect(errorToast).not.toHaveBeenCalled();
  });
});

describe('queueResumeFailedToast', () => {
  const copy = (key: string) => `copy:${key}`;

  test('one toast, with the same title AND description on every surface', () => {
    // SessionChat painted title + "Try again in a moment."; the boot shell
    // painted the title alone. The same failure now reads the same everywhere.
    queueResumeFailedToast(copy);

    expect(errorToast.mock.calls).toEqual([
      [copy(QUEUE_RESUME_FAILED_KEY), { description: copy(QUEUE_RESUME_FAILED_DESCRIPTION_KEY) }],
    ]);
  });
});

describe('queue copy keys', () => {
  test('every key this module names exists in the English catalogue', async () => {
    const en = (await import('@/../translations/en.json')).default as {
      hardcodedUi: { i18nComplete: Record<string, string> };
    };
    const keys = [
      QUEUE_REMOVED_KEY,
      QUEUE_UNDO_KEY,
      QUEUE_RESUME_FAILED_KEY,
      QUEUE_RESUME_FAILED_DESCRIPTION_KEY,
      removeFailureCopyKey('gone'),
      removeFailureCopyKey('already_sent'),
      removeFailureCopyKey('failed'),
      retryFailureCopyKey('failed'),
      restoreFailureCopyKey(new Error('boom')),
    ].filter((key): key is string => typeof key === 'string');
    for (const key of keys) {
      expect(en.hardcodedUi.i18nComplete[key.replace('i18nComplete.', '')]).toBeTruthy();
    }
  });
});
