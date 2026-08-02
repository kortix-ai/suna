'use client';

import { ArrowBendUpLeftIcon as Reply } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { GridFileCard } from '@/features/session/grid-file-card';
import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseProjectReferences,
  parseReplyContext,
  parseSessionReferences,
} from '@/features/session/message-parsing';
import { SessionBusyIndicator } from '@/features/session/session-busy-indicator';
import { cn } from '@/lib/utils';
import { openTabAndNavigate } from '@/stores/tab-store';

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
  /** Opens an attached file's preview. Omitted before a runtime exists. */
  onFilePreview,
  /** Skip thumbnail fetches while there is no sandbox to fetch them from. */
  deferPreview,
  className,
}: {
  text: string;
  agentNames?: string[];
  onFileClick?: (path: string) => void;
  onFilePreview?: (path: string) => void;
  deferPreview?: boolean;
  className?: string;
}) {
  return (
    <div data-turn-id="optimistic" className={cn('mt-12 first:mt-0', className)}>
      <div className="flex justify-end">
        <OptimisticUserBubble
          text={text}
          agentNames={agentNames}
          onFileClick={onFileClick}
          onFilePreview={onFilePreview}
          deferPreview={deferPreview}
        />
      </div>
      <SessionBusyIndicator className="mt-6" />
    </div>
  );
}

function OptimisticUserBubble({
  text,
  agentNames,
  onFileClick,
  onFilePreview,
  deferPreview,
}: {
  text: string;
  agentNames?: string[];
  onFileClick?: (path: string) => void;
  onFilePreview?: (path: string) => void;
  deferPreview?: boolean;
}) {
  // Strip every ref block the composer folded into the prompt, in the order it
  // folded them in, so the bubble shows the sentence the user typed and the
  // attachments as cards — never raw XML.
  const { replyContext, files, cleanText } = useMemo(() => {
    const { cleanText: afterReply, replyContext } = parseReplyContext(text);
    const { cleanText: afterFiles, files } = parseFileReferences(afterReply);
    const { cleanText: afterProjects } = parseProjectReferences(afterFiles);
    const { cleanText: afterFileMentions } = parseFileMentionReferences(afterProjects);
    const { cleanText: afterAgentMentions } = parseAgentMentionReferences(afterFileMentions);
    const { cleanText } = parseSessionReferences(afterAgentMentions);
    return { replyContext, files, cleanText };
  }, [text]);

  return (
    <div className="bg-card flex max-w-[90%] flex-col overflow-hidden rounded-3xl rounded-br-lg border">
      {replyContext && (
        <div className="bg-primary/5 border-primary/10 mx-3 mt-3 mb-0 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
          <Reply className="text-primary/60 size-3 flex-shrink-0" />
          <span className="text-muted-foreground truncate text-xs">
            {replyContext.length > 150 ? `${replyContext.slice(0, 150)}...` : replyContext}
          </span>
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3 pb-0">
          {files.map((f, i) => (
            <div key={`${f.path}-${i}`} onClick={(e) => e.stopPropagation()}>
              <GridFileCard
                filePath={f.path}
                fileName={f.path.split('/').pop() || f.path}
                onClick={onFilePreview ? () => onFilePreview(f.path) : undefined}
                deferPreview={deferPreview}
              />
            </div>
          ))}
        </div>
      )}
      {cleanText && (
        <p className="px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
          <HighlightMentions
            text={cleanText}
            agentNames={agentNames}
            onFileClick={onFileClick}
          />
        </p>
      )}
    </div>
  );
}

/** Highlight @mentions in plain text (for optimistic & user messages). */
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

  const segments = useMemo(() => {
    type MentionType = 'file' | 'agent' | 'session';
    if (!cleanText) return [{ text: cleanText, type: undefined as MentionType | undefined }];

    // Detect session @mentions first (titles can contain spaces)
    const sessionDetected: { start: number; end: number; type: MentionType }[] = [];
    for (const s of sessions) {
      const needle = `@${s.title}`;
      const idx = cleanText.indexOf(needle);
      if (idx !== -1) {
        sessionDetected.push({
          start: idx,
          end: idx + needle.length,
          type: 'session',
        });
      }
    }

    const agentSet = new Set(agentNames || []);
    const mentionRegex = /@(\S+)/g;
    const detected: { start: number; end: number; type: MentionType }[] = [...sessionDetected];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(cleanText)) !== null) {
      const mStart = match.index;
      // Skip if overlaps with a session mention
      if (sessionDetected.some((s) => mStart >= s.start && mStart < s.end)) continue;
      const name = match[1];
      // Treat @ses_<id> tokens as session mentions
      const type: MentionType = name.startsWith('ses_')
        ? 'session'
        : agentSet.has(name)
          ? 'agent'
          : 'file';
      detected.push({
        start: mStart,
        end: match.index + match[0].length,
        type,
      });
    }
    if (detected.length === 0) return [{ text: cleanText, type: undefined }];

    detected.sort((a, b) => a.start - b.start || b.end - a.end);
    const result: { text: string; type?: MentionType }[] = [];
    let lastIndex = 0;
    for (const ref of detected) {
      if (ref.start < lastIndex) continue;
      if (ref.start > lastIndex) result.push({ text: cleanText.slice(lastIndex, ref.start) });
      result.push({
        text: cleanText.slice(ref.start, ref.end),
        type: ref.type,
      });
      lastIndex = ref.end;
    }
    if (lastIndex < cleanText.length) result.push({ text: cleanText.slice(lastIndex) });
    return result;
  }, [cleanText, agentNames, sessions]);

  // Uniform monochrome mention style — Kortix brand is strictly neutral, so
  // every mention kind (file / agent / session) renders identically
  // as an underlined foreground chip. Kind is distinguished by click target.
  const mentionClass =
    'font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground/70 cursor-pointer';
  const mentionClassStatic = 'font-medium text-foreground';

  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'file' && onFileClick ? (
          <button
            key={i}
            type="button"
            className={cn(mentionClass, 'appearance-none bg-transparent p-0 text-left')}
            onClick={(e) => {
              e.stopPropagation();
              onFileClick(seg.text.replace(/^@/, ''));
            }}
          >
            {seg.text}
          </button>
        ) : seg.type === 'session' ? (
          <button
            key={i}
            type="button"
            className={cn(mentionClass, 'appearance-none bg-transparent p-0 text-left')}
            onClick={(e) => {
              e.stopPropagation();
              const raw = seg.text.replace(/^@/, '');
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
              if (ref) {
                openTabAndNavigate({
                  id: ref.id,
                  title: ref.title || 'Session',
                  type: 'session',
                  href: `/sessions/${ref.id}`,
                });
              }
            }}
          >
            {seg.text}
          </button>
        ) : (
          <span
            key={i}
            className={cn((seg.type === 'file' || seg.type === 'agent') && mentionClassStatic)}
          >
            {seg.text}
          </span>
        ),
      )}
    </>
  );
}
