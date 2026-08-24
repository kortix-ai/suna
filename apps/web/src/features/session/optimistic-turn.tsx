'use client';

import { useMemo } from 'react';

import { MentionChip } from '@/features/session/mention-chip';
import { buildMentionSegments } from '@/features/session/mention-segments';
import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseProjectReferences,
  parseReplyContext,
  parseSessionReferences,
} from '@/features/session/message-parsing';
import { SessionBusyIndicator } from '@/features/session/session-busy-indicator';
import {
  BUBBLE_SURFACE,
  BUBBLE_TEXT,
  MessageAttachments,
  type NormalizedAttachment,
  UserMessageActions,
} from '@/features/session/turn/user-message';
import { cn } from '@/lib/utils';
import { getFilename } from '@/lib/utils/file-utils';
import { openTabAndNavigate } from '@/stores/tab-store';

// `BUBBLE_SURFACE` / `BUBBLE_TEXT` are imported from `turn/user-message.tsx`,
// not redeclared here. A local copy drifted twice already — first the dark
// fill (`dark:bg-sidebar-accent-foreground/9` vs `dark:bg-muted`, fixed), then
// the padding/radius (`px-3 py-2.5 rounded-lg` vs `px-4.5 py-3.5 rounded-xl`)
// — each drift a visible bubble jump the instant the optimistic turn handed
// over to the real server turn. One constant, imported, cannot drift.

/**
 * The optimistic turn — the user's message plus the assistant's waiting row,
 * rendered the instant a message is sent and before any server turn exists.
 *
 * ONE component, deliberately: this exact turn is painted twice in a fresh
 * session's life — first by {@link InstantSessionShell} while the computer boots,
 * then again by {@link SessionChat} once the runtime is healthy — and the two
 * crossfade into each other. Both surfaces used to hand-roll their own copy held
 * together by a comment asking future authors to keep them identical. They had
 * already drifted (different vertical padding, raw prompt text vs. parsed, a
 * logomark on one side only), and every drift showed up as the thread twitching
 * mid-handover. Sharing the render makes the contract structural instead of
 * aspirational: there is nothing left to keep in sync.
 *
 * The waiting row is {@link SessionBusyIndicator} — the SAME component a live
 * turn shows while working. So the whole arc (boot → runtime ready → first real
 * turn) is one row that never unmounts its shape: only its label changes, and
 * that change is already blur-bridged. No logomark that appears and then
 * vanishes when the real turn lands, no boot checklist, no rotating filler
 * copy — just "Thinking" until the agent has something truer to say.
 */
export function OptimisticTurn({
  /** The prompt text, already carrying any upload refs
   *  (see `buildOptimisticPromptTextWithUploads`). */
  text,
  /** Known agent names, so `@agent` mentions render as agent chips. */
  agentNames,
  /** Opens a file mention. Omitted before a runtime exists — mentions then
   *  render as static chips rather than dead buttons. */
  onFileClick,
  /** Paint every tile as still-uploading while there is no sandbox yet
   *  (instant shell). Same `pending` flag MessageAttachments uses on send. */
  deferPreview,
  /** Keys the busy indicator's dot-matrix glyph — see `SessionDotMatrix`. */
  sessionId,
  /**
   * Draw the waiting row under the bubble. Default true — the whole point of
   * this component is that the bubble and its "Thinking" row arrive together.
   *
   * `SessionChat` turns it off in one case: the transcript has already produced
   * a turn (with its own busy row) whose user message carries no text yet, so
   * this stands in for the missing bubble ABOVE it. Two waiting rows would be a
   * lie about how much is running.
   */
  busy = true,
  className,
}: {
  text: string;
  agentNames?: string[];
  onFileClick?: (path: string) => void;
  deferPreview?: boolean;
  sessionId?: string;
  busy?: boolean;
  className?: string;
}) {
  return (
    <div data-turn-id="optimistic" className={cn('group/turn mt-12 first:mt-0', className)}>
      <div className="flex justify-end">
        <OptimisticUserBubble
          text={text}
          agentNames={agentNames}
          onFileClick={onFileClick}
          deferPreview={deferPreview}
        />
      </div>
      {busy && <SessionBusyIndicator sessionId={sessionId} className="mt-6" />}
    </div>
  );
}

