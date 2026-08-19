'use client';

/** Moved from session-chat.tsx (`UserMessageRow`) so the turn module owns the
 *  user-message card. Full-width card, no reference chips — see
 *  docs/superpowers/sdd/2026-07-31-assistant-turn-ux/task-6-report.md. */

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CaretDownIcon as ChevronDown,
  PencilSimpleIcon,
  ScissorsIcon as Scissors,
  TimerIcon as Timer,
} from '@phosphor-icons/react';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import {
  PreviewImage,
  PreviewImageContent,
  PreviewImageTrigger,
} from '@/components/ui/preview-image';
import { detectCommandFromText } from '@/features/session/detect-command';
import { useSandboxImageSrc } from '@/features/session/sandbox-image';
import { cn } from '@/lib/utils';
import { getFilename } from '@/lib/utils/file-utils';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import {
  isAgentPart,
  isFilePart,
  isTextPart,
  splitUserParts,
  type AgentPart,
  type Command,
  type FilePart,
  type MessageWithParts,
  type TextPart,
} from '@/ui';
import {
  FILE_TILE_SURFACE,
  FileTileBody,
  TILE_INTERACTIVE,
  TILE_SURFACE,
} from '../attachment-tile';
import { MentionChip } from '../mention-chip';
import { buildMentionSegments, type MentionSourceRef } from '../mention-segments';
import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseProjectReferences,
  parseReplyContext,
  parseSessionReferences,
  parseSystemNotifications,
  stripSystemPtyText,
  SystemNotificationCard,
} from '../message-parsing';

import { messageCreatedAt } from './message-time';
import { MessageTimeLabel } from './message-time-label';

// ============================================================================
// Fixed channel brand colors + DCP (dynamic context pruning) notifications —
// exclusive to UserMessage, moved verbatim from session-chat.tsx.
// ============================================================================

// Fixed third-party brand colors for channel-source cards. These are the
// platforms' own brand hues (not themeable), so they live as named
// constants rather than as inline hex literals.
const CHANNEL_BRAND_COLOR = {
  Telegram: '#29B6F6',
  Slack: '#E91E63',
} as const;

// ============================================================================
// Parse <dcp-notification> XML tags from DCP plugin messages
// ============================================================================

interface DCPPrunedItem {
  tool: string;
  description: string;
}

interface DCPNotification {
  type: 'prune' | 'compress';
  tokensSaved: number;
  batchSaved: number;
  prunedCount: number;
  extractedTokens: number;
  reason?: string;
  items: DCPPrunedItem[];
  distilled?: string;
  // compress-specific
  messagesCount?: number;
  toolsCount?: number;
  topic?: string;
  summary?: string;
}

const DCP_TAG_REGEX = /<dcp-notification\s+([^>]*)>([\s\S]*?)<\/dcp-notification>/g;
const DCP_ITEM_REGEX = /<dcp-item\s+tool="([^"]*?)"\s+description="([^"]*?)"\s*\/>/g;
const DCP_DISTILLED_REGEX = /<dcp-distilled>([\s\S]*?)<\/dcp-distilled>/;
const DCP_SUMMARY_REGEX = /<dcp-summary>([\s\S]*?)<\/dcp-summary>/;

function unescapeXml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*?)"`);
  const m = attrs.match(re);
  return m ? unescapeXml(m[1]) : undefined;
}

// Legacy DCP format: "▣ DCP | ~12.5K tokens saved total" (pre-XML version)
const DCP_LEGACY_REGEX = /^▣ DCP \| ~([\d.]+K?) tokens saved total/;
const DCP_LEGACY_PRUNING_REGEX =
  /▣ Pruning \(~([\d.]+K?) tokens(?:, distilled ([\d.]+K?) tokens)?\)(?:\s*—\s*(.+))?/;
const DCP_LEGACY_ITEM_REGEX = /→\s+(\S+?):\s+(.+)/g;

function parseLegacyDCPNotification(text: string): DCPNotification | null {
  const headerMatch = text.match(DCP_LEGACY_REGEX);
  if (!headerMatch) return null;

  const tokenStr = headerMatch[1];
  const tokensSaved = tokenStr.endsWith('K')
    ? Math.round(Number.parseFloat(tokenStr.slice(0, -1)) * 1000)
    : Number.parseInt(tokenStr, 10);

  const pruningMatch = text.match(DCP_LEGACY_PRUNING_REGEX);
  let batchSaved = 0;
  let extractedTokens = 0;
  let reason: string | undefined;
  if (pruningMatch) {
    const batchStr = pruningMatch[1];
    batchSaved = batchStr.endsWith('K')
      ? Math.round(Number.parseFloat(batchStr.slice(0, -1)) * 1000)
      : Number.parseInt(batchStr, 10);
    if (pruningMatch[2]) {
      const extStr = pruningMatch[2];
      extractedTokens = extStr.endsWith('K')
        ? Math.round(Number.parseFloat(extStr.slice(0, -1)) * 1000)
        : Number.parseInt(extStr, 10);
    }
    reason = pruningMatch[3]?.trim();
  }

  const items: DCPPrunedItem[] = [];
  let itemMatch;
  DCP_LEGACY_ITEM_REGEX.lastIndex = 0;
  while ((itemMatch = DCP_LEGACY_ITEM_REGEX.exec(text)) !== null) {
    items.push({ tool: itemMatch[1], description: itemMatch[2].trim() });
  }

  // Check for compress format
  const isCompress = text.includes('▣ Compressing');

  return {
    type: isCompress ? 'compress' : 'prune',
    tokensSaved,
    batchSaved,
    prunedCount: items.length,
    extractedTokens,
    reason,
    items,
  };
}

