'use client';

import { createProjectSession, type ArtifactDetail, type ModelKey } from '@kortix/sdk';
import { modelKeyToWire, useProjectSessions, useSession } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { ButtonGroup } from '@kortix/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EmptyState } from '@kortix/ui/empty-state';
import { Hint } from '@kortix/ui/hint';
import { SessionThread, getSessionDisplayTitle, sessionLastActivityAt } from '@kortix/ui/session';
import { buildFileRefsBlock } from '@kortix/ui/internal/lib/project-preamble';
import { ComposerChatInput } from '@kortix/ui/session/composer/composer-chat-input';
import { Skeleton } from '@kortix/ui/skeleton';
import { SplitSheetBody, SplitSheetContent, SplitSheetHeader, SplitSheetTitle } from '@kortix/ui/split-sheet';
import { errorToast } from '@kortix/ui/toast';
import { ArrowSquareOutIcon, ClockCounterClockwiseIcon, NotePencilIcon, SparkleIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';

import { relativeTime } from './artifact-meta';

/**
 * The first prompt: the person's words, then the artifact's file as a
 * `Referenced files` block. The transcript strips the block and shows a file
 * chip, so the bubble reads as what they typed; the agent reads the file at
 * its path in Files. (`initial_context` is not used: pi delivers it inside the
 * visible prompt text.)
 */
function artifactPrompt(a: ArtifactDetail, text: string): string {
  return `${text}\n\n${buildFileRefsBlock([{ path: a.path, name: a.title }])}`;
}

/**
 * The label every Ask agent session of an artifact carries: the history lists
 * sessions by it. Hidden from the label badges (`SessionLabelBadges`).
 */
const artifactLabel = (artifactId: string) => `artifact:${artifactId}`;

const storageKey = (artifactId: string) => `kortix:artifact-ask:${artifactId}`;

/** The session this artifact's sheet last opened, kept for the tab (a reload shows the same chat). */
function readSessionId(artifactId: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(artifactId));
  } catch {
    return null;
  }
}

function writeSessionId(artifactId: string, sessionId: string | null) {
  try {
    if (sessionId) sessionStorage.setItem(storageKey(artifactId), sessionId);
    else sessionStorage.removeItem(storageKey(artifactId));
  } catch {
    // Storage blocked: the chat lasts until the page closes.
  }
}

/**
 * "Ask agent" beside an artifact: a split-sheet column with one session's
 * chat. Before the first message it is a composer; the first message starts a
 * session with the artifact as context, and from then on the column is that
 * session's thread (its messages, replies and composer). Render inside the
 * artifact page's `SplitSheet`.
 */
/** While the agent works, the artifact is read this often, so its edits show as they land. */
const AGENT_WORK_POLL_MS = 4_000;

export function AskAgentSheet({
  projectId,
  artifact,
  onAgentWork,
}: {
  projectId: string;
  artifact: ArtifactDetail;
  /** Read the artifact again: the agent may have written it. */
  onAgentWork: () => void;
}) {
  const t = useTranslations('artifacts');
  const [sessionId, setSessionId] = useState<string | null>(() => readSessionId(artifact.artifact_id));
  /** The prompt of the session this sheet just started: shown while its computer boots. */
  const [firstPrompt, setFirstPrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const pick = (id: string | null) => {
    writeSessionId(artifact.artifact_id, id);
    setSessionId(id);
  };

  return (
    // The page background, not the sheet's `bg-surface`: the column reads as part of the artifact page.
    <SplitSheetContent aria-label={t('askAgent')} className="bg-background">
      <SplitSheetHeader closeLabel={t('close')} className="items-center py-2">
        <div className="flex min-w-0 items-center gap-1">
          <SplitSheetTitle className="min-w-0 flex-1 truncate">{t('askAgent')}</SplitSheetTitle>
          {/* One group, one weight, as the page header's actions. */}
          <ButtonGroup className="shrink-0">
            <AskAgentHistory projectId={projectId} artifactId={artifact.artifact_id} current={sessionId} onPick={pick} />
            {sessionId ? (
              <>
                <Hint label={t('openSession')} side="bottom">
                  <Button size="icon-sm" variant="secondary" aria-label={t('openSession')} asChild>
                    <Link href={`/projects/${projectId}/sessions/${sessionId}`}>
                      <ArrowSquareOutIcon className="size-3.5" />
                    </Link>
                  </Button>
                </Hint>
                <Hint label={t('newChat')} side="bottom">
                  <Button size="icon-sm" variant="secondary" aria-label={t('newChat')} onClick={() => pick(null)}>
                    <NotePencilIcon className="size-3.5" />
                  </Button>
                </Hint>
              </>
            ) : null}
          </ButtonGroup>
        </div>
      </SplitSheetHeader>
      {sessionId ? (
        <AskAgentThread
          key={sessionId}
          projectId={projectId}
          sessionId={sessionId}
          firstPrompt={firstPrompt?.sessionId === sessionId ? firstPrompt.text : undefined}
          onAgentWork={onAgentWork}
        />
      ) : (
        <AskAgentStart
          projectId={projectId}
          artifact={artifact}
          onStarted={(id, text) => {
            setFirstPrompt({ sessionId: id, text });
            pick(id);
          }}
        />
      )}
    </SplitSheetContent>
  );
}

function AskAgentThread({
  projectId,
  sessionId,
  firstPrompt,
  onAgentWork,
}: {
  projectId: string;
  sessionId: string;
  firstPrompt?: string;
  onAgentWork: () => void;
}) {
  const t = useTranslations('artifacts');
  const session = useSession(projectId, sessionId);
  // The artifact is read every few seconds while the agent works, and once when its turn ends.
  const work = useRef(onAgentWork);
  useEffect(() => {
    work.current = onAgentWork;
  });
  const busy = session.isBusy;
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => work.current(), AGENT_WORK_POLL_MS);
    return () => {
      window.clearInterval(timer);
      work.current();
    };
  }, [busy]);
  return (
    <SessionThread
      session={session}
      hideHeader
      firstPrompt={firstPrompt}
      density="compact"
      composerPlaceholder={t('askAgentReply')}
      className="min-h-0 flex-1"
    />
  );
}

