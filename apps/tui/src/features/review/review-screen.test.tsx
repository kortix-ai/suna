import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import type { ChangeRow } from './change-list.tsx';
import { type DiffPayload, type ReviewActions, ReviewView } from './review-screen.tsx';
import { TWO_FILE_PATCH } from './test-patch.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 86, height: 24 };
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const HOUR = 3_600_000;

function rows(): ChangeRow[] {
  return [
    {
      crId: 'cr-open',
      number: 12,
      title: 'Tighten the boot path',
      status: 'open',
      baseRef: 'main',
      headRef: 'session/abc',
      createdAtMs: NOW - 3 * HOUR,
      originSessionId: 'sess-1111-2222',
      headCommitSha: 'abcdef1234567',
    },
    {
      crId: 'cr-merged',
      number: 11,
      title: 'Add the changelog',
      status: 'merged',
      baseRef: 'main',
      headRef: 'session/def',
      createdAtMs: NOW - 26 * HOUR,
      originSessionId: null,
      headCommitSha: null,
    },
  ];
}

const PAYLOAD: DiffPayload = {
  base_ref: 'main',
  head_ref: 'session/abc',
  patch: TWO_FILE_PATCH,
  additions: 3,
  deletions: 1,
};

interface Calls {
  diffs: string[];
  merged: string[];
  closed: string[];
  refreshes: number;
  toasts: string[];
  sessions: string[];
  backs: number;
}

function harness(overrides: Partial<ReviewActions> = {}, rowList: ChangeRow[] = rows()) {
  const calls: Calls = {
    diffs: [],
    merged: [],
    closed: [],
    refreshes: 0,
    toasts: [],
    sessions: [],
    backs: 0,
  };
  const actions: ReviewActions = {
    loadDiff: async (crId: string) => {
      calls.diffs.push(crId);
      return PAYLOAD;
    },
    merge: async (crId: string) => {
      calls.merged.push(crId);
      return 'fedcba9876543';
    },
    close: async (crId: string) => {
      calls.closed.push(crId);
    },
    refresh: () => {
      calls.refreshes += 1;
    },
    ...overrides,
  };
  const element = (
    <ReviewView
      rows={rowList}
      actions={actions}
      focused
      width={SIZE.width}
      height={SIZE.height}
      loading={false}
      errorMessage={null}
      now={NOW}
      onBack={() => {
        calls.backs += 1;
      }}
      onOpenSession={(sessionId) => calls.sessions.push(sessionId)}
      onToast={(message, kind) => calls.toasts.push(`${kind ?? 'info'}: ${message}`)}
    />
  );
  return { element, calls };
}

