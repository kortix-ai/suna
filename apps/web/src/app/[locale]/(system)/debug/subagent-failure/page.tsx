'use client';

/**
 * /debug/subagent-failure — KRTX-1746 visual harness.
 *
 * A failed subagent dispatch (`task` tool, child id in its error text) must
 * render as a DISPATCH row — "Open full view" onto the child's transcript —
 * not collapse into the generic "Task failed" card that has no way into the
 * child session. This page seeds the exact shapes the runtime writes on a
 * failed dispatch (read off opencode 1.18.23 with a mock provider) into the
 * SDK session store — parent transcript, child transcript — and renders them
 * through `ToolPartRenderer` with the tool renderers registered, exactly as a
 * live session would. No network, no runtime.
 *
 * Rows: the failed dispatch (the fix's subject), the same failure without a
 * child id (stays the generic card — nothing to open), and a completed
 * dispatch for contrast. The child session is seeded so "Open full view"
 * shows the child's real transcript in the modal.
 */

import '@kortix/ui/session/tool/tools/register';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { ToolSurfaceContext, ToolPartRenderer, TurnLiveContext } from '@kortix/ui/session';
import { useSessionStateStore } from '@kortix/sdk/react';
import type { ToolCallBlock } from '@kortix/sdk';

const PARENT_SESSION = 'ses_krtx1746_parent';
const CHILD_SESSION = 'ses_ee95c107bffe49S04KWqZ5tjcc';

/** 2026-10-07T12:00:00.000Z — timestamps must be absolute, not epoch offsets. */
const FIXTURE_T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

const FAILED_REASON =
  'Subagent failed (task_id: ses_ee95c107bffe49S04KWqZ5tjcc): This model does not support assistant message prefill. The conversation must end with a user message.';

const TASK_INPUT = {
  subagent_type: 'general',
  description: 'Report on the widget',
  prompt: 'Write the quarterly report on the widget. TASK_MARKER_ALFA.',
};

/** The child id rides in the error text (`task_id: …`), which is where the
 *  renderer reads it (`getChildSessionId`). */
const FAILED_TASK_CALL = {
  type: 'tool_call',
  id: 'prt_failed_task',
  call_id: 'call_failed_task',
  name: 'task',
  kind: 'task',
  input: TASK_INPUT,
  status: 'error',
  result: { content: [{ type: 'text', text: FAILED_REASON }], is_error: true, error: { message: FAILED_REASON } },
  started_at: new Date(1_000).toISOString(),
  ended_at: new Date(3_400).toISOString(),
} satisfies ToolCallBlock;

const ORPHAN_REASON = 'Error: Unknown agent type: researcher is not a valid agent type. Available: general, explore';
const ORPHAN_TASK_CALL = {
  ...FAILED_TASK_CALL,
  id: 'prt_orphan_task',
  call_id: 'call_orphan_task',
  result: { content: [{ type: 'text', text: ORPHAN_REASON }], is_error: true, error: { message: ORPHAN_REASON } },
} satisfies ToolCallBlock;

const COMPLETED_TASK_CALL = {
  type: 'tool_call',
  id: 'prt_completed_task',
  call_id: 'call_completed_task',
  name: 'task',
  kind: 'task',
  title: 'Report on the widget',
  input: TASK_INPUT,
  status: 'complete',
  result: {
    content: [
      {
        type: 'text',
        text: 'task_id: ses_ee95c107bffe49S04KWqZ5tjcc (for resuming to continue this task if needed)\n\n<task_result>\nReport written. The widget shipped 4.2M units in Q4.\n</task_result>',
      },
    ],
    is_error: false,
  },
  started_at: new Date(1_000).toISOString(),
  ended_at: new Date(49_300).toISOString(),
} satisfies ToolCallBlock;

/** The child session as the runtime leaves it after a failed dispatch. */
const CHILD_MESSAGES: Parameters<ReturnType<typeof useSessionStateStore.getState>['hydrate']>[1] = [
  {
    info: {
      id: 'msg_child_prompt',
      sessionID: CHILD_SESSION,
      role: 'user',
      time: { created: FIXTURE_T0 },
      agent: 'build',
      model: { providerID: 'mock', modelID: 'fail-model' },
    },
    parts: [
      {
        id: 'prt_child_prompt',
        sessionID: CHILD_SESSION,
        messageID: 'msg_child_prompt',
        type: 'text',
        text: 'Write the quarterly report on the widget. TASK_MARKER_ALFA.',
      },
    ],
  },
  {
    info: {
      id: 'msg_child_reply',
      sessionID: CHILD_SESSION,
      role: 'assistant',
      parentID: 'msg_child_prompt',
      time: { created: FIXTURE_T0 + 2_000, completed: FIXTURE_T0 + 4_000 },
      modelID: 'fail-model',
      providerID: 'mock',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0.0009,
      tokens: { total: 118, input: 96, output: 0, reasoning: 0, cache: { read: 0, write: 22 } },
      error: {
        name: 'APIError',
        data: {
          isRetryable: false,
          message:
            'This model does not support assistant message prefill. The conversation must end with a user message.',
        },
      },
    },
    parts: [
      { id: 'prt_child_step1', sessionID: CHILD_SESSION, messageID: 'msg_child_reply', type: 'step-start' },
      {
        id: 'prt_child_step2',
        sessionID: CHILD_SESSION,
        messageID: 'msg_child_reply',
        type: 'step-finish',
        reason: 'error',
        cost: 0.0009,
        tokens: { total: 118, input: 96, output: 0, reasoning: 0, cache: { read: 0, write: 22 } },
      },
    ],
  },
];

function Row({ label, call }: { label: string; call: ToolCallBlock }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-2">
      <p className="text-muted-foreground mb-1 text-xs font-medium">{label}</p>
      <ToolPartRenderer call={call} sessionId={PARENT_SESSION} defaultOpen />
    </div>
  );
}

export default function SubagentFailurePage() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } }),
  );

  useEffect(() => {
    const store = useSessionStateStore.getState();
    store.clearSession(PARENT_SESSION);
    store.clearSession(CHILD_SESSION);
    store.hydrate(CHILD_SESSION, CHILD_MESSAGES);
    store.setStatus(CHILD_SESSION, { type: 'idle' });
    return () => {
      const current = useSessionStateStore.getState();
      current.clearSession(PARENT_SESSION);
      current.clearSession(CHILD_SESSION);
    };
  }, []);

  const failedRow = useMemo(() => <Row label="failed dispatch — child session kept (the fix)" call={FAILED_TASK_CALL} />, []);
  const orphanRow = useMemo(() => <Row label="failed dispatch — no child id (generic card is correct)" call={ORPHAN_TASK_CALL} />, []);
  const completedRow = useMemo(() => <Row label="completed dispatch (unchanged)" call={COMPLETED_TASK_CALL} />, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ToolSurfaceContext.Provider value="inline">
        <TurnLiveContext.Provider value={false}>
          <div className="bg-background min-h-dvh">
            <header className="border-border border-b px-4 py-3">
              <p className="text-sm font-medium">Subagent failure — KRTX-1746</p>
              <p className="text-muted-foreground text-xs">
                The failed dispatch stays a dispatch row: “View” opens the child session's
                transcript. Seeded in-store; no runtime attached.
              </p>
            </header>
            <div className="py-4">
              {failedRow}
              {orphanRow}
              {completedRow}
            </div>
          </div>
        </TurnLiveContext.Provider>
      </ToolSurfaceContext.Provider>
    </QueryClientProvider>
  );
}
