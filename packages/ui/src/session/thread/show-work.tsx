'use client';

import { getChildSessionId, type SessionLogBlock } from '@kortix/sdk';
import { useProjectSession, useSessionStateStore } from '@kortix/sdk/react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { useContext, useId, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { lazyClient } from '../../lib/lazy-client';
import { cn } from '../../lib/utils';
import { Skeleton } from '../../primitives/skeleton';
import { useSessionIds } from '../../providers/session-ids';
import { AfterFirstPromptContext } from './after-first-prompt';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { formatDuration } from '../../internal/session-types';
import { useElapsedLabel } from './typing-indicator';
import { sessionDisplayLabel } from '../actions/session-label';
import { type TranscriptRows, TranscriptRowsContext } from './transcript-rows';

// Lazy: `SessionPeek` renders `SessionTurn`, which renders this file.
const SessionPeek = lazyClient(() => import('../agents/session-peek').then((mod) => mod.SessionPeek), {
  fallback: <Skeleton className="h-24 w-full rounded-lg" />,
});

/**
 * The sessions that did the work behind one message of a talk-only thread
 * (`TranscriptRows.front`): the child of every `agent` call of the turn, and
 * the session of every report the turn answers (the worker's run-end notice).
 * In first-seen order, each once.
 */
export function messageWorkerIds(blocks: readonly SessionLogBlock[], reportSessionIds: readonly (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'tool_call') continue;
    const child = getChildSessionId(block);
    if (child) ids.add(child);
  }
  for (const id of reportSessionIds) if (id) ids.add(id);
  return [...ids];
}

/**
 * "Show work" under an agent's message in a messages-only thread: the work
 * behind it, inline and closed until the person opens it. Hidden until the
 * row is hovered or focused on a pointer screen, always visible on touch
 * (`max-md`), and always visible while open. The work mounts on the first open.
 */
export function ShowWork({ defaultOpen = false, children }: { defaultOpen?: boolean; children: ReactNode }) {
  const t = useTranslations('sessionUi.turn');
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div data-slot="show-work" className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -ml-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs outline-none focus-visible:ring-2',
          !open && 'md:opacity-0 md:group-focus-within/message:opacity-100 md:group-hover/message:opacity-100',
        )}
      >
        <CaretRightIcon
          aria-hidden
          weight="bold"
          className={cn('size-3 shrink-0 motion-safe:transition-transform motion-safe:duration-fast', open && 'rotate-90')}
        />
        {open ? t('hideWork') : t('showWork')}
      </button>
      {open ? (
        <div id={contentId} data-slot="show-work-content" className="mt-1.5 min-w-0">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The worker sessions of a talk-only thread's message, each as its own
 * read-only transcript (`SessionPeek`), at most ~24rem tall and scrolled to
 * its newest step. The peek draws the session's own turns (bubbles, steps,
 * "Worked for"), never this thread's message rows.
 */
export function WorkerTranscripts({ sessionIds }: { sessionIds: readonly string[] }) {
  const ids = useSessionIds();
  const projectId = ids.projectId;
  // The thread's author card, read before the peeks reset the rows context.
  const author = useContext(TranscriptRowsContext)?.author;
  if (!projectId) return null;
  return (
    <TranscriptRowsContext.Provider value={null}>
      <AfterFirstPromptContext.Provider value={null}>
        <div className="flex flex-col gap-2">
          {sessionIds.map((sessionId) => (
            <WorkerTranscript key={sessionId} projectId={projectId} sessionId={sessionId} author={author} />
          ))}
        </div>
      </AfterFirstPromptContext.Provider>
    </TranscriptRowsContext.Provider>
  );
}

function WorkerTranscript({
  projectId,
  sessionId,
  author,
}: {
  projectId: string;
  sessionId: string;
  author?: TranscriptRows['author'];
}) {
  // The worker's agent heads its work: its mark and name, which open its card.
  const agentName = useProjectSession(projectId, sessionId).data?.agent_name ?? null;
  const working = useSessionStateStore((s) => {
    const type = s.sessionStatus[sessionId]?.type;
    return type === 'busy' || type === 'retry';
  });
  return (
    <div data-worker-session={sessionId} className="bg-background flex max-h-96 min-h-0 flex-col overflow-hidden rounded-lg border">
      {agentName ? (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs font-medium">
          {author ? (
            author(
              { kind: 'agent', name: agentName },
              <span className="inline-flex min-w-0 items-center gap-2">
                <AgentMark slug={agentName} size={14} />
                <span className="truncate">{agentDisplayName(agentName)}</span>
              </span>,
              'name',
            )
          ) : (
            <>
              <AgentMark slug={agentName} size={14} />
              <span className="truncate">{agentDisplayName(agentName)}</span>
            </>
          )}
        </div>
      ) : null}
      <SessionPeek projectId={projectId} sessionId={sessionId} working={working} density="compact" />
    </div>
  );
}

/**
 * A router thread's live status while its hidden workers run: one row per
 * busy worker, its mark and "<Agent> is working · 0:42", under the message
 * that started it. A row leaves when its worker goes idle (its report then
 * reaches the router, which replies). Reads the same worker ids as "Show work"
 * and the same busy state as `WorkerTranscript`.
 */
export function WorkerStatusRows({ sessionIds }: { sessionIds: readonly string[] }) {
  const ids = useSessionIds();
  const author = useContext(TranscriptRowsContext)?.author;
  if (!ids.projectId || sessionIds.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {sessionIds.map((sessionId) => (
        <WorkerStatusRow key={sessionId} projectId={ids.projectId!} sessionId={sessionId} author={author} />
      ))}
    </div>
  );
}

function WorkerStatusRow({ projectId, sessionId, author }: { projectId: string; sessionId: string; author?: TranscriptRows['author'] }) {
  const t = useTranslations('sessionUi.turn');
  const row = useProjectSession(projectId, sessionId).data;
  const busy = useSessionStateStore((s) => {
    const type = s.sessionStatus[sessionId]?.type;
    return type === 'busy' || type === 'retry';
  });
  const working = busy || row?.working?.state === 'working';
  const elapsed = useElapsedLabel(working ? (row?.working?.since ?? row?.created_at ?? null) : null, formatDuration);
  if (!working || !row?.agent_name) return null;
  const agent = row.agent_name;
  const label = sessionDisplayLabel(row).trim();
  // An untitled worker falls back to an id or branch: no task to name then.
  const task = label && !row.session_id.startsWith(label) && label !== row.branch_name?.slice(0, 14) ? label : null;
  const face = (
    <span className="inline-flex items-center gap-1.5">
      <AgentMark slug={agent} size={14} />
      <span className="text-foreground font-medium">{agentDisplayName(agent)}</span>
    </span>
  );
  return (
    <div role="status" aria-live="polite" className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs tabular-nums">
      {author ? author({ kind: 'agent', name: agent }, face, 'name') : face}
      {/* What it works on (the worker session's title), so two workers read apart. */}
      <span className="min-w-0 truncate" title={task ?? undefined}>
        {task
          ? elapsed
            ? t('agentWorkingOnFor', { task, time: elapsed })
            : t('agentWorkingOn', { task })
          : elapsed
            ? t('agentWorkingFor', { time: elapsed })
            : t('agentWorking')}
      </span>
    </div>
  );
}
