import { beforeEach, describe, expect, test } from 'bun:test';

import type { Message, Part } from '@kortix/sdk/opencode-client';

import { useSyncStore } from '@/stores/opencode-sync-store';

import { hasUnsettledToolPart } from './idle-reconcile';

// Integration test for the run-complete reconcile MECHANISM, end to end at the
// store level: it drives the real `useSyncStore.hydrate` — exactly what
// `reconcileSessionFromServer` calls with the server's authoritative messages —
// and proves that a tool result left stuck in `pending` at the SSE stream-end
// boundary snaps to `completed`, which is what makes the hard refresh
// unnecessary. No mocks: this is the production store reducer.

const SID = 'ses_test';
const MID = 'msg_assistant_1';
const PID = 'prt_show_1';

function assistant(): Message {
  return {
    id: MID,
    sessionID: SID,
    role: 'assistant',
    time: { created: 1 },
  } as unknown as Message;
}

function showPart(state: {
  status: string;
  input?: Record<string, unknown>;
  output?: string;
}): Part {
  return {
    id: PID,
    messageID: MID,
    sessionID: SID,
    type: 'tool',
    tool: 'show',
    callID: 'call_1',
    state,
  } as unknown as Part;
}

const partStatus = () =>
  (useSyncStore.getState().parts[MID]?.[0] as any)?.state?.status as string | undefined;

const predicate = () => {
  const s = useSyncStore.getState();
  return hasUnsettledToolPart(s.messages[SID] ?? [], s.parts);
};

describe('run-complete reconcile (store integration)', () => {
  beforeEach(() => useSyncStore.getState().reset());

  test('a stuck pending tool result is reconciled to completed by hydrate', () => {
    // 1) Stream-end left the `show` tool part frozen in `pending` (its completed
    //    result event was dropped) — the spinner that hangs until a refresh.
    useSyncStore
      .getState()
      .hydrate(SID, [
        { info: assistant(), parts: [showPart({ status: 'pending', input: { url: 'x' } })] },
      ]);
    expect(partStatus()).toBe('pending');
    // The reconcile gate fires: a genuinely-unsettled tool part is present.
    expect(predicate()).toBe(true);

    // 2) reconcileSessionFromServer fetches the authoritative messages and
    //    hydrates them — the same data a hard refresh loads. The server has the
    //    SAME part id, now `completed` with output.
    useSyncStore.getState().hydrate(SID, [
      {
        info: assistant(),
        parts: [showPart({ status: 'completed', input: { url: 'x' }, output: '{"ok":true}' })],
      },
    ]);

    // 3) The stuck spinner is gone — server's completed snapshot won, no refresh.
    expect(partStatus()).toBe('completed');
    expect((useSyncStore.getState().parts[MID]?.[0] as any)?.state?.output).toBe('{"ok":true}');
    expect(predicate()).toBe(false);
  });

  test('reconcile is idempotent: hydrating an already-completed part is a no-op', () => {
    const completed = {
      info: assistant(),
      parts: [showPart({ status: 'completed', input: { url: 'x' }, output: 'done' })],
    };
    useSyncStore.getState().hydrate(SID, [completed]);
    expect(predicate()).toBe(false);
    // A second reconcile (e.g. a redundant idle edge) must not regress it.
    useSyncStore.getState().hydrate(SID, [completed]);
    expect(partStatus()).toBe('completed');
    expect(predicate()).toBe(false);
  });
});
