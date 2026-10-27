'use client';

import { useProjectSession, useSessionPrompts } from '@kortix/sdk/react';
import { useContext, useMemo } from 'react';

import { AgentMark } from '../../internal/components/agent-mark';
import { cn } from '../../lib/utils';
import { errorToast } from '../../primitives/toast';
import { UserAvatar } from '../../primitives/user-avatar';
import { useUiViewerId } from '../../providers/ui-provider';
import { ComposerChatInput } from '../composer/composer-chat-input';
import type { DraftScope } from '../composer/draft/composer-draft';
import { projectQueueRows } from '../composer/queue-projection';
import { QueuedPromptList } from '../composer/queued-prompt-list';
import { useInstantSessionSend } from '../composer/use-instant-session-send';
import { participantLabel } from '../participants/session-participants';
import { SessionBusyIndicator } from '../status/session-busy-indicator';
import { MESSAGE_TEXT_CLASS, MessageRow } from '../turn/message-row';
import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseSessionReferences,
  stripReplyContexts,
} from './message-parsing';
import { TranscriptRowsContext, type TranscriptRows } from './transcript-rows';

/** The sentence a person typed, without the ref blocks the composer folds in. */
function promptSentence(text: string): string {
  let clean = parseFileReferences(text).cleanText;
  clean = parseSessionReferences(clean).cleanText;
  clean = parseFileMentionReferences(clean).cleanText;
  clean = parseAgentMentionReferences(clean).cleanText;
  return stripReplyContexts(clean).trim();
}

/**
 * A prompt not yet in the transcript, as a channel thread draws it: the
 * author's row and, while it waits, the agent's row with the busy line. The
 * thread panel's boot body and its first-prompt stand-in draw this one row, so
 * the hand-over to the transcript's own row does not move.
 */
export function PendingPromptRows({
  text,
  author,
  sessionId,
  busy = true,
}: {
  text: string;
  author: TranscriptRows['owner'];
  sessionId: string;
  busy?: boolean;
}) {
  const rows = useContext(TranscriptRowsContext);
  const name = author ? participantLabel(author) : '';
  return (
    <>
      <MessageRow
        avatar={<UserAvatar email={author?.email ?? ''} name={name} avatarUrl={author?.avatarUrl} size="lg" />}
        name={name || rows?.unknownAuthor}
      >
        <p className={cn(MESSAGE_TEXT_CLASS, 'text-pretty whitespace-pre-wrap wrap-anywhere')}>{promptSentence(text)}</p>
      </MessageRow>
      {busy ? <AgentBusyRow sessionId={sessionId} /> : null}
    </>
  );
}

/**
 * The agent's answer row while it has drawn nothing yet: its pixel mark, its
 * name and the Thinking line, where a working turn's answer row draws them
 * (`SessionTurn` in rows mode: the body opens `mt-0.5`). Every waiting row of
 * a channel thread is this row, so none sits outside the row grid. Null
 * outside a channel thread.
 */
export function AgentBusyRow({ sessionId }: { sessionId: string }) {
  const rows = useContext(TranscriptRowsContext);
  if (!rows) return null;
  return (
    <MessageRow
      avatar={<AgentMark slug={rows.agentSlug ?? 'kortix'} size={28} tile={36} label={rows.agent} />}
      name={rows.agent}
    >
      <div className="mt-0.5">
        <SessionBusyIndicator sessionId={sessionId} />
      </div>
    </MessageRow>
  );
}

/**
 * A channel thread whose computer is still coming up (no runtime session yet).
 * The session page shows `InstantSessionShell` here; a thread panel shows the
 * same thing as rows: the first prompt by its author, the agent's busy row,
 * and a working reply composer. A reply typed now joins the session's prompt
 * inbox and runs once the computer is up, as on the session page.
 */
export function ThreadBootRows({
  projectId,
  sessionId,
  composerPlaceholder,
  readOnly = false,
}: {
  projectId: string;
  sessionId: string;
  composerPlaceholder?: string;
  readOnly?: boolean;
}) {
  const rows = useContext(TranscriptRowsContext);
  const promptInbox = useSessionPrompts(projectId, sessionId);
  const { submitted, effectiveSubmission, extraSends, handleSend } = useInstantSessionSend({
    projectId,
    sessionId,
    hydrated: true,
    promptInbox,
  });
  const viewerId = useUiViewerId();
  const projectSession = useProjectSession(projectId, sessionId, { enabled: !!projectId && !!sessionId }).data;
  const queue = useMemo(
    () =>
      projectQueueRows({
        prompts: promptInbox.prompts,
        drafts: extraSends.map((entry) => ({
          clientMessageId: entry.id,
          text: entry.text,
          files: entry.files,
          placement: entry.placement,
          createdAtMs: 0,
          posted: false,
        })),
        viewer: { userId: viewerId, managesSession: projectSession?.can_manage_lifecycle !== false },
      }),
    [promptInbox.prompts, extraSends, viewerId, projectSession?.can_manage_lifecycle],
  );
  // The session page's draft key: a draft typed here is there once the chat mounts.
  const draftScope = useMemo<DraftScope>(() => ({ kind: 'session', sessionId }), [sessionId]);
  const text = effectiveSubmission?.text ?? projectSession?.first_prompt ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pt-4">
        {text ? <PendingPromptRows text={text} author={rows?.owner ?? null} sessionId={sessionId} /> : null}
      </div>
      {readOnly ? null : (
        <ComposerChatInput
          onSend={handleSend}
          sessionId={sessionId}
          projectId={projectId}
          draftScope={draftScope}
          projectSession={projectSession}
          placeholder={composerPlaceholder}
          // The first prompt is the turn: the box stays typeable, a send queues.
          isBusy={!!submitted}
          sessionWorking={!!submitted}
          stopDisabled={!!submitted}
          aboveSlot={
            <QueuedPromptList
              rows={queue.rows}
              heldCount={queue.heldCount}
              onResume={() => void promptInbox.hold(false).catch((error) => errorToast(error.message))}
              onRemove={(id) => void promptInbox.remove(id).catch((error) => errorToast(error.message))}
              onRetry={(id) => void promptInbox.retry(id).catch((error) => errorToast(error.message))}
            />
          }
          underbarPlacement="inline"
          // The panel's rows run `px-5`, as `SessionChat`'s composer in the panel.
          parentClassName="max-w-none px-5 pb-4"
        />
      )}
    </div>
  );
}
