'use client';

/**
 * /debug/subagent-failure — KRTX-1746 visual harness.
 *
 * A failed subagent dispatch (`task` tool, child id in `state.metadata`) must
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

import '@/features/session/tool/tools/register';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { ToolPartRenderer, TurnLiveContext } from '@/features/session/tool/tool-renderers';
import { useSessionStateStore } from '@kortix/sdk/react';
import type { MessageWithParts, ToolPart } from '@/ui';

const PARENT_SESSION = 'ses_krtx1746_parent';
const CHILD_SESSION = 'ses_ee95c107bffe49S04KWqZ5tjcc';

/** 2026-10-07T12:00:00.000Z — timestamps must be absolute, not epoch offsets. */
const FIXTURE_T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

const FAILED_REASON =
  'Subagent failed (task_id: ses_ee95c107bffe49S04KWqZ5tjcc): This model does not support assistant message prefill. The conversation must end with a user message.';

const FAILED_TASK_PART = {
  type: 'tool',
  tool: 'task',
  callID: 'call_failed_task',
  state: {
    status: 'error',
    input: {
      subagent_type: 'general',
      description: 'Report on the widget',
      prompt: 'Write the quarterly report on the widget. TASK_MARKER_ALFA.',
    },
    output: '',
    metadata: { parentSessionId: PARENT_SESSION, sessionId: CHILD_SESSION },
    error: FAILED_REASON,
    time: { start: 1_000, end: 3_400 },
  },
} as unknown as ToolPart;

const ORPHAN_TASK_PART = {
  ...FAILED_TASK_PART,
  callID: 'call_orphan_task',
  state: {
    ...FAILED_TASK_PART.state,
    metadata: {},
    error: 'Error: Unknown agent type: researcher is not a valid agent type. Available: general, explore',
  },
} as unknown as ToolPart;

const COMPLETED_TASK_PART = {
  type: 'tool',
  tool: 'task',
  callID: 'call_completed_task',
  state: {
    status: 'completed',
    input: FAILED_TASK_PART.state.input,
    output:
      'task_id: ses_ee95c107bffe49S04KWqZ5tjcc (for resuming to continue this task if needed)\n\n<task_result>\nReport written. The widget shipped 4.2M units in Q4.\n</task_result>',
    metadata: { parentSessionId: PARENT_SESSION, sessionId: CHILD_SESSION },
    time: { start: 1_000, end: 49_300 },
  },
} as unknown as ToolPart;

/** The child session as the runtime leaves it after a failed dispatch. */
const CHILD_MESSAGES: MessageWithParts[] = [
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
  } as unknown as MessageWithParts,
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
  } as unknown as MessageWithParts,
];

function Row({ label, part }: { label: string; part: ToolPart }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-2">
      <p className="text-muted-foreground mb-1 text-xs font-medium">{label}</p>
      <ToolPartRenderer part={part} sessionId={PARENT_SESSION} defaultOpen />
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

  const failedRow = useMemo(() => <Row label="failed dispatch — child session kept (the fix)" part={FAILED_TASK_PART} />, []);
  const orphanRow = useMemo(() => <Row label="failed dispatch — no child id (generic card is correct)" part={ORPHAN_TASK_PART} />, []);
  const completedRow = useMemo(() => <Row label="completed dispatch (unchanged)" part={COMPLETED_TASK_PART} />, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ToolSurfaceContext.Provider value="transcript">
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
