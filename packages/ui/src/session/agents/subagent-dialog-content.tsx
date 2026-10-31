'use client';

import { stopProjectSession, type ProjectSession } from '@kortix/sdk';
import { qk, useProjectSession } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, CheckIcon, PaperPlaneRightIcon, SquareIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import { Hint } from '../../primitives/hint';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '../../primitives/modal';
import { Skeleton } from '../../primitives/skeleton';
import { StatusDot, type StatusTone } from '../../primitives/status';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink } from '../../providers/ui-provider';
import { useSessionIds } from '../../providers/session-ids';
import { agentRowOf, isActive, shortElapsed, type AgentRow, type AgentRowState } from './agent-model';
import { LegacySubagentChat } from './legacy-subagent-chat';
import { SessionPeek } from './session-peek';
import { useSteerSession } from './steer-session';
import { useNow } from './workflow-run-controls';

export interface SubagentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The child session: a Kortix project session, or an in-process child's runtime id. */
  sessionId: string;
  /** What the opener calls it; the session's own handle wins once its row loads. */
  title?: string;
  /** The project; default: the project of the session page the dialog opens over. */
  projectId?: string;
}

const DOT_TONE: Record<Exclude<AgentRowState, 'idle' | 'completed'>, StatusTone> = {
  working: 'success',
  needs_input: 'warning',
  failed: 'destructive',
  stopped: 'neutral',
};

/** The same state mark as the agents line: live dot, attention dot, check once its turn ended. */
function StateMark({ state }: { state: AgentRowState }) {
  return state === 'idle' || state === 'completed' ? (
    <CheckIcon aria-hidden weight="bold" className="text-kortix-green size-3 shrink-0" />
  ) : (
    <StatusDot tone={DOT_TONE[state]} pulse={state === 'working'} className="motion-reduce:animate-none" />
  );
}

/**
 * Which body a child gets. A child that is its own project session (every
 * sub-agent, teammate and workflow agent since each runs on its own computer)
 * answers `GET /projects/:pid/sessions/:child` and reads its own log
 * (`SessionPeek`). A child that answers 404 or 400 there is not a project
 * session (an in-process `session: "same"` child, an old OpenCode subagent):
 * its transcript lives in the lead's computer, so it keeps the legacy chat.
 * Any other failure is a failed read of a real child: the dialog says so.
 */
function bodyKind(row: ReturnType<typeof useProjectSession>, projectId: string | undefined): 'peek' | 'legacy' | 'loading' | 'error' {
  if (!projectId) return 'legacy';
  if (row.data) return 'peek';
  if (row.isError) {
    const status = (row.error as { status?: number } | null)?.status;
    return status === 404 || status === 400 ? 'legacy' : 'error';
  }
  return 'loading';
}

