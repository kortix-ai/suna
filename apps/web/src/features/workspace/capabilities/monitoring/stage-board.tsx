'use client';

import { sessionDisplayStatus, sessionSource } from '@/components/projects/session-label';
import { SessionSharedIcon } from '@/components/projects/session-shared-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import {
  SESSION_STAGES,
  answerSessionQuestion,
  getSessionOpenQuestion,
  type ProjectSession,
  type SessionStage,
} from '@kortix/sdk';
import { startSessionWithPrompt, useSetSessionStage } from '@kortix/sdk/react';
import Link from 'next/link';
import { useState } from 'react';

import {
  STAGE_LABELS,
  groupSessionsByStage,
  needsApproval,
  stageMovedAt,
} from './stage-board-logic';

/** Runtime status → chip. Same tokens the sessions page's status tile uses. */
function statusBadge(session: ProjectSession): {
  label: string;
  variant: 'success' | 'warning' | 'destructive' | 'muted';
} {
  switch (sessionDisplayStatus(session)) {
    case 'running':
      return { label: 'Running', variant: 'success' };
    case 'starting':
      return { label: 'Starting', variant: 'warning' };
    case 'failed':
      return { label: 'Failed', variant: 'destructive' };
    case 'done':
      return { label: 'Completed', variant: 'muted' };
    default:
      return { label: 'Stopped', variant: 'muted' };
  }
}

const APPROVE_PROMPT = 'Approved. Proceed with the plan.';

function StageCard({ projectId, session }: { projectId: string; session: ProjectSession }) {
  const setStage = useSetSessionStage(projectId);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<'approve' | 'send-back' | null>(null);

  const title = getSessionDisplayTitle(session);
  const status = statusBadge(session);
  const source = sessionSource(session);
  const approval = needsApproval(session);
  const href = `/projects/${projectId}/sessions/${session.session_id}`;

  /**
   * The ONLY two moves a person makes: approve or send back a card the agent
   * parked in Ready with `--needs-approval`. Every other move is the agent's,
   * from inside the sandbox — the API answers any other human write with
   * 403 `stage_agent_only`. Move first, then hand the agent its next turn as
   * a durable prompt.
   */
  const decide = async (kind: 'approve' | 'send-back') => {
    setBusy(kind);
    const next: SessionStage = kind === 'approve' ? 'in_progress' : 'planning';
    const text =
      kind === 'approve'
        ? feedback.trim()
          ? `${APPROVE_PROMPT}\n${feedback.trim()}`
          : APPROVE_PROMPT
        : `Plan sent back for changes:\n${feedback.trim()}`;
    try {
      // Stage first, while the card is still `ready` + needs_approval — the
      // only window in which a person may write it.
      await setStage.mutateAsync({ sessionId: session.session_id, stage: next });
      // An agent that parked itself by ASKING (the platform's question dialog)
      // is waiting on that question, not on a fresh prompt: answer it, and the
      // API hands the answer to the agent as its next turn. Otherwise the
      // decision goes out as a durable prompt.
      const open = await getSessionOpenQuestion(projectId, session.session_id).catch(() => null);
      if (open) {
        await answerSessionQuestion(projectId, session.session_id, {
          answers: [text],
          request_id: open.request_id,
        });
      } else {
        await startSessionWithPrompt(projectId, session.session_id, {
          parts: [{ type: 'text', text }],
        });
      }
      successToast(
        kind === 'approve' ? 'Approved — the agent is continuing' : 'Sent back to planning',
      );
      setFeedback('');
      setFeedbackOpen(false);
    } catch (e) {
      errorToast(e instanceof Error ? e.message : 'Could not update the session');
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="bg-popover space-y-2 rounded-md border px-3 py-2.5">
      <Link href={href} prefetch={false} className="block min-w-0">
        <span className="text-foreground block truncate text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {session.agent_name ?? 'default'}
          {source.triggerSlug ? ` · ${source.triggerSlug}` : ''}
          {' · '}
          {relativeTime(stageMovedAt(session))}
        </span>
      </Link>

      {session.stage?.note ? (
        <p className="text-muted-foreground line-clamp-2 text-xs">{session.stage.note}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={status.variant} size="xs">
          {status.label}
        </Badge>
        {approval ? (
          <Badge variant="warning" size="xs">
            Needs approval
          </Badge>
        ) : null}
        <SessionSharedIcon session={session} />
      </div>

      {approval ? (
        <div className="space-y-2 border-t pt-2">
          {feedbackOpen ? (
            <Textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should change?"
              minHeight={44}
              maxHeight={160}
              className="text-sm"
              autoFocus
            />
          ) : null}
          <div className="flex items-center gap-2">
            {feedbackOpen ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null || !feedback.trim()}
                  onClick={() => void decide('send-back')}
                >
                  {busy === 'send-back' ? <Loading className="size-3.5 shrink-0" /> : null}
                  Send back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline-ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setFeedbackOpen(false);
                    setFeedback('');
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void decide('approve')}
                >
                  {busy === 'approve' ? <Loading className="size-3.5 shrink-0" /> : null}
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => setFeedbackOpen(true)}
                >
                  Send back
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Six fixed columns in `SESSION_STAGES` order. The board scrolls sideways
 * inside itself — never the page — so the columns keep a readable width on
 * any viewport.
 */
export function StageBoard({
  projectId,
  sessions,
}: {
  projectId: string;
  sessions: readonly ProjectSession[];
}) {
  const groups = groupSessionsByStage(sessions);
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:-mx-8 md:px-8">
      <ol className="flex items-start gap-2 pb-2">
        {SESSION_STAGES.map((stage) => {
          const cards = groups[stage];
          return (
            <li
              key={stage}
              className={cn(
                'bg-muted/40 flex min-w-48 flex-1 shrink-0 flex-col rounded-md border',
                stage === 'ready' && cards.some(needsApproval) && 'border-kortix-orange/40',
              )}
            >
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <h3 className="text-foreground text-sm font-medium">{STAGE_LABELS[stage]}</h3>
                <Badge variant="secondary" size="tabular">
                  {cards.length}
                </Badge>
              </div>
              <ol className="flex max-h-[70svh] flex-col gap-2 overflow-y-auto px-2 pb-2">
                {cards.length === 0 ? (
                  <li className="text-muted-foreground px-1 py-4 text-center text-xs">
                    No sessions
                  </li>
                ) : (
                  cards.map((session) => (
                    <StageCard key={session.session_id} projectId={projectId} session={session} />
                  ))
                )}
              </ol>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