function OptimisticUserBubble({
  text,
  agentNames,
  onFileClick,
  deferPreview,
}: {
  text: string;
  agentNames?: string[];
  onFileClick?: (path: string) => void;
  deferPreview?: boolean;
}) {
  // Strip every ref block the composer folded into the prompt, in the order it
  // folded them in, so the bubble shows the sentence the user typed and the
  // attachments as tiles — never raw XML.
  const { replyContext, files, cleanText } = useMemo(() => {
    const { cleanText: afterReply, replyContext } = parseReplyContext(text);
    const { cleanText: afterFiles, files } = parseFileReferences(afterReply);
    const { cleanText: afterProjects } = parseProjectReferences(afterFiles);
    const { cleanText: afterFileMentions } = parseFileMentionReferences(afterProjects);
    const { cleanText: afterAgentMentions } = parseAgentMentionReferences(afterFileMentions);
    const { cleanText } = parseSessionReferences(afterAgentMentions);
    return { replyContext, files, cleanText };
  }, [text]);

  // Same shape MessageAttachments consumes on a real turn — one strip, one tile
  // language, so the optimistic bubble and the server turn never disagree.
  const attachments = useMemo(
    (): NormalizedAttachment[] =>
      files.map((f, i) => ({
        // Position first: an in-flight ref has no path to key on, and two
        // attachments with the same name would otherwise share a key.
        key: `optimistic:${i}:${f.pending ?? f.path}`,
        filename: getFilename(f.filename || f.path),
        mime: f.mime,
        // An upload that has not landed has no sandbox path to resolve. Passing
        // the old PREDICTED path made the tile fetch a file that did not exist.
        src: f.path || undefined,
        path: f.path || undefined,
        pending: deferPreview || Boolean(f.pending) || !f.path,
      })),
    [files, deferPreview],
  );

  return (
    <div className="ml-auto flex w-full max-w-[80%] flex-col items-end gap-2 self-end">
      {attachments.length > 0 && (
        <MessageAttachments attachments={attachments} pending={deferPreview} />
      )}
      {(cleanText || replyContext) && (
        <div className={cn(BUBBLE_SURFACE, 'w-fit overflow-hidden')}>
          {replyContext && (
            <blockquote className="border-border mb-2 border-l-2 pl-2.5">
              <p className="text-muted-foreground line-clamp-2 text-sm leading-5">{replyContext}</p>
            </blockquote>
          )}
          {cleanText && (
            <p className={BUBBLE_TEXT}>
              <HighlightMentions
                text={cleanText}
                agentNames={agentNames}
                onFileClick={onFileClick}
              />
            </p>
          )}
        </div>
      )}
      {/* The same row the server turn renders, for the same reason the
          attachments strip is shared: anything shaped differently on one side
          shows up as a twitch at handover. Its height comes from the copy
          button, so it matches the real turn's row exactly.

          `timestamp` is deliberately `null`. This turn has no server message,
          so the only stamp available is a local clock read — and this component
          is mounted TWICE (boot shell, then chat) with a crossfade between. A
          clock read at mount would differ between the two, which is the same
          two-clocks bug that already made the elapsed timer run backwards here.
          The row stays empty until `time.created` arrives with the real
          message; the label then appears without moving anything. */}
      <UserMessageActions timestamp={null} copyText={text} />
    </div>
  );
}

/**
 * Highlight @mentions in plain text (for optimistic & user messages).
 *
 * Draws the SAME chip the composer draws (`../mention-chip`) over the SAME
 * segmentation the sent message uses (`../mention-segments`). Both used to be
 * local to this file — an underlined-text treatment and its own copy of the
 * range walk — so a mention visibly changed shape twice on its way through the
 * app: chip in the composer, underline in the optimistic bubble, underline
 * again in the server turn.
 */
export function HighlightMentions({
  text,
  agentNames,
  onFileClick,
}: {
  text: string;
  agentNames?: string[];
  onFileClick?: (path: string) => void;
}) {
  // Strip every ref block (project/file/agent/session) before processing
  // inline @ mentions so the visible text never shows raw XML.
  const { cleanText, sessions } = useMemo(() => {
    const a = parseProjectReferences(text);
    const b = parseFileMentionReferences(a.cleanText);
    const c = parseAgentMentionReferences(b.cleanText);
    const d = parseSessionReferences(c.cleanText);
    return {
      cleanText: d.cleanText,
      sessions: d.sessions,
    };
  }, [text]);

  const sessionTitles = useMemo(() => sessions.map((s) => s.title), [sessions]);

  const segments = useMemo(() => {
    const built = buildMentionSegments({ text: cleanText, sessionTitles, agentNames });
    // Key each segment by its source offset in the text — content-derived and
    // unique per segment, even when the same mention appears twice.
    let offset = 0;
    return built.map((seg) => {
      const key = `${offset}:${seg.type ?? 'text'}`;
      offset += seg.text.length;
      return { ...seg, key };
    });
  }, [cleanText, sessionTitles, agentNames]);

  const openSessionMention = (raw: string) => {
    // Direct session ID (ses_...) — navigate without title lookup
    if (raw.startsWith('ses_')) {
      openTabAndNavigate({
        id: raw,
        title: 'Session',
        type: 'session',
        href: `/sessions/${raw}`,
      });
      return;
    }
    const ref = sessions.find((s) => s.title === raw);
    if (!ref) return;
    openTabAndNavigate({
      id: ref.id,
      title: ref.title || 'Session',
      type: 'session',
      href: `/sessions/${ref.id}`,
    });
  };

  return (
    <>
      {segments.map((seg) =>
        seg.type === 'file' ? (
          // Static when there is no runtime to open the file in yet (the
          // instant shell) — a chip that looks pressable and does nothing is
          // worse than one that plainly does not.
          <MentionChip
            key={seg.key}
            kind="file"
            label={seg.text.replace(/^@/, '')}
            onClick={onFileClick ? () => onFileClick(seg.text.replace(/^@/, '')) : undefined}
          />
        ) : seg.type === 'session' ? (
          <MentionChip
            key={seg.key}
            kind="session"
            label={seg.text.replace(/^@/, '')}
            onClick={() => openSessionMention(seg.text.replace(/^@/, ''))}
          />
        ) : seg.type === 'agent' ? (
          <MentionChip key={seg.key} kind="agent" label={seg.text.replace(/^@/, '')} />
        ) : (
          <span key={seg.key}>{seg.text}</span>
        ),
      )}
    </>
  );
}