/** The artifact's Ask agent sessions, newest first: pick one to open it in the sheet. */
function AskAgentHistory({
  projectId,
  artifactId,
  current,
  onPick,
}: {
  projectId: string;
  artifactId: string;
  current: string | null;
  onPick: (sessionId: string) => void;
}) {
  const t = useTranslations('artifacts');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const history = useProjectSessions(projectId, { labels: [artifactLabel(artifactId)], limit: 20, enabled: open });
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        void history.refetch();
      }}
    >
      <Hint label={t('askAgentHistory')} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="secondary" aria-label={t('askAgentHistory')}>
            <ClockCounterClockwiseIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
        <DropdownMenuLabel>{t('askAgentHistory')}</DropdownMenuLabel>
        {history.isLoading ? (
          <div className="flex flex-col gap-1 p-1">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        ) : history.sessions.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">{t('askAgentHistoryEmpty')}</p>
        ) : (
          history.sessions.map((session) => (
            <DropdownMenuItem key={session.session_id} onSelect={() => onPick(session.session_id)} aria-current={session.session_id === current || undefined}>
              <span className="min-w-0 flex-1 truncate">{getSessionDisplayTitle(session)}</span>
              <span className={`shrink-0 text-xs ${session.session_id === current ? 'text-foreground' : 'text-muted-foreground'}`}>
                {session.session_id === current ? t('viewing') : relativeTime(sessionLastActivityAt(session), locale)}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The first message: an empty state that says what happens, then the session
 * composer itself (agent, model, `/` commands) — the same input the thread
 * shows once the session runs. The send starts the session with the artifact
 * as model-only context, so the transcript shows only the person's words.
 */
function AskAgentStart({
  projectId,
  artifact,
  onStarted,
}: {
  projectId: string;
  artifact: ArtifactDetail;
  onStarted: (sessionId: string, prompt: string) => void;
}) {
  const t = useTranslations('artifacts');
  const [starting, setStarting] = useState(false);
  const send = async (text: string, files: unknown[] | undefined, options: { agent?: string; model?: ModelKey }) => {
    const prompt = text.trim();
    if (!prompt || starting) return;
    // A first prompt is text: the create carries no file parts. Files go in the thread once it runs.
    if (files?.length) {
      errorToast(t('askAgentNoFiles'));
      return;
    }
    setStarting(true);
    try {
      const session = await createProjectSession(projectId, {
        initial_prompt: artifactPrompt(artifact, prompt),
        labels: [artifactLabel(artifact.artifact_id)],
        ...(options.agent ? { agent_name: options.agent } : {}),
        ...(options.model ? { model: modelKeyToWire(options.model) } : {}),
      });
      onStarted(session.session_id, prompt);
    } finally {
      setStarting(false);
    }
  };
  return (
    <>
      <SplitSheetBody className="flex">
        <EmptyState size="sm" icon={SparkleIcon} title={t('askAgentTitle')} description={t('askAgentHint', { title: artifact.title })} />
      </SplitSheetBody>
      <div className="shrink-0">
        <ComposerChatInput
          onSend={send}
          projectId={projectId}
          // A create in flight: spinner in the send slot, input locked; the draft stays until the thread replaces it.
          isSending={starting}
          disabled={starting}
          clearOnSend={false}
          autoFocus
          placeholder={t('askAgentPlaceholder')}
          underbarPlacement="below"
          slashMenuPlacement="above"
        />
      </div>
    </>
  );
}