async function settle(flush: () => Promise<void>, ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

async function press(
  mockInput: { pressKey: (key: string) => void },
  flush: () => Promise<void>,
  key: string,
): Promise<void> {
  await act(async () => {
    mockInput.pressKey(key);
  });
  await settle(flush);
}

describe('<ReviewView/> through the OpenTUI test renderer', () => {
  test('renders one row per change request with its number, title, status and age', async () => {
    const { element } = harness();
    const { captureCharFrame, flush, renderer } = await testRender(element, SIZE);
    await settle(flush);

    const frame = captureCharFrame();
    expect(frame).toContain('#12 Tighten the boot path');
    expect(frame).toContain('#11 Add the changelog');
    // Open rows carry `●`, merged rows `✓`.
    const openRow = frame.split('\n').find((line) => line.includes('#12'));
    const mergedRow = frame.split('\n').find((line) => line.includes('#11'));
    expect(openRow).toContain('●');
    expect(mergedRow).toContain('✓');
    // Ages, against the fixed `now` prop.
    expect(openRow).toContain('3h');
    expect(mergedRow).toContain('1d');
    // The detail block follows the cursor, which starts on the first row.
    expect(frame).toContain('open · into main');
    expect(frame).toContain('abcdef1 · session sess-111');
    renderer.destroy();
  });

  test('Enter opens the diff and s toggles unified/split', async () => {
    const { element, calls } = harness();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);

    await act(async () => {
      mockInput.pressEnter();
    });
    await settle(flush, 150);

    expect(calls.diffs).toEqual(['cr-open']);
    const unified = captureCharFrame();
    expect(unified).toContain('#12 Tighten the boot path');
    expect(unified).toContain('1/2 src/app.ts');
    expect(unified).toContain('· unified');
    expect(unified).toContain('const extra = 4;');

    await press(mockInput, flush, 's');
    const split = captureCharFrame();
    expect(split).toContain('· split');
    // Split view puts the old side and the new side on the same row.
    const changedRow = split.split('\n').find((line) => line.includes('const stop = 2;'));
    expect(changedRow).toContain('const stop = 3;');

    await press(mockInput, flush, 's');
    expect(captureCharFrame()).toContain('· unified');
    renderer.destroy();
  });

  test('n and p step through the files of the diff', async () => {
    const { element } = harness();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);
    await act(async () => {
      mockInput.pressEnter();
    });
    await settle(flush, 150);

    await press(mockInput, flush, 'n');
    expect(captureCharFrame()).toContain('2/2 README.md');
    // The last file is the end of the walk, not a wrap.
    await press(mockInput, flush, 'n');
    expect(captureCharFrame()).toContain('2/2 README.md');
    await press(mockInput, flush, 'p');
    expect(captureCharFrame()).toContain('1/2 src/app.ts');
    renderer.destroy();
  });

  test('m asks first, then merges through the injected action', async () => {
    const { element, calls } = harness();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);

    await press(mockInput, flush, 'm');
    const confirm = captureCharFrame();
    expect(confirm).toContain('Merge change request');
    expect(confirm).toContain('into main · this writes to the repository');
    expect(calls.merged).toEqual([]);

    await press(mockInput, flush, 'y');
    await settle(flush, 120);
    expect(calls.merged).toEqual(['cr-open']);
    expect(calls.toasts).toContain('info: Merged #12 as fedcba9');
    renderer.destroy();
  });

  test('Esc cancels the confirm without writing', async () => {
    const { element, calls } = harness();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);

    await press(mockInput, flush, 'x');
    expect(captureCharFrame()).toContain('Close change request');
    await act(async () => {
      mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flush();
    expect(calls.closed).toEqual([]);
    expect(captureCharFrame()).toContain('#12 Tighten the boot path');
    renderer.destroy();
  });

  test('a says approve is merge and writes nothing', async () => {
    const { element, calls } = harness();
    const { flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);

    await press(mockInput, flush, 'a');
    expect(calls.merged).toEqual([]);
    expect(calls.closed).toEqual([]);
    expect(calls.toasts).toEqual([
      'error: Approve is not a Kortix action: merging IS approving. Press m.',
    ]);
    renderer.destroy();
  });

  test('m on a merged change request refuses instead of calling the SDK', async () => {
    const { element, calls } = harness();
    const { flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);

    await press(mockInput, flush, 'j');
    await press(mockInput, flush, 'm');
    expect(calls.merged).toEqual([]);
    expect(calls.toasts).toEqual(['error: #11 is merged; nothing to merge.']);
    renderer.destroy();
  });

  test('o hands the origin session to the host, and says so when there is none', async () => {
    const { element, calls } = harness();
    const { flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);

    await press(mockInput, flush, 'o');
    expect(calls.sessions).toEqual(['sess-1111-2222']);

    await press(mockInput, flush, 'j');
    await press(mockInput, flush, 'o');
    expect(calls.sessions).toEqual(['sess-1111-2222']);
    expect(calls.toasts).toContain('error: This change request has no origin session.');
    renderer.destroy();
  });

  test('a failed diff read renders the message instead of an empty pane', async () => {
    const { element } = harness({
      loadDiff: async () => {
        throw new Error('merge base not found');
      },
    });
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);
    await act(async () => {
      mockInput.pressEnter();
    });
    await settle(flush, 150);
    expect(captureCharFrame()).toContain('merge base not found');
    renderer.destroy();
  });

  test('an empty project says so and Esc leaves the screen', async () => {
    const { element, calls } = harness({}, []);
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush);
    expect(captureCharFrame()).toContain('No change requests.');
    await act(async () => {
      mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flush();
    expect(calls.backs).toBe(1);
    renderer.destroy();
  });
});
