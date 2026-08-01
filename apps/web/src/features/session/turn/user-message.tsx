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
  TerminalWindowIcon as Terminal,
  TimerIcon as Timer,
} from '@phosphor-icons/react';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import {
  PreviewImage,
  PreviewImageContent,
  PreviewImageTrigger,
} from '@/components/ui/preview-image';
import { detectCommandFromText } from '@/features/session/detect-command';
import { useSandboxImageSrc } from '@/features/session/sandbox-image';
import { cn } from '@/lib/utils';
import { getFileIcon, getFilename, getFileType } from '@/lib/utils/file-utils';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import {
  type AgentPart,
  type Command,
  type FilePart,
  type MessageWithParts,
  type TextPart,
  isAgentPart,
  isFilePart,
  isTextPart,
  splitUserParts,
} from '@/ui';
import { useIsMessageUploading } from '@kortix/sdk/react';
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

import { useHasPlan } from './plan-card';

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
              {notification.items.map((item, i) => (
                <div key={i} className="text-muted-foreground/80 flex items-center gap-2 text-xs">
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
              ))}
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
              <div className="text-muted-foreground/80 max-h-32 overflow-y-auto text-xs break-words whitespace-pre-wrap">
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
              <div className="text-muted-foreground/80 max-h-32 overflow-y-auto text-xs break-words whitespace-pre-wrap">
                {notification.summary}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const BUBBLE_TEXT = cn(
  'text-[0.9rem] leading-[22px] font-medium',
  'break-words whitespace-pre-wrap select-text',
);