function parseDCPNotifications(text: string): {
  cleanText: string;
  notifications: DCPNotification[];
} {
  const notifications: DCPNotification[] = [];

  // First try XML format
  const cleanText = text
    .replace(DCP_TAG_REGEX, (_, attrs: string, body: string) => {
      const type = (parseAttr(attrs, 'type') || 'prune') as 'prune' | 'compress';
      const tokensSaved = Number.parseInt(parseAttr(attrs, 'tokens-saved') || '0', 10);
      const batchSaved = Number.parseInt(parseAttr(attrs, 'batch-saved') || '0', 10);
      const prunedCount = Number.parseInt(parseAttr(attrs, 'pruned-count') || '0', 10);
      const extractedTokens = Number.parseInt(parseAttr(attrs, 'extracted-tokens') || '0', 10);
      const reason = parseAttr(attrs, 'reason');

      // Parse items
      const items: DCPPrunedItem[] = [];
      let itemMatch;
      DCP_ITEM_REGEX.lastIndex = 0;
      while ((itemMatch = DCP_ITEM_REGEX.exec(body)) !== null) {
        items.push({
          tool: unescapeXml(itemMatch[1]),
          description: unescapeXml(itemMatch[2]),
        });
      }

      // Parse distilled
      const distilledMatch = body.match(DCP_DISTILLED_REGEX);
      const distilled = distilledMatch ? unescapeXml(distilledMatch[1]) : undefined;

      // Compress-specific
      const messagesCount =
        Number.parseInt(parseAttr(attrs, 'messages-count') || '0', 10) || undefined;
      const toolsCount = Number.parseInt(parseAttr(attrs, 'tools-count') || '0', 10) || undefined;
      const topic = parseAttr(attrs, 'topic');
      const summaryMatch = body.match(DCP_SUMMARY_REGEX);
      const summary = summaryMatch ? unescapeXml(summaryMatch[1]) : undefined;

      notifications.push({
        type,
        tokensSaved,
        batchSaved,
        prunedCount,
        extractedTokens,
        reason,
        items,
        distilled,
        messagesCount,
        toolsCount,
        topic,
        summary,
      });
      return '';
    })
    .trim();

  // If no XML notifications found, try legacy format
  if (notifications.length === 0 && cleanText) {
    const legacy = parseLegacyDCPNotification(cleanText);
    if (legacy) {
      notifications.push(legacy);
      return { cleanText: '', notifications };
    }
  }

  return { cleanText, notifications };
}

// ============================================================================
// DCP Notification Card — styled component for pruning/compress events
// ============================================================================

const DCP_REASON_LABELS: Record<string, string> = {
  completion: 'Task Complete',
  noise: 'Noise Removal',
  extraction: 'Extraction',
};

/**
 * Stable content-derived React keys for immutable parsed lists whose items
 * carry no id. Duplicate content gets an occurrence suffix so keys stay
 * unique; the lists never reorder (they are pure derivations of one message
 * text), so occurrence order is part of an item's identity.
 */
function withContentKeys<T>(
  items: readonly T[],
  contentOf: (item: T) => string,
): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const content = contentOf(item);
    const n = seen.get(content) ?? 0;
    seen.set(content, n + 1);
    return { key: n === 0 ? content : `${content}~${n}`, item };
  });
}

function formatDCPTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = (tokens / 1000).toFixed(1).replace('.0', '');
    return `${k}K`;
  }
  return tokens.toString();
}

