'use client';

import { UnifiedMarkdown } from '@/components/markdown';
import { CopyButton } from '@/components/markdown/copy-button';
import type {
  AcpChatItem,
  AcpJsonRpcId,
  AcpMessageAttachment,
  AcpPendingPrompts,
  AcpPendingQuestion,
} from '@kortix/sdk';
import { Bot, Brain, File, ImageIcon, Reply } from 'lucide-react';
import { memo, useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { AcpPlanCard, AcpToolCallCard } from './acp-tool-call-card';
import { AcpQuestionCard } from './acp-request-cards';
import { GridFileCard } from './grid-file-card';
import { parseAcpReplyContext, type AcpMessageItem } from './acp-turn-grouping';

/** 250ms, strong ease-out — matches the kortix-design-system /
 *  make-interfaces-feel-better motion doctrine for transcript rows. */
const ENTER_TRANSITION = { duration: 0.25, ease: [0.23, 1, 0.32, 1] as const };

export type AcpChatItemRowProps = {
  item: AcpChatItem;
  /** Whether this is the very last chat item in the transcript — the only
   *  row `isStreaming` can ever apply to. */
  isTail: boolean;
  isStreaming: boolean;
  sessionId: string;
  pending: AcpPendingPrompts;
  onRespondQuestion: (id: AcpJsonRpcId, content: Record<string, unknown>) => Promise<void>;
  onRejectQuestion: (id: AcpJsonRpcId) => Promise<void>;
  /** `false` for every row present at mount/history-load — only a row that
   *  arrives AFTER mount (a genuinely new turn) plays the enter transition.
   *  See `acp-session-chat.tsx`'s `mountedItemKeysRef`. */
  animateEnter: boolean;
  /** Opens a mentioned sandbox path in the computer panel (user-message
   *  @mentions). Reference-stable from `acp-session-chat.tsx` so `memo` still
   *  bails — optional so the memoization/request-card tests need not thread it. */
  onFileClick?: (path: string) => void;
  /** Opens a user-message file attachment in the preview. Same stability
   *  contract as `onFileClick`. */
  onOpenPreview?: (path: string) => void;
};

/**
 * One memoized transcript row. `chatItems` (from `useAcpSession`) is
 * reference-stable per item — an item untouched by the latest snapshot keeps
 * its previous object identity — so wrapping this in `memo` means only the
 * row(s) an actual update touched (almost always just the streaming tail
 * message) re-render on a new chunk, not the whole transcript.
 *
 * Question rows render `AcpQuestionCard` (`./acp-request-cards`), which stays
 * mounted once answered — a compact record in the transcript, never an
 * unmount — so a question row is never `null`. Permission requests are NO
 * longer rendered here at all: they surface pinned above the composer in the
 * `AcpSessionPermissionPrompt` (owner decision), so a `permission` chat item
 * renders nothing in the transcript.
 */
export const AcpChatItemRow = memo(function AcpChatItemRow({
  item,
  isTail,
  isStreaming,
  sessionId,
  pending,
  onRespondQuestion,
  onRejectQuestion,
  animateEnter,
  onFileClick,
  onOpenPreview,
}: AcpChatItemRowProps) {
  const reduceMotion = useReducedMotion() ?? false;

  const content = renderAcpChatItem({
    item,
    isStreaming,
    sessionId,
    pending,
    onRespondQuestion,
    onRejectQuestion,
    onFileClick,
    onOpenPreview,
  });
  if (content === null) return null;

  return (
    <motion.div
      initial={animateEnter ? (reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(8px)' }) : false}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0px)' }}
      transition={ENTER_TRANSITION}
    >
      {content}
    </motion.div>
  );
});

function renderAcpChatItem({
  item,
  isStreaming,
  sessionId,
  pending,
  onRespondQuestion,
  onRejectQuestion,
  onFileClick,
  onOpenPreview,
}: {
  item: AcpChatItem;
  isStreaming: boolean;
  sessionId: string;
  pending: AcpPendingPrompts;
  onRespondQuestion: (id: AcpJsonRpcId, content: Record<string, unknown>) => Promise<void>;
  onRejectQuestion: (id: AcpJsonRpcId) => Promise<void>;
  onFileClick?: (path: string) => void;
  onOpenPreview?: (path: string) => void;
}) {
  if (item.kind === 'message') {
    // User turns get the rich bubble (reply-context strip, attachment cards,
    // @mention highlighting, hover-reveal copy) grafted from the upstream
    // transcript; assistant/thought stay as the plain labelled markdown row.
    if (item.role === 'user') {
      return <AcpUserMessage item={item} onFileClick={onFileClick} onOpenPreview={onOpenPreview} />;
    }
    const Icon = item.role === 'thought' ? Brain : Bot;
    return (
      <div className="py-2">
        <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium capitalize"><Icon className="size-3.5" />{item.role}</div>
        <UnifiedMarkdown content={item.text} isStreaming={isStreaming} />
        {item.attachments?.length ? <AcpMessageAttachments attachments={item.attachments} /> : null}
      </div>
    );
  }
  if (item.kind === 'tool') return <AcpToolCallCard tool={item} sessionId={sessionId} />;
  if (item.kind === 'plan') return <AcpPlanCard plan={item} />;
  if (item.kind === 'permission') {
    // Permission requests moved OUT of the transcript entirely (owner
    // decision) — they surface pinned above the composer in the
    // `AcpSessionPermissionPrompt`, and once resolved leave no record row
    // here. So a permission chat item renders nothing.
    return null;
  }
  if (item.kind === 'question') {
    // Same fallback shape as the permission branch above — but a question
    // chat item already carries its own `questions` array (unlike
    // permission items), so no separate label-deriving helper is needed.
    const openRequest = pending.questions.find((candidate) => sameRpcId(candidate.id, item.id));
    const request: AcpPendingQuestion = openRequest ?? {
      id: item.id,
      method: item.method,
      questions: item.questions,
      params: item.params,
    };
    return (
      <AcpQuestionCard
        request={request}
        pending={openRequest !== undefined}
        onSubmit={(answers) => onRespondQuestion(item.id, answers)}
        onReject={() => onRejectQuestion(item.id)}
      />
    );
  }
  // `raw` (unclassified protocol frames) never reaches this row — `acp-session-chat.tsx`
  // filters them out of each turn's visible items before mapping, and renders
  // them grouped, once per turn, behind a single "Protocol events (n)"
  // `Disclosure` instead of a per-item card.
  return null;
}

function AcpMessageAttachments({ attachments }: { attachments: AcpMessageAttachment[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((attachment, index) => {
        const label = attachment.name ?? (attachment.kind === 'image' ? 'Image' : attachment.kind === 'audio' ? 'Audio' : 'Resource');
        const imageSource = attachment.kind === 'image'
          ? attachment.uri ?? (attachment.data && attachment.mimeType ? `data:${attachment.mimeType};base64,${attachment.data}` : null)
          : null;
        if (imageSource) {
          return (
            <a key={`${label}-${index}`} href={imageSource} target="_blank" rel="noopener noreferrer" className="bg-popover block overflow-hidden rounded-md border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageSource} alt={label} className="h-24 w-32 object-cover" />
              <span className="text-muted-foreground flex max-w-32 items-center gap-1 px-2 py-1 text-xs"><ImageIcon className="size-3 shrink-0" /><span className="truncate">{label}</span></span>
            </a>
          );
        }
        const content = <span className="bg-popover text-muted-foreground inline-flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs"><File className="size-3.5 shrink-0" /><span className="truncate">{label}</span></span>;
        return attachment.uri?.startsWith('http')
          ? <a key={`${label}-${index}`} href={attachment.uri} target="_blank" rel="noopener noreferrer">{content}</a>
          : <span key={`${label}-${index}`}>{content}</span>;
      })}
    </div>
  );
}

/** User-turn bubble — bg-card rounded-3xl rounded-br-lg border tail, reply
 *  context strip, file-attachment cards, @mention highlighting, and a
 *  hover-reveal copy button. Grafted from the upstream transcript so the ACP
 *  user message reads the same as the rest of the product. */
function AcpUserMessage({
  item,
  onFileClick,
  onOpenPreview,
}: {
  item: AcpMessageItem;
  onFileClick?: (path: string) => void;
  onOpenPreview?: (path: string) => void;
}) {
  const { cleanText, replyContext } = useMemo(() => parseAcpReplyContext(item.text), [item.text]);

  return (
    <div>
      <div className="flex justify-end">
        <div className="bg-card flex max-w-[90%] flex-col overflow-hidden rounded-3xl rounded-br-lg border">
          {replyContext && (
            <div className="bg-primary/5 border-primary/10 mx-3 mt-3 mb-0 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
              <Reply className="text-primary/60 size-3 flex-shrink-0" />
              <span className="text-muted-foreground truncate text-xs">
                {replyContext.length > 150 ? `${replyContext.slice(0, 150)}...` : replyContext}
              </span>
            </div>
          )}
          {item.attachments?.length ? (
            <div className="flex flex-wrap gap-2 p-3 pb-0">
              {item.attachments.map((attachment, index) => (
                <div key={`${attachment.name ?? index}`} onClick={(e) => e.stopPropagation()}>
                  <AcpAttachmentCard attachment={attachment} onOpenPreview={onOpenPreview} />
                </div>
              ))}
            </div>
          ) : null}
          {cleanText && (
            <p className="px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
              <AcpHighlightMentions text={cleanText} onFileClick={onFileClick} />
            </p>
          )}
        </div>
      </div>
      {cleanText && (
        <div className="mt-1 flex justify-end opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
          <CopyButton code={cleanText} />
        </div>
      )}
    </div>
  );
}

/** A sandbox-file attachment renders as a `GridFileCard`; anything else
 *  (an inline image blob, a remote resource) falls back to the compact
 *  chip/thumbnail treatment. */
function AcpAttachmentCard({
  attachment,
  onOpenPreview,
}: {
  attachment: AcpMessageAttachment;
  onOpenPreview?: (path: string) => void;
}) {
  const label = attachment.name ?? (attachment.kind === 'image' ? 'Image' : attachment.kind === 'audio' ? 'Audio' : 'Resource');
  const sandboxPath = attachment.uri?.startsWith('file://') ? attachment.uri.replace(/^file:\/\//, '') : null;
  if (sandboxPath) {
    return (
      <GridFileCard
        filePath={sandboxPath}
        fileName={label}
        onClick={() => onOpenPreview?.(sandboxPath)}
        className="w-[120px]"
      />
    );
  }
  const imageSource = attachment.kind === 'image'
    ? attachment.uri ?? (attachment.data && attachment.mimeType ? `data:${attachment.mimeType};base64,${attachment.data}` : null)
    : null;
  if (imageSource) {
    return (
      <a href={imageSource} target="_blank" rel="noopener noreferrer" className="bg-popover block overflow-hidden rounded-md border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageSource} alt={label} className="h-24 w-32 object-cover" />
        <span className="text-muted-foreground flex max-w-32 items-center gap-1 px-2 py-1 text-xs">
          <ImageIcon className="size-3 shrink-0" /><span className="truncate">{label}</span>
        </span>
      </a>
    );
  }
  const content = (
    <span className="bg-popover text-muted-foreground inline-flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs">
      <File className="size-3.5 shrink-0" /><span className="truncate">{label}</span>
    </span>
  );
  return attachment.uri?.startsWith('http') ? (
    <a href={attachment.uri} target="_blank" rel="noopener noreferrer">{content}</a>
  ) : content;
}

/** @-mention highlighting for user bubbles. ACP only ever sees plain typed
 *  `@token`s — so every mention renders with the same monochrome underline
 *  chip and, when it looks like a path, opens the file preview. */
function AcpHighlightMentions({ text, onFileClick }: { text: string; onFileClick?: (path: string) => void }) {
  const segments = useMemo(() => {
    const mentionRegex = /@([\w.\-/]+)/g;
    const result: { text: string; isMention: boolean }[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
      if (match.index > lastIndex) result.push({ text: text.slice(lastIndex, match.index), isMention: false });
      result.push({ text: match[0], isMention: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) result.push({ text: text.slice(lastIndex), isMention: false });
    return result;
  }, [text]);

  const mentionClass =
    'font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground/70 cursor-pointer';

  return (
    <>
      {segments.map((segment, index) =>
        segment.isMention && onFileClick ? (
          <span
            key={index}
            className={mentionClass}
            onClick={(e) => {
              e.stopPropagation();
              onFileClick(segment.text.replace(/^@/, ''));
            }}
          >
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Same JSON-RPC id (`string | number`) comparison the old inline permission/
 *  question lookup used — `JSON.stringify` handles both id kinds without a
 *  runtime type check. */
function sameRpcId(a: AcpJsonRpcId, b: AcpJsonRpcId): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