const BUBBLE_SURFACE = cn(
  'bg-sidebar text-foreground flex max-w-full  flex-col px-3 py-2.5 select-none rounded-lg',
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

export function normalizeAttachments(
  parts: FilePart[],
  uploads: ReadonlyArray<{ path: string; mime: string; filename: string }>,
): NormalizedAttachment[] {
  return [
    ...parts.map((file) => ({
      key: file.id,
      filename: file.filename || 'File',
      mime: file.mime,
      src: file.url,
    })),
    ...uploads.map((file) => ({
      key: `upload:${file.path}`,
      filename: file.filename || getFilename(file.path),
      mime: file.mime,
      src: file.path,
      path: file.path,
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

/**
 * The press/hover feel every attachment shares — a file pill, an image row and
 * an image tile all answer the pointer the same way, so the block reads as one
 * set of controls rather than three.
 */
const ATTACHMENT_INTERACTIVE =
  'hover:bg-muted/50 cursor-pointer transition-colors active:scale-[0.97]';

/**
 * Every attachment is the same square tile — the picture if we have one, an
 * icon with the name in the bottom corner otherwise. One shape is the whole
 * idea: there is no rows-vs-tiles mode to pick, nothing reflows when a file
 * joins a message, and a filename's length can never set a tile's width.
 */
const TILE_SURFACE =
  'border-border bg-background relative block size-20 shrink-0 overflow-hidden rounded-md border';

/** True when we can actually paint this attachment rather than name it. */
const isImageAttachment = (file: NormalizedAttachment) =>
  Boolean(file.mime?.startsWith('image/') && file.src);

/**
 * A named attachment: icon top-left, filename along the bottom.
 *
 * Two lines, bottom-aligned, because the name is the only thing distinguishing
 * one document from another — `AdmitCard-260411128971.pdf` truncated to a single
 * line is indistinguishable from its siblings.
 */
function FileTileBody({ file, pending }: { file: NormalizedAttachment; pending?: boolean }) {
  const Icon = getFileIcon(getFileType(file.filename));
  return (
    <span className="flex size-full flex-col justify-between gap-1 p-2">
      {pending ? (
        <Loading className="text-muted-foreground size-4 shrink-0" variant="spokes" />
      ) : (
        <Icon className="text-muted-foreground size-4 shrink-0" />
      )}
      <span className="text-foreground line-clamp-2 text-left text-xs leading-tight break-all">
        {file.filename}
      </span>
    </span>
  );
}

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
        <FileTileBody file={file} pending={pending || isLoading || file.pending} />
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
function MessageAttachments({
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
                  ATTACHMENT_INTERACTIVE,
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
                className={cn(TILE_SURFACE, ATTACHMENT_INTERACTIVE)}
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
              className={cn(
                'border-border bg-background relative block h-20 max-w-40 min-w-24 shrink-0 overflow-hidden rounded-md border',
                canOpen && ATTACHMENT_INTERACTIVE,
              )}
            >
              <FileTileBody file={file} pending={pending || file.pending} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ============================================================================
// User message actions — edit (rewind) + copy
// ============================================================================

function UserMessageActions({
  copyText,
  messageId,
  rewindPromptText,
  onRewind,
  rewindDisabled,
}: {
  copyText: string;
  messageId: string;
  rewindPromptText: string;
  onRewind: (messageId: string, text: string) => void;
  rewindDisabled: boolean;
}) {
  if (rewindDisabled) return null;
  return (
    <div className="mt-1 flex justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
      <Hint label="Edit from here" side="bottom" align="center">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Edit message and rewind session"
          disabled={rewindDisabled}
          onClick={() => onRewind(messageId, rewindPromptText)}
        >
          <PencilSimpleIcon weight="regular" className="text-foreground size-4" />
        </Button>
      </Hint>
      <CopyButton code={copyText} size="sm" />
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
}: {
  message: MessageWithParts;
  agentNames?: string[];
  commandInfo?: { name: string; args?: string };
  commands?: Command[];
  sessionId: string;
  ownsPlan: boolean;
  onRewind?: (messageId: string, text: string) => void;
  rewindDisabled?: boolean;
}) {
  const openFileInComputer = useKortixComputerStore((s) => s.openFileInComputer);
  const { attachments, stickyParts } = useMemo(
    () => splitUserParts(message.parts),
    [message.parts],
  );

  // Extract text from sticky parts, parse out <file> and <session_ref> XML references
  // Filter out both synthetic AND ignored parts from user-visible text
  const visibleTextParts = stickyParts
    .filter(isTextPart)
    .filter(
      (p) => (p as TextPart).text?.trim() && !(p as TextPart).synthetic && !(p as any).ignored,
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

  // Full width is the PLAN's claim on the message, so it has to follow a plan
  // that actually renders. `ownsPlan` alone doesn't: the anchor falls back to
  // the last turn when nothing ever wrote todos, which stretched the bubble in
  // sessions that have no plan at all.
  // Still uploading? The store is the only thing that knows. Without this the
  // tile cannot tell "these bytes are on their way" from "this image is broken"
  // — both render as icon + filename, which is what made a live upload look
  // like a failure.
  const isUploading = useIsMessageUploading(message.info.id);

  const hasPlan = useHasPlan(sessionId);
  const showPlan = ownsPlan && hasPlan;

  // Resolve effective command info: use runtime-tracked info or fall back to template matching
  const effectiveCommandInfo = useMemo(
    () => commandInfo ?? detectCommandFromText(rawText, commands),
    [commandInfo, rawText, commands],
  );

  const copyText = useMemo(() => {
    const textParts = message.parts.filter(
      (p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored,
    ) as TextPart[];
    return textParts
      .map((p) => stripSystemPtyText(p.text))
      .filter((t) => t.trim())
      .join('\n')
      .trim();
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

  const actions =
    copyText && onRewind ? (
      <UserMessageActions
        copyText={copyText}
        messageId={message.info.id}
        rewindPromptText={rewindPromptText}
        onRewind={onRewind}
        rewindDisabled={rewindDisabled}
      />
    ) : null;

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
  const ignoredTextParts = stickyParts
    .filter(isTextPart)
    .filter((p) => (p as any).ignored && (p as TextPart).text?.trim());
  const ignoredRawText = ignoredTextParts.map((p) => (p as TextPart).text).join('\n');
  const dcpNotifications = useMemo(() => {
    if (!ignoredRawText) return [];
    return parseDCPNotifications(ignoredRawText).notifications;
  }, [ignoredRawText]);

  // Check if any text part was edited
  const isEdited = visibleTextParts.some((p) => (p as any).metadata?.edited);

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
  }, [text, expanded]);

  const handleCopy = async () => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Build highlighted text segments
  const segments = useMemo(() => {
    if (!text) return [];
    type SegType = 'file' | 'agent' | 'session';

    // Detect session @mentions first (titles can contain spaces, so indexOf is used)
    const sessionDetected: { start: number; end: number; type: SegType }[] = [];
    for (const s of sessionRefs) {
      const needle = `@${s.title}`;
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        sessionDetected.push({
          start: idx,
          end: idx + needle.length,
          type: 'session',
        });
      }
    }

    // Collect server-provided source refs (file/agent), filtering out any that
    // overlap with a session mention (the server sees @Title as a file mention
    // for the first word only — the session range is more accurate).
    const serverRefs = [
      ...filesWithSource.map((f) => ({
        start: f.source!.text!.start,
        end: f.source!.text!.end,
        type: 'file' as SegType,
      })),
      ...agentParts
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({
          start: a.source!.start,
          end: a.source!.end,
          type: 'agent' as SegType,
        })),
    ].filter((r) => !sessionDetected.some((s) => r.start >= s.start && r.start < s.end));

    // Merge session + server refs
    const allRefs = [...sessionDetected, ...serverRefs];

    if (allRefs.length > 0) {
      allRefs.sort((a, b) => a.start - b.start || b.end - a.end);
      const result: { text: string; type?: SegType }[] = [];
      let lastIndex = 0;
      for (const ref of allRefs) {
        if (ref.start < lastIndex) continue;
        if (ref.start > lastIndex) result.push({ text: text.slice(lastIndex, ref.start) });
        result.push({ text: text.slice(ref.start, ref.end), type: ref.type });
        lastIndex = ref.end;
      }
      if (lastIndex < text.length) result.push({ text: text.slice(lastIndex) });
      return result;
    }

    // Fallback: detect @mentions from text using regex
    const agentSet = new Set(agentNames || []);
    const mentionRegex = /@(\S+)/g;
    const detected: { start: number; end: number; type: SegType }[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
      const mStart = match.index;
      const token = match[1];
      // Treat @ses_<id> tokens as session mentions
      const type: SegType = token.startsWith('ses_')
        ? 'session'
        : agentSet.has(token)
          ? 'agent'
          : 'file';
      detected.push({
        start: mStart,
        end: match.index + match[0].length,
        type,
      });
    }

    if (detected.length === 0) return [{ text, type: undefined }];

    detected.sort((a, b) => a.start - b.start || b.end - a.end);
    const result: { text: string; type?: SegType }[] = [];
    let lastIndex = 0;
    for (const ref of detected) {
      if (ref.start < lastIndex) continue;
      if (ref.start > lastIndex) result.push({ text: text.slice(lastIndex, ref.start) });
      result.push({ text: text.slice(ref.start, ref.end), type: ref.type });
      lastIndex = ref.end;
    }
    if (lastIndex < text.length) result.push({ text: text.slice(lastIndex) });
    return result;
  }, [text, filesWithSource, agentParts, agentNames, sessionRefs]);

  // If the message is purely notifications (no real user content), render only the cards
  const hasUserContent = !!(
    text ||
    replyContext ||
    uploadedFiles.length > 0 ||
    sessionRefs.length > 0 ||
    systemNotifications.length > 0 ||
    attachments.length > 0
  );

  if (!hasUserContent && (dcpNotifications.length > 0 || systemNotifications.length > 0)) {
    return (
      <div className="flex w-full flex-col gap-1.5">
        {systemNotifications.map((n, i) => (
          <SystemNotificationCard key={`${n.tag}-${i}`} notification={n} />
        ))}
        {dcpNotifications.map((n, i) => (
          <DCPNotificationCard key={i} notification={n} />
        ))}
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
            <div className="text-foreground text-sm break-words">
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
              className="text-muted-foreground max-w-[400px] pl-5.5 text-xs break-words"
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

  // Command messages: render as a right-aligned card instead of the raw template text
  if (effectiveCommandInfo) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="border-border/60 bg-muted/40 inline-flex flex-col gap-1.5 rounded-lg border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Terminal className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-foreground font-mono text-sm">/{effectiveCommandInfo.name}</span>
          </div>
          {effectiveCommandInfo.args && (
            <div
              className="text-muted-foreground max-w-[400px] pl-5.5 text-xs break-words"
              style={{ paddingLeft: '1.375rem' }}
            >
              {effectiveCommandInfo.args}
            </div>
          )}
        </div>
        {/* DCP notifications from ignored parts */}
        {dcpNotifications.length > 0 && (
          <div className="mt-1 flex w-full flex-col gap-1.5">
            {dcpNotifications.map((n, i) => (
              <DCPNotificationCard key={i} notification={n} />
            ))}
          </div>
        )}
        {systemNotifications.length > 0 && (
          <div className="mt-1 flex w-full flex-col gap-1.5">
            {systemNotifications.map((n, i) => (
              <SystemNotificationCard key={`cmd-${n.tag}-${i}`} notification={n} />
            ))}
          </div>
        )}
        {actions}
      </div>
    );
  }

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
      {allAttachments.length > 0 && (
        <MessageAttachments attachments={allAttachments} pending={isUploading} />
      )}
      {/* No text means no bubble. Attach a file and send with nothing typed and
          the bubble used to render anyway — a padded surface with nothing in
          it, hanging under the attachments. The attachments ARE the message. */}
      {(text || replyContext) && (
        <div
          className={cn(
            BUBBLE_SURFACE,
            'relative overflow-hidden',
            showPlan ? 'w-full' : 'w-fit',
            canExpand && 'cursor-pointer transition-colors',
            // showPlan && 'shadow',
          )}
          role={canExpand ? 'button' : undefined}
          tabIndex={canExpand ? 0 : undefined}
          aria-expanded={canExpand ? expanded : undefined}
          onClick={() => canExpand && setExpanded(!expanded)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (!canExpand) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded(!expanded);
            }
          }}
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
              <p className="text-muted-foreground line-clamp-2 text-xs leading-5">{replyContext}</p>
            </blockquote>
          )}

          {/* Text content */}
          {text && (
            <div className="relative">
              <div
                ref={textRef}
                className={cn(
                  'max-w-full min-w-0',
                  BUBBLE_TEXT,
                  !expanded && 'max-h-[200px] overflow-hidden',
                )}
              >
                {segments.length > 0 ? (
                  segments.map((seg, i) => {
                    const mentionClass =
                      'font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground/70 cursor-pointer';
                    return seg.type === 'file' ? (
                      <button
                        key={i}
                        type="button"
                        className={cn(mentionClass, 'appearance-none bg-transparent p-0 text-left')}
                        onClick={(e) => {
                          e.stopPropagation();
                          openFileInComputer(seg.text.replace(/^@/, ''));
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
                          const ref = sessionRefs.find((s) => s.title === raw);
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
                        className={cn(seg.type === 'agent' && 'text-foreground font-medium')}
                      >
                        {seg.text}
                      </span>
                    );
                  })
                ) : (
                  <span>{text}</span>
                )}
              </div>

              {/* Gradient fade for collapsed long messages. Keyed to `muted`
                  so it dissolves into the bubble it sits on, not the old card. */}
              {canExpand && !expanded && (
                <div className="from-muted pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent" />
              )}

              {/* Expand/collapse indicator */}
              {canExpand && (
                <div className="bg-muted/80 text-muted-foreground absolute right-0 bottom-0 z-10 rounded-md p-1 backdrop-blur-sm">
                  <ChevronDown
                    className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {isEdited && <span className="text-muted-foreground/50 pr-1 text-xs">edited</span>}

      {/* DCP notifications from ignored parts (rendered below user bubble if mixed) */}
      {dcpNotifications.length > 0 && (
        <div className="mt-1 flex w-full flex-col gap-1.5">
          {dcpNotifications.map((n, i) => (
            <DCPNotificationCard key={i} notification={n} />
          ))}
        </div>
      )}
      {systemNotifications.length > 0 && (
        <div className="mt-1 flex w-full flex-col gap-1.5">
          {systemNotifications.map((n, i) => (
            <SystemNotificationCard key={`mixed-${n.tag}-${i}`} notification={n} />
          ))}
        </div>
      )}
      {actions}
    </div>
  );
}