function DCPNotificationCard({ notification }: { notification: DCPNotification }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [expanded, setExpanded] = useState(false);
  const isPrune = notification.type === 'prune';
  const hasItems = notification.items.length > 0;
  const hasDetails = hasItems || notification.distilled || notification.summary;

  return (
    <div className="border-border/60 bg-card/50 overflow-hidden rounded-lg border">
      {/* Header */}
      <Button
        onClick={() => hasDetails && setExpanded(!expanded)}
        variant="ghost"
        className={cn(
          'border-border/40 bg-muted/30 flex h-auto w-full items-center justify-start gap-2 rounded-none border-b px-3 py-2',
          !hasDetails && 'pointer-events-none',
        )}
      >
        <Scissors className="text-muted-foreground/70 size-3.5 flex-shrink-0" />
        <span className="text-muted-foreground/70 text-xs font-medium tracking-wider uppercase">
          {isPrune ? 'Context Pruned' : 'Context Compressed'}
        </span>

        {/* Stats pills */}
        <div className="ml-auto flex items-center gap-1.5">
          {notification.reason && (
            <Badge variant="muted" size="sm">
              {DCP_REASON_LABELS[notification.reason] || notification.reason}
            </Badge>
          )}
          {isPrune && notification.prunedCount > 0 && (
            <Badge variant="warning" size="sm">
              {notification.prunedCount} pruned
            </Badge>
          )}
          {!isPrune && notification.messagesCount && notification.messagesCount > 0 && (
            <Badge variant="info" size="sm">
              {notification.messagesCount} msgs
            </Badge>
          )}
          {notification.batchSaved > 0 && (
            <Badge variant="success" size="sm">
              -{formatDCPTokens(notification.batchSaved)} tokens
            </Badge>
          )}
          <Badge variant="muted" size="sm">
            {formatDCPTokens(notification.tokensSaved)} saved
          </Badge>
          {hasDetails && (
            <ChevronDown
              className={cn(
                'text-muted-foreground/50 size-3 transition-transform',
                expanded && 'rotate-180',
              )}
            />
          )}
        </div>
      </Button>

      {/* Expandable details */}
      {expanded && hasDetails && (
        <div className="space-y-2 px-3 py-2">
          {/* Pruned items list */}
          {hasItems && (
            <div className="space-y-0.5">
              {withContentKeys(notification.items, (it) => `${it.tool}:${it.description}`).map(
                ({ key, item }) => (
                  <div
                    key={key}
                    className="text-muted-foreground/80 flex items-center gap-2 text-xs"
                  >
                    <span className="text-muted-foreground/40">
                      {tHardcodedUi.raw('componentsSessionSessionChat.line1124JsxTextRarr')}
                    </span>
                    <span className="bg-muted/50 text-muted-foreground/70 rounded px-1 py-0.5 font-mono text-xs">
                      {item.tool}
                    </span>
                    {item.description && (
                      <span className="max-w-[300px] truncate">{item.description}</span>
                    )}
                  </div>
                ),
              )}
            </div>
          )}

          {/* Compress topic */}
          {notification.topic && (
            <div className="text-muted-foreground/80 text-xs">
              <span className="text-muted-foreground/50">Topic:</span>{' '}
              <span>{notification.topic}</span>
            </div>
          )}

          {/* Distilled content */}
          {notification.distilled && (
            <div className="border-border/30 mt-1.5 border-t pt-1.5">
              <div className="text-muted-foreground/60 mb-1 text-xs font-medium tracking-wider uppercase">
                Distilled
              </div>
              <div className="text-muted-foreground/80 max-h-32 overflow-y-auto text-xs wrap-break-word whitespace-pre-wrap">
                {notification.distilled}
              </div>
            </div>
          )}

          {/* Compress summary */}
          {notification.summary && (
            <div className="border-border/30 mt-1.5 border-t pt-1.5">
              <div className="text-muted-foreground/60 mb-1 text-xs font-medium tracking-wider uppercase">
                Summary
              </div>
              <div className="text-muted-foreground/80 max-h-32 overflow-y-auto text-xs wrap-break-word whitespace-pre-wrap">
                {notification.summary}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Exported so `optimistic-turn.tsx` imports these instead of keeping its own
 * copy. It used to keep one, "matching this file" by comment only — the two
 * drifted on background shade once already (fixed), then drifted again on
 * padding/radius (`px-3 py-2.5 rounded-lg` vs `px-4.5 py-3.5 rounded-xl`),
 * which is a visible bubble-size jump the instant a sent message's optimistic
 * turn hands over to the real server turn. A shared constant makes that
 * handover a no-op instead of a maintenance promise.
 */
export const BUBBLE_TEXT = cn(
  'text-[0.9rem] leading-[22px] font-medium',
  'wrap-break-word whitespace-pre-wrap select-text',
);

export const BUBBLE_SURFACE = cn(
  'bg-sidebar dark:bg-muted text-foreground flex max-w-full flex-col px-4.5 py-3.5 select-none rounded-xl',
);

export interface NormalizedAttachment {
  key: string;
  filename: string;
  mime?: string;
  src?: string;
  path?: string;
  /** The bytes are still on their way to the sandbox. */
  pending?: boolean;
}

/**
 * The attachment strip's input: message file-parts plus parsed upload refs.
 *
 * Uploads are keyed by POSITION first, then by their pending id or path. Keying
 * on the path alone was a duplicate-key generator: an optimistic ref carries no
 * path at all until the daemon answers, and three screenshots pasted in one
 * message are all named `image.png`, so they used to produce three identical
 * `upload:/workspace/uploads/image.png` keys and React collapsed them.
 *
 * A ref with no path is still in flight, so it renders `pending` — a spinner
 * over its own name — instead of asking the sandbox for a file that does not
 * exist yet.
 */
export function normalizeAttachments(
  parts: FilePart[],
  uploads: ReadonlyArray<{ path: string; mime: string; filename: string; pending?: string }>,
): NormalizedAttachment[] {
  return [
    ...parts.map((file) => ({
      key: file.id,
      filename: file.filename || 'File',
      mime: file.mime,
      src: file.url,
    })),
    ...uploads.map((file, index) => ({
      key: `upload:${index}:${file.pending ?? file.path}`,
      filename: file.filename || getFilename(file.path),
      mime: file.mime,
      src: file.path || undefined,
      path: file.path || undefined,
      pending: Boolean(file.pending) || !file.path,
    })),
  ];
}

/**
 * Attachments shown before the grid collapses into a `+N` tile.
 *
 * Whole rows of four, because the cap exists to bound HEIGHT and a cap that
 * leaves a half-filled tail trades one ragged shape for another.
 */
const ATTACHMENT_TILE_CAP = 8;
export { ATTACHMENT_TILE_CAP };

export interface AttachmentGridPlan {
  visible: NormalizedAttachment[];
  hidden: number;
}

/**
 * How much of the attachment block to show.
 *
 * That is the whole decision. Images and files are the SAME square tile, so
 * there is no kind to branch on, no order to group, and no per-kind cap — the
 * grid lays attachments out exactly as the user attached them.
 */
export function planAttachmentGrid(
  attachments: NormalizedAttachment[],
  expanded: boolean,
): AttachmentGridPlan {
  if (expanded || attachments.length <= ATTACHMENT_TILE_CAP) {
    return { visible: attachments, hidden: 0 };
  }
  return {
    visible: attachments.slice(0, ATTACHMENT_TILE_CAP),
    hidden: attachments.length - ATTACHMENT_TILE_CAP,
  };
}

/** True when we can actually paint this attachment rather than name it. */
const isImageAttachment = (file: NormalizedAttachment) =>
  Boolean(file.mime?.startsWith('image/') && file.src);

// TILE_SURFACE, TILE_INTERACTIVE and FileTileBody (icon top-left, filename
// two-line-clamped along the bottom) live in `../attachment-tile` — shared
// with the composer's preview tiles so the two can never drift apart. See
// that module for why.

/**
 * An image attachment: a square tile that opens full-size on click.
 *
 * Resolving the src here (rather than handing the path to `SandboxImage`) buys
 * two things: the lightbox gets the same URL the tile is already showing, and
 * the tile is free to be any size — `SandboxImage` pins its loading and error
 * states to an 80px minimum, which is what produced the oversized "Image
 * unavailable" block.
 *
 * A tile that cannot resolve falls back to the named treatment. It used to
 * render an empty `<span>`, which is how eleven attachments became eleven blank
 * boxes — the layout looked broken on top of being ugly, and nothing on screen
 * said which picture was missing.
 */
function AttachmentImage({
  file,
  className,
  pending,
}: {
  file: NormalizedAttachment;
  className?: string;
  /** The whole message is still being sent. */
  pending?: boolean;
}) {
  const { resolvedSrc, isLoading } = useSandboxImageSrc(file.src!);

  if (!resolvedSrc) {
    // An image that has not resolved is either still arriving or never will.
    // Both used to render an empty box; now the first spins and the second
    // falls back to the named tile, so the tile always says which it is.
    return (
      <span title={file.filename} className={className}>
        <FileTileBody filename={file.filename} pending={pending || isLoading || file.pending} />
      </span>
    );
  }

  return (
    <PreviewImage>
      <PreviewImageTrigger asChild>
        <button
          type="button"
          title={file.filename}
          onClick={(e) => e.stopPropagation()}
          className={className}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={resolvedSrc} alt={file.filename} className="size-full object-cover" />
        </button>
      </PreviewImageTrigger>
      <PreviewImageContent fileContent={resolvedSrc} fileName={file.filename} fullscreen />
    </PreviewImage>
  );
}

/**
 * What the user handed over with the message.
 *
 * One grid, four columns, right-aligned, in the order the user attached things.
 * This replaced a rows-or-tiles switch whose "a file pulls images back to rows"
 * branch turned a 15-attachment message into 15 filename-width rows stacked
 * against the right edge — roughly 700px of staircase.
 */
/**
 * Shared attachment strip — used by the real user turn and the optimistic turn
 * so the shell → chat crossfade never swaps card chrome for tile chrome.
 */
export function MessageAttachments({
  attachments,
  pending,
}: {
  attachments: NormalizedAttachment[];
  /** The whole message is still being sent, so every tile is still uploading. */
  pending?: boolean;
}) {
  const openFileInComputer = useKortixComputerStore((s) => s.openFileInComputer);
  const [expanded, setExpanded] = useState(false);

  const { visible, hidden } = planAttachmentGrid(attachments, expanded);
  if (visible.length === 0) return null;

  return (
    // Fixed 5rem squares that simply wrap, packed against the right rail. No
    // grid, no column track.
    //
    // The cap only reads as deliberate if the rows come out even, and with free
    // wrapping the row length follows whatever width happens to be available —
    // at 579px seven fit, so a cap of 8 left one orphan tile stranded on its own
    // row. `max-w` in the same units as the tile pins it: 4 × 5rem + 3 × 0.5rem
    // = 21.5rem, so a row is always four and the cap is always two clean rows,
    // at any root font size.
    <ul className="flex max-w-[21.5rem] flex-wrap justify-end gap-2">
      {visible.map((file, index) => {
        // The LAST visible tile carries the overflow count over its own
        // contents, so the grid never shows a blank slot — the count is an
        // overlay, not a placeholder. It opens the rest instead of the file, so
        // it is a plain button: nesting one inside the preview trigger would be
        // two buttons deep and invalid.
        if (hidden > 0 && index === visible.length - 1) {
          return (
            <li key={file.key} className="contents">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(true);
                }}
                aria-label={`Show ${hidden} more attachment${hidden === 1 ? '' : 's'}`}
                className={cn(
                  TILE_SURFACE,
                  TILE_INTERACTIVE,
                  'text-muted-foreground flex items-center justify-center text-sm font-medium',
                )}
              >
                +{hidden}
              </button>
            </li>
          );
        }

        if (isImageAttachment(file)) {
          return (
            <li key={file.key} className="contents">
              <AttachmentImage
                file={file}
                pending={pending}
                className={cn(TILE_SURFACE, TILE_INTERACTIVE)}
              />
            </li>
          );
        }

        const canOpen = Boolean(file.path);
        return (
          <li key={file.key} className="contents">
            <button
              type="button"
              disabled={!canOpen}
              title={file.filename}
              onClick={(e) => {
                e.stopPropagation();
                if (file.path) openFileInComputer(file.path);
              }}
              className={cn(FILE_TILE_SURFACE, canOpen && TILE_INTERACTIVE)}
            >
              <FileTileBody filename={file.filename} pending={pending || file.pending} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ============================================================================
// The bubble
// ============================================================================

/**
 * The message bubble, including the clamp and its expand affordance.
 *
 * The expand control is the CHEVRON, not the bubble. The bubble used to carry
 * `role="button"` + `tabIndex={0}` whenever the text was clamped, and it
 * contains `MentionChip` buttons — a file or session chip that opens what it
 * names. Interactive content inside a `role="button"` is invalid for a reason
 * that bites in practice: assistive technology flattens a button's subtree into
 * its accessible name, so the chips stopped existing as controls, while still
 * being tab stops in the browser — a bubble that a keyboard user could enter,
 * tab through, and never operate.
 *
 * Promoting the chevron — which already sat exactly where the affordance reads
 * — makes it a real `<button>` with a name (`Expand message`), state
 * (`aria-expanded`) and a target (`aria-controls` → the clamped region). The
 * bubble keeps a plain `onClick` because clicking anywhere in a long message to
 * open it is a mouse convenience worth keeping, and a div with a click handler
 * claims nothing to a screen reader. That click is also why `MentionChip` calls
 * `stopPropagation`: without it, opening a file would toggle the bubble too.
 *
 * Exported, and taking `canExpand` as a PROP rather than measuring it, because
 * the measurement is a `ResizeObserver` in `UserMessage` that only exists in a
 * browser. Under `renderToStaticMarkup` — the only render this app can test —
 * effects never commit, so `canExpand` is permanently `false` and every
 * assertion about the clamped bubble would pass no matter what the clamped
 * branch renders. The seam is what makes the expanded/collapsed markup able to
 * fail at all.
 */
export function UserMessageBubble({
  canExpand,
  expanded,
  onToggle,
  fullWidth,
  textId,
  textRef,
  replyContext,
  children,
}: {
  /** The text overflows its clamp, so there is something to expand. */
  canExpand: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** A plan-owning turn takes the full column instead of hugging its text. */
  fullWidth?: boolean;
  /** Ties the toggle's `aria-controls` to the region it expands. */
  textId: string;
  textRef?: React.RefObject<HTMLDivElement | null>;
  replyContext?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        BUBBLE_SURFACE,
        'relative overflow-hidden',
        fullWidth ? 'w-full' : 'w-fit',
        canExpand && 'cursor-pointer transition-colors',
      )}
      onClick={() => canExpand && onToggle()}
    >
      {/* Quoted context — a rule, not a card.
          A filled, bordered banner sitting on the already-filled bubble
          made two nested surfaces, and the louder one was the quote rather
          than the message the reader actually came for. A left rule says
          "this part is quoted" with no chrome at all, and lets the message
          lead again.
          `line-clamp-2` replaces the old `slice(0, 150) + '...'` AND
          `truncate` pair: two truncations that could stack two ellipses,
          and cut mid-word at the container edge. Clamping wraps to a
          second line and ends cleanly, and the full text stays in the DOM
          to select and copy. */}
      {replyContext && (
        <blockquote className="border-border mb-2 border-l-2 pl-2.5">
          <p className="text-muted-foreground line-clamp-2 text-sm leading-5">{replyContext}</p>
        </blockquote>
      )}

      {/* Text content */}
      {children && (
        <div className="relative">
          <div
            ref={textRef}
            id={textId}
            className={cn(
              'max-w-full min-w-0',
              BUBBLE_TEXT,
              !expanded && 'max-h-[200px] overflow-hidden',
            )}
          >
            {children}
          </div>

          {/* Gradient fade for collapsed long messages. Keyed to `muted`
              so it dissolves into the bubble it sits on, not the old card. */}
          {canExpand && !expanded && (
            <div className="from-sidebar dark:from-muted pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent" />
          )}

          {/* The expand/collapse control. `stopPropagation` because the bubble
              behind it still toggles on click — without it one press would fire
              both handlers and cancel itself out. */}
          {canExpand && (
            <button
              type="button"
              aria-label={expanded ? 'Collapse message' : 'Expand message'}
              aria-expanded={expanded}
              aria-controls={textId}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="bg-muted/80 text-muted-foreground hover:bg-muted focus-visible:ring-ring absolute right-0 bottom-0 z-10 cursor-pointer rounded-md p-1 backdrop-blur-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
              />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// User message meta — when it was sent, whether it was edited, what you can do
// ============================================================================

/**
 * The line under a user bubble: when it was sent, whether it was edited, and
 * what you can do to it — one row, right-aligned against the same rail as the
 * bubble.
 *
 * ONE row, deliberately, and the whole row reveals on hover. The transcript is
 * the message thread — a timestamp on every turn, permanently, is chrome
 * competing with the conversation. Putting it on the same reveal as the
 * actions keeps the quiet reading intact and puts the "when" exactly where a
 * reader already goes to act on a message.
 *
 * The reveal is `opacity`, never mount/unmount, so the row occupies its height
 * either way and hovering a turn never reflows the thread.
 *
 * `focus-within` matches the assistant turn's action bar: anything that only
 * appears on hover is unreachable by keyboard otherwise. The timestamp is a
 * `<time datetime=…>` element, so its machine-readable value stays in the
 * accessibility tree regardless of the visual reveal.
 *
 * Shared with `OptimisticTurn` so the pending turn and the server turn cannot
 * drift — the same reason `MessageAttachments` is shared.
 */
export function UserMessageActions({
  timestamp,
  edited,
  copyText,
  messageId,
  rewindPromptText,
  onRewind,
  rewindDisabled,
  leading,
  alwaysVisible = false,
}: {
  /** Epoch milliseconds, or `null` when the backend never stamped one. */
  timestamp: number | null;
  edited?: boolean;
  /** Omitted when there is nothing to copy — the row then carries meta alone
   *  rather than disappearing, so an attachment-only message keeps its time. */
  copyText?: string;
  messageId?: string;
  rewindPromptText?: string;
  onRewind?: (messageId: string, text: string) => void;
  rewindDisabled?: boolean;
  /**
   * Rendered FIRST in the row: a queued prompt's status + controls
   * (`QueuedPromptControls`) — the same row, so a pending bubble does not
   * grow a second strip under it.
   */
  leading?: React.ReactNode;
  /** Keep the row visible without hover — a failed send must not be a thing
   *  the user has to hunt for. */
  alwaysVisible?: boolean;
}) {
  // Copy stays available while the agent is busy / rewind is locked.
  // Only edit-from-here is gated — hiding the whole bar was wrong.
  const canRewind = Boolean(onRewind && messageId && !rewindDisabled);
  const hasMeta = timestamp !== null || Boolean(edited);

  // Nothing to say and nothing to do — don't leave an empty row behind.
  if (!hasMeta && !copyText && !leading) return null;

  return (
    // The fade sits on the ROW, so the timestamp and the buttons reveal
    // together as one object rather than a label with controls growing out of
    // it. `opacity`, never mounting: the row holds its height whether or not
    // the pointer is over the turn, so nothing in the transcript reflows.
    <div
      className={cn(
        'flex w-full items-center justify-end gap-2 transition-opacity duration-150',
        alwaysVisible
          ? 'opacity-100'
          : 'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100',
      )}
    >
      {leading}
      {/* `InlineMeta` owns the `·` separator and drops absent children, so a
          message with no stamp never renders a leading bullet. Skipped
          entirely when there is no meta at all — the optimistic turn would
          otherwise carry an empty node the real turn does not. */}
      {hasMeta && (
        <InlineMeta>
          {timestamp !== null && <MessageTimeLabel timestamp={timestamp} />}
          {edited && 'edited'}
        </InlineMeta>
      )}
      {copyText && (
        <div className="flex shrink-0 items-center gap-0.5">
          {canRewind && (
            <Hint label="Edit from here" side="top" align="center">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Edit message and rewind session"
                onClick={() => onRewind?.(messageId as string, rewindPromptText ?? '')}
              >
                <PencilSimpleIcon weight="regular" className="text-foreground size-4" />
              </Button>
            </Hint>
          )}

          <CopyButton code={copyText} size="sm" hintSide="top" />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// User Message
// ============================================================================

export function UserMessage({
  message,
  agentNames,
  commandInfo,
  commands,
  sessionId,
  ownsPlan,
  onRewind,
  rewindDisabled = false,
  leadingActions,
  actionsAlwaysVisible = false,
}: {
  message: MessageWithParts;
  agentNames?: string[];
  commandInfo?: {
    name: string;
    args?: string;
    /**
     * Where the `/` chip sat in `args`. Absent for a message whose command was
     * inferred from its template (`detectCommandFromText`) rather than typed in
     * this tab — that path has no position to recover, so the chip leads.
     */
    split?: { before: string; after: string };
  };
  commands?: Command[];
  sessionId: string;
  ownsPlan: boolean;
  onRewind?: (messageId: string, text: string) => void;
  rewindDisabled?: boolean;
  /** See `UserMessageActions.leading` — a queued prompt's status + controls. */
  leadingActions?: React.ReactNode;
  /** See `UserMessageActions.alwaysVisible`. */
  actionsAlwaysVisible?: boolean;
}) {
  const openFileInComputer = useKortixComputerStore((s) => s.openFileInComputer);
  const { attachments, stickyParts } = useMemo(
    () => splitUserParts(message.parts),
    [message.parts],
  );

  // Extract text from sticky parts, parse out <file> and <session_ref> XML references
  // Filter out both synthetic AND ignored parts from user-visible text
  const visibleTextParts = stickyParts.filter(
    (p) =>
      isTextPart(p) &&
      (p as TextPart).text?.trim() &&
      !(p as TextPart).synthetic &&
      !(p as any).ignored,
  ) as TextPart[];
  const rawVisibleText = visibleTextParts.map((p) => p.text).join('\n');
  const rawText = stripSystemPtyText(rawVisibleText);
  const { cleanText: textAfterReply, replyContext } = useMemo(
    () => parseReplyContext(rawText),
    [rawText],
  );
  const { cleanText: textAfterFiles, files: uploadedFiles } = useMemo(
    () => parseFileReferences(textAfterReply),
    [textAfterReply],
  );
  const { cleanText: textAfterProjects } = useMemo(
    () => parseProjectReferences(textAfterFiles),
    [textAfterFiles],
  );
  const { cleanText: textAfterFileMentions, files: fileMentionRefs } = useMemo(
    () => parseFileMentionReferences(textAfterProjects),
    [textAfterProjects],
  );
  const { cleanText: textAfterAgentMentions, agents: agentMentionRefs } = useMemo(
    () => parseAgentMentionReferences(textAfterFileMentions),
    [textAfterFileMentions],
  );
  const { cleanText: textAfterSessions, sessions: sessionRefs } = useMemo(
    () => parseSessionReferences(textAfterAgentMentions),
    [textAfterAgentMentions],
  );
  // System notification XML — parsed LAST so all other XML subsystems
  // (file refs, session refs, reply context, etc.) consume their tags first.
  // Whatever XML blocks remain are system notifications.
  const { cleanText: text, notifications: systemNotifications } = useMemo(
    () => parseSystemNotifications(textAfterSessions),
    [textAfterSessions],
  );
  // Silence unused-variable warnings — these parsed refs are currently only
  // consumed as stripping side-effects.
  void fileMentionRefs;
  void agentMentionRefs;

  // Both attachment routes, drawn as one strip. `uploadedFiles` used to be
  // parsed and then discarded — see `normalizeAttachments`.
  const allAttachments = useMemo(
    () => normalizeAttachments(attachments, uploadedFiles),
    [attachments, uploadedFiles],
  );

  // The bubble ALWAYS hugs its text. It used to take the full column when the
  // turn "owned the plan" (`ownsPlan && useHasPlan`) — a claim from when the
  // todo checklist rendered inside the bubble. The plan card lives under the
  // turn now, and the anchor's fallback made a one-word message stretch across
  // the whole column whenever any earlier turn had written todos.

  // Resolve effective command info: use runtime-tracked info or fall back to template matching
  const effectiveCommandInfo = useMemo(
    () => commandInfo ?? detectCommandFromText(rawText, commands),
    [commandInfo, rawText, commands],
  );

  /**
   * What the bubble actually says.
   *
   * For a command message that is the command's ARGUMENTS, not `text` — a
   * command's `text` is the fully expanded template the runtime sent (often
   * the whole `.md` file), which is exactly why `detectCommandFromText`
   * extracts args in the first place. The command itself is drawn as a chip
   * ahead of this, matching the composer, where the chip contributes no text
   * of its own and the rest of the line IS the args (`editor/serialize.ts`).
   *
   * Declared here, above the overflow-measuring effect that lists it as a
   * dependency — a `const` read from a dependency array before its own
   * initializer runs is a TDZ throw, not a stale value.
   */
  const commandSplit = commandInfo?.split;
  const bodyText = effectiveCommandInfo
    ? commandSplit
      ? commandSplit.after
      : (effectiveCommandInfo.args ?? '')
    : text;

  const copyText = useMemo(() => {
    const lines: string[] = [];
    for (const p of message.parts) {
      if (!isTextPart(p) || (p as TextPart).synthetic || (p as any).ignored) continue;
      const stripped = stripSystemPtyText((p as TextPart).text);
      if (stripped.trim()) lines.push(stripped);
    }
    return lines.join('\n').trim();
  }, [message.parts]);

  const rewindPromptText = useMemo(() => {
    if (effectiveCommandInfo) {
      return `/${effectiveCommandInfo.name}${effectiveCommandInfo.args ? ` ${effectiveCommandInfo.args}` : ''}`;
    }
    const withoutReply = parseReplyContext(copyText).cleanText;
    const withoutUploads = parseFileReferences(withoutReply).cleanText;
    const withoutProjects = parseProjectReferences(withoutUploads).cleanText;
    const withoutFiles = parseFileMentionReferences(withoutProjects).cleanText;
    const withoutAgents = parseAgentMentionReferences(withoutFiles).cleanText;
    const withoutSessions = parseSessionReferences(withoutAgents).cleanText;
    return stripKortixSystemTags(withoutSessions).trim();
  }, [copyText, effectiveCommandInfo]);

  // Detect channel message (Telegram/Slack) in user message
  const channelMessageInfo = useMemo(() => {
    if (!rawText) return undefined;
    const headerMatch = rawText.match(/^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/);
    if (!headerMatch) return undefined;
    const platform = headerMatch[1] as 'Telegram' | 'Slack';
    const context = headerMatch[2].trim();
    const userName = headerMatch[3].trim();
    const afterHeader = rawText.slice(headerMatch[0].length);
    const instrStart = afterHeader.search(
      /\n\s*(Chat ID:|── Telegram instructions|── Slack instructions)/,
    );
    const messageText =
      instrStart >= 0 ? afterHeader.slice(0, instrStart).trim() : afterHeader.trim();
    return { platform, context, userName, messageText };
  }, [rawText]);

  // Detect trigger_event in user message
  const triggerEventInfo = useMemo(() => {
    if (!rawText) return undefined;
    const match = rawText.match(/<trigger_event>\s*([\s\S]*?)\s*<\/trigger_event>/);
    if (!match) return undefined;
    try {
      const data = JSON.parse(match[1]);
      const promptText = rawText.replace(/<trigger_event>[\s\S]*?<\/trigger_event>/, '').trim();
      return { data, prompt: promptText };
    } catch {
      return undefined;
    }
  }, [rawText]);

  // Extract DCP notifications from ignored text parts (DCP plugin sends ignored user messages)
  const ignoredTextParts = stickyParts.filter(
    (p) => isTextPart(p) && (p as any).ignored && (p as TextPart).text?.trim(),
  );
  const ignoredRawText = ignoredTextParts.map((p) => (p as TextPart).text).join('\n');
  const dcpNotifications = useMemo(() => {
    if (!ignoredRawText) return [];
    return parseDCPNotifications(ignoredRawText).notifications;
  }, [ignoredRawText]);

  // Check if any text part was edited
  const isEdited = visibleTextParts.some((p) => (p as any).metadata?.edited);

  // Built once and rendered by every branch below — channel card, trigger card,
  // command card, bubble — so all four carry the same meta line.
  //
  // `copyText` is gated on `onRewind` to keep the buttons exactly as they were:
  // a read-only turn shows no controls. The row itself still renders, because
  // the timestamp is meta, not a control, and should not vanish with them.
  const actions = (
    <UserMessageActions
      timestamp={messageCreatedAt(message)}
      edited={isEdited}
      copyText={copyText && onRewind ? copyText : undefined}
      messageId={message.info.id}
      rewindPromptText={rewindPromptText}
      onRewind={onRewind}
      rewindDisabled={rewindDisabled}
      leading={leadingActions}
      alwaysVisible={actionsAlwaysVisible}
    />
  );

  // Inline file references
  const inlineFiles = stickyParts.filter(isFilePart) as FilePart[];
  const filesWithSource = inlineFiles.filter(
    (f) => f.source?.text?.start !== undefined && f.source?.text?.end !== undefined,
  );

  // Agent mentions
  const agentParts = stickyParts.filter(isAgentPart) as AgentPart[];

  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  // Use ResizeObserver + rAF to reliably detect overflow after layout settles
  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;

    const measure = () => {
      setCanExpand(el.scrollHeight > el.clientHeight + 2);
    };

    // Measure after next frame to ensure layout is computed
    const rafId = requestAnimationFrame(measure);

    // Also observe resize changes (font loads, container resize, etc.)
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [bodyText, expanded]);

  const handleCopy = async () => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /**
   * Server-located mention spans. Deliberately dropped for a command message:
   * these offsets index the full template text, and `bodyText` is a slice of
   * it, so they would point at the wrong characters. The regex fill in
   * `buildMentionSegments` covers the args either way.
   */
  const sourceRefs = useMemo<MentionSourceRef[]>(() => {
    if (effectiveCommandInfo) return [];
    return [
      ...filesWithSource.map((f) => ({
        start: f.source!.text!.start,
        end: f.source!.text!.end,
        type: 'file' as const,
      })),
      ...agentParts
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({
          start: a.source!.start,
          end: a.source!.end,
          type: 'agent' as const,
        })),
    ];
  }, [effectiveCommandInfo, filesWithSource, agentParts]);

  const sessionTitles = useMemo(() => sessionRefs.map((s) => s.title), [sessionRefs]);

  // Build highlighted text segments — see `../mention-segments.ts`. The walk
  // used to live inline here and in `optimistic-turn.tsx`, and the two copies
  // had already diverged.
  const segments = useMemo(() => {
    const segs = buildMentionSegments({
      text: bodyText,
      sourceRefs,
      sessionTitles,
      agentNames,
    });
    // A segment's identity is its character offset in the text — stable across
    // renders, unlike the array index the keys used before.
    const keyed = [];
    let offset = 0;
    for (const seg of segs) {
      keyed.push({ ...seg, key: `${offset}-${seg.type ?? 'text'}` });
      offset += seg.text.length;
    }
    return keyed;
  }, [bodyText, sourceRefs, sessionTitles, agentNames]);

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
    const ref = sessionRefs.find((s) => s.title === raw);
    if (!ref) return;
    openTabAndNavigate({
      id: ref.id,
      title: ref.title || 'Session',
      type: 'session',
      href: `/sessions/${ref.id}`,
    });
  };

  // If the message is purely notifications (no real user content), render only the cards
  const hasUserContent = !!(
    text ||
    effectiveCommandInfo ||
    replyContext ||
    uploadedFiles.length > 0 ||
    sessionRefs.length > 0 ||
    systemNotifications.length > 0 ||
    attachments.length > 0
  );

  if (!hasUserContent && (dcpNotifications.length > 0 || systemNotifications.length > 0)) {
    return (
      <div className="flex w-full flex-col gap-1.5">
        {withContentKeys(systemNotifications, (n) => n.tag).map(({ key, item }) => (
          <SystemNotificationCard key={key} notification={item} />
        ))}
        {withContentKeys(dcpNotifications, (n) => `${n.type}:${n.tokensSaved}`).map(
          ({ key, item }) => (
            <DCPNotificationCard key={key} notification={item} />
          ),
        )}
      </div>
    );
  }

  // Channel messages (Telegram/Slack): render as a branded card with user name
  if (channelMessageInfo) {
    const isTelegram = channelMessageInfo.platform === 'Telegram';
    const brandColor = isTelegram ? CHANNEL_BRAND_COLOR.Telegram : CHANNEL_BRAND_COLOR.Slack;
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="border-border/60 bg-muted/40 inline-flex max-w-[85%] flex-col gap-1.5 rounded-lg border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <svg className="size-3.5 shrink-0" viewBox="0 0 24 24" fill={brandColor}>
              {isTelegram ? (
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z" />
              ) : (
                <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
              )}
            </svg>
            <span className="text-xs font-medium" style={{ color: brandColor }}>
              {channelMessageInfo.platform}
            </span>
            <span className="text-muted-foreground text-xs">·</span>
            <span className="text-foreground text-sm font-medium">
              {channelMessageInfo.userName}
            </span>
          </div>
          {channelMessageInfo.messageText && (
            <div className="text-foreground text-sm wrap-break-word">
              {channelMessageInfo.messageText}
            </div>
          )}
        </div>
        {actions}
      </div>
    );
  }

  // Trigger event messages: render as a right-aligned card
  if (triggerEventInfo) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="border-border/60 bg-muted/40 inline-flex flex-col gap-1.5 rounded-lg border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Timer className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-foreground font-mono text-sm">
              {triggerEventInfo.data?.trigger || 'Scheduled Task'}
            </span>
            {triggerEventInfo.data?.data?.manual && (
              <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-xs font-medium">
                Manual
              </span>
            )}
          </div>
          {triggerEventInfo.prompt && (
            <div
              className="text-muted-foreground max-w-[400px] pl-5.5 text-xs wrap-break-word"
              style={{ paddingLeft: '1.375rem' }}
            >
              {triggerEventInfo.prompt}
            </div>
          )}
        </div>
        {actions}
      </div>
    );
  }

  // A `/command` message used to return early here as a bordered card with a
  // terminal icon and its args in muted 12px underneath. That card was the
  // whole complaint: the composer draws the command as an inline chip leading
  // the sentence (`composer/editor/mention-node.ts`), and sending the message
  // swapped it for different chrome, a different type scale, and — because the
  // branch returned before the main path — silently dropped the message's
  // attachments. A command is now just a message whose first token is a chip,
  // so it falls through to the one bubble below.

  return (
    // The whole message is ONE right-aligned column capped at 80%, so the
    // bubble, its attachments and its actions all hang off the same rail and
    // wrap against the same edge. The old root was a full-width stretching
    // column, which is why attachments spanned the transcript on the far left
    // while the bubble sat right.
    // A plan is the one thing that overrides the cap: a checklist reads as a
    // panel, not as something trailing off the end of a sentence.
    <div
      className={cn(
        'ml-auto flex w-full flex-col items-end gap-2 self-end',
        // showPlan ? 'max-w-full' : 'max-w-[80%]',
        'max-w-[80%]',
      )}
    >
      {allAttachments.length > 0 && <MessageAttachments attachments={allAttachments} />}

      {/* DCP notifications from ignored parts (rendered below user bubble if mixed) */}
      {dcpNotifications.length > 0 && (
        <div className="mt-1 flex w-full flex-col gap-1.5">
          {withContentKeys(dcpNotifications, (n) => `${n.type}:${n.tokensSaved}`).map(
            ({ key, item }) => (
              <DCPNotificationCard key={key} notification={item} />
            ),
          )}
        </div>
      )}
      {systemNotifications.length > 0 && (
        <div className="mt-1 flex w-full flex-col gap-1.5">
          {withContentKeys(systemNotifications, (n) => `mixed-${n.tag}`).map(({ key, item }) => (
            <SystemNotificationCard key={key} notification={item} />
          ))}
        </div>
      )}

      {/* No text means no bubble. Attach a file and send with nothing typed and
          the bubble used to render anyway — a padded surface with nothing in
          it, hanging under the attachments. The attachments ARE the message. */}
      {(bodyText || replyContext || effectiveCommandInfo) && (
        <UserMessageBubble
          canExpand={canExpand}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          textId={`${message.info.id}-text`}
          textRef={textRef}
          replyContext={replyContext}
        >
          {(bodyText || effectiveCommandInfo) && (
            <>
              {/* The `/command` chip sits exactly where it was typed —
                  leading the line, between two words, or trailing — because
                  that is where the composer drew it. `split.before` is the
                  prose that preceded the chip; without it every command
                  message rebuilt as `/name` + args and a chip typed
                  mid-sentence silently jumped to the front. */}
              {effectiveCommandInfo && (
                <>
                  {commandSplit?.before ? <span>{commandSplit.before} </span> : null}
                  <MentionChip kind="command" label={effectiveCommandInfo.name} />
                  {bodyText ? ' ' : null}
                </>
              )}
              {segments.map((seg) =>
                seg.type === 'file' ? (
                  <MentionChip
                    key={seg.key}
                    kind="file"
                    label={seg.text.replace(/^@/, '')}
                    onClick={() => openFileInComputer(seg.text.replace(/^@/, ''))}
                  />
                ) : seg.type === 'session' ? (
                  <MentionChip
                    key={seg.key}
                    kind="session"
                    label={seg.text.replace(/^@/, '')}
                    onClick={() => openSessionMention(seg.text.replace(/^@/, ''))}
                  />
                ) : seg.type === 'agent' ? (
                  // Static: an agent is named, not navigable. Same surface,
                  // no press affordance it cannot honour.
                  <MentionChip key={seg.key} kind="agent" label={seg.text.replace(/^@/, '')} />
                ) : (
                  <span key={seg.key}>{seg.text}</span>
                ),
              )}
            </>
          )}
        </UserMessageBubble>
      )}
      {/* Sent-at, "edited", and the hover actions are ONE row, sitting directly
          under the bubble they describe — notification cards below are separate
          objects and must not come between a message and its own meta. */}
      {actions}
    </div>
  );
}