export function SubagentDialogContent({ open, onOpenChange, sessionId, title, projectId: projectIdProp }: SubagentDialogProps) {
  const t = useTranslations('multiAgent.subagent');
  const ts = useTranslations('multiAgent.strip');
  const ids = useSessionIds();
  const projectId = projectIdProp ?? ids.projectId ?? undefined;
  const row = useProjectSession(projectId, sessionId, { enabled: open && !!projectId });
  const kind = bodyKind(row, projectId);
  const agent: AgentRow | null = row.data ? agentRowOf(row.data as ProjectSession) : null;
  const name = agent?.named ? agent.handle : title || agent?.handle || t('fallbackTitle');
  const working = agent?.state === 'working';
  const now = useNow(open && working);
  const queryClient = useQueryClient();

  // The header's state follows the transcript: a new message re-reads the row.
  const refreshRow = () => projectId && void queryClient.invalidateQueries({ queryKey: qk.project.session(projectId, sessionId) });
  const stop = useMutation({
    mutationFn: () => stopProjectSession(projectId!, sessionId),
    onSettled: refreshRow,
    onError: (error) => errorToast(ts('stopAgentFailed', { name }), { description: error instanceof Error ? error.message : undefined }),
  });

  const state = agent
    ? agent.state === 'working' && agent.workingSinceMs !== null
      ? ts('workingFor', { elapsed: shortElapsed(now - agent.workingSinceMs) })
      : ts(`state.${agent.state}`)
    : null;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        variant="base"
        showCloseButton={false}
        data-testid="subagent-dialog"
        data-body={kind}
        className={cn(
          'flex flex-col gap-0 space-y-0 overflow-hidden p-0',
          // lg:max-w-* is required: the base modal sets lg:max-w-lg, which
          // tailwind-merge does not strip for an unprefixed override.
          'h-[80vh] max-h-[840px] lg:h-[80vh] lg:max-w-6xl',
          // A small window gets the whole screen: no sheet edge to aim at.
          'max-[720px]:inset-0 max-[720px]:h-dvh max-[720px]:max-h-none max-[720px]:rounded-none',
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
          {agent && <StateMark state={agent.state} />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <ModalTitle className="min-w-0 truncate text-sm font-medium">{name}</ModalTitle>
              {state && <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{state}</span>}
            </div>
            <ModalDescription className="text-muted-foreground truncate text-xs">
              {agent?.agent && agent.named ? ts('runsAs', { agent: agentDisplayName(agent.agent) }) : null}
            </ModalDescription>
          </div>
          {projectId && kind === 'peek' && (
            <Button asChild variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground shrink-0">
              <UiLink href={uiRoutes().session(projectId, sessionId)} onClick={() => onOpenChange(false)}>
                <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                {t('openPage')}
              </UiLink>
            </Button>
          )}
          {agent && isActive(agent.state) && (
            <Hint label={ts('stopHint')} side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={ts('stopAgent', { name })}
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
                className="text-muted-foreground hover:text-foreground"
              >
                {stop.isPending ? <Loading className="size-3" /> : <SquareIcon weight="fill" className="size-2.5" />}
              </Button>
            </Hint>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('close')}
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:text-foreground hit-area-2 shrink-0"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {kind === 'peek' && projectId ? (
            <SessionPeek projectId={projectId} sessionId={sessionId} working={working} onActivity={refreshRow} />
          ) : kind === 'legacy' ? (
            <LegacySubagentChat sessionId={sessionId} />
          ) : kind === 'error' ? (
            <SessionPeekRowError onRetry={() => void row.refetch()} />
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-4 px-7 pt-6" aria-busy="true">
              <Skeleton className="ml-auto h-9 w-2/5 rounded-xl" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
        </div>

        {kind === 'peek' && projectId && <SubagentMessageBox key={sessionId} projectId={projectId} sessionId={sessionId} name={name} onSent={refreshRow} />}
      </ModalContent>
    </Modal>
  );
}

function SessionPeekRowError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('multiAgent.subagent');
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        }
      />
    </div>
  );
}

/** One line under the transcript: a message to the child, as a steer. */
function SubagentMessageBox({ projectId, sessionId, name, onSent }: { projectId: string; sessionId: string; name: string; onSent: () => void }) {
  const t = useTranslations('multiAgent.subagent');
  const [text, setText] = useState('');
  const send = useSteerSession(projectId, {
    onSent: () => {
      setText('');
      successToast(t('sent'));
      onSent();
    },
    onError: (error) => errorToast(t('sendFailed'), { description: error instanceof Error ? error.message : undefined }),
  });
  const submit = () => {
    const message = text.trim();
    if (!message || send.isPending) return;
    send.mutate({ sessionId, text: message });
  };
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-t px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        data-testid="subagent-dialog-message"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('messagePlaceholder', { name })}
        aria-label={t('messageLabel', { name })}
        disabled={send.isPending}
        className="min-w-0 flex-1"
      />
      <Button type="submit" size="sm" className="shrink-0 gap-1.5" disabled={!text.trim() || send.isPending}>
        {send.isPending ? <Loading className="size-3.5 shrink-0" /> : <PaperPlaneRightIcon className="size-3.5 shrink-0" />}
        {t('send')}
      </Button>
    </form>
  );
}
