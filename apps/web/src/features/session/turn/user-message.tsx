'use client';

import { MessageSenderAbove } from '../participants/session-participants';
import { MessageAuthorLabel } from './message-author-label';
import { errorToast } from '@/components/ui/toast';
import {
  fetchSessionAttachment,
  isSessionAttachmentRef,
  type SessionMessageAuthor,
} from '@kortix/sdk';

/** Moved from session-chat.tsx (`UserMessageRow`) so the turn module owns the
 *  user-message card. Full-width card, no reference chips. */

import { useTranslations } from '@/i18n/use-translations';
import {
  expandPastedContent,
  sanitizePromptUploadFilename,
  serializePromptWithPastes,
  splitPastedContent,
  type PastedContent,
} from '@kortix/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  PencilSimpleIcon,
  AlarmIcon,
  LightningIcon,
} from '@phosphor-icons/react';

import { CopyButton } from '@/components/markdown/copy-button';
import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
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
  type Part,
  type TextPart,
} from '@/ui';
import {
  AttachmentRemoveButton,
  AttachmentTile,
  PASTE_PREVIEW_CHARS,
  TILE_INTERACTIVE,
  TILE_SURFACE,
  isPreviewableImage,
} from '../attachment-tile';
import { MentionChip } from '../mention-chip';
import {
  releaseSentAttachmentPreview,
  sentAttachmentPreview,
  type SentAttachment,
} from '../sent-attachment-previews';
import type { AttachedFile } from '../composer/types';
import { uploadedFileRefXml } from '../uploaded-file-refs';
import {
  buildMentionSegments,
  type MentionSegment,
  type MentionSourceRef,
} from '../mention-segments';
import { parseChannelMessage, slackConversationName, type ChannelMessageInfo } from './channel-message';
import { SourceCard, SourcePill } from './source-pill';
import { useChannelBindings } from '@/hooks/channels/use-channel-bindings';
import { useParams } from 'next/navigation';
import { CHANNEL_BRAND_COLOR, ChannelBrandMark, channelPlatformLabel } from './channel-brand';
import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseProjectReferences,
  parseReplyContexts,
  parseSessionReferences,
  parseSystemNotifications,
  parseReminderPrompt,
  type ReminderPromptInfo,
  parseTriggerEvent,
  type TriggerEventInfo,
  QUOTE_MARKER_RE,
  quoteMarker,
  splitAtQuoteMarkers,
  stripReplyContexts,
  stripSystemPtyText,
  SystemNotificationCard,
} from '../message-parsing';

import { useProjectSessionHref } from '@/lib/navigation/session-href';
import { messageCreatedAt } from './message-time';
import { MessageTimeLabel } from './message-time-label';
import { PlanCard, useHasPlan } from './plan-card';

// Channel brand colors + marks live in ./channel-brand.tsx, shared with the
// outgoing reply card the bash tool renders for `teams send` & co.

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
  'bg-sidebar dark:bg-muted text-foreground flex max-w-full flex-col px-3.5 py-2.5 select-none rounded-lg',
);

/**
 * Where a channel message came from, in the pill's hover card: the platform,
 * the channel or chat it was posted in, and who posted it. A Slack prompt
 * written before channel names were recorded carries a bare id (`C0DEV`); the
 * project's Slack bindings name it, read only while this card is open. A Teams
 * conversation id names nothing a person reads, so Teams shows no channel row.
 */
export function ChannelOrigin({ info, platform }: { info: ChannelMessageInfo; platform: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const projectId = useParams<{ id?: string }>()?.id ?? null;
  const bareSlackId = info.platform === 'Slack' && /^[CDG][A-Z0-9]+$/.test(info.context);
  const { data } = useChannelBindings(bareSlackId ? projectId : null);
  const binding = bareSlackId
    ? data?.bindings.find((b) => b.platform === 'slack' && b.channelId === info.context)
    : undefined;
  const channel = info.platform === 'Teams' ? '' : (binding && slackConversationName(binding)) || info.context;
  return (
    <SourceCard
      mark={<ChannelBrandMark platform={info.platform} className="size-3.5 shrink-0" />}
      title={platform}
      rows={[
        { label: tI18nComplete('textce4683e7013a'), value: channel },
        { label: tI18nComplete('text218197693424'), value: info.userName },
      ]}
    />
  );
}

/**
 * A message that arrived from a chat channel (Slack / Microsoft Teams /
 * Telegram): a source pill — mark, platform, sender — over the same bubble a
 * typed message gets. Every `@name` in the text (`@Kortix`, `@KortixDev`,
 * `@here`) is a `MentionChip`, the chip the composer draws, static because a
 * channel mention opens nothing here. Exported for `channel-message-card.test.tsx`.
 */
export function ChannelMessage({
  info,
  actions,
}: {
  info: ChannelMessageInfo;
  actions?: React.ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const platform = channelPlatformLabel(info.platform, tI18nComplete);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <SourcePill
        mark={<ChannelBrandMark platform={info.platform} className="size-3 shrink-0" />}
        source={platform}
        sourceColor={CHANNEL_BRAND_COLOR[info.platform]}
        sender={info.userName}
        card={<ChannelOrigin info={info} platform={platform} />}
      />
      {info.messageText && (
        <div className={cn(BUBBLE_SURFACE, 'max-w-[80%]')}>
          <div className={BUBBLE_TEXT}>
            {buildMentionSegments({ text: info.messageText }).map((segment, i) =>
              segment.type ? (
                <MentionChip key={i} kind="user" label={segment.text.slice(1)} />
              ) : (
                <span key={i}>{segment.text}</span>
              ),
            )}
          </div>
        </div>
      )}
      {actions}
    </div>
  );
}

/**
 * A prompt the platform wrote — a reminder fire or a trigger fire — drawn the
 * way a channel message is: a source pill over the plain bubble, so every
 * prompt a person did not type carries the same mark. One layout for both.
 */
function PlatformPromptMessage({
  pill,
  text,
  actions,
  ...data
}: {
  pill: React.ReactNode;
  text: string;
  actions?: React.ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <div className="flex flex-col items-end gap-1.5" {...data}>
      {pill}
      {text && (
        <div className={cn(BUBBLE_SURFACE, 'max-w-[80%]')}>
          <div className={BUBBLE_TEXT}>{text}</div>
        </div>
      )}
      {actions}
    </div>
  );
}

/**
 * A reminder fire (`[REMINDER reminder.<id> …]`). The pill says Reminder and
 * whether it repeats; its card carries the id and a link to the project's
 * reminders for this session.
 */
function ReminderMessage({ info, actions }: { info: ReminderPromptInfo; actions?: React.ReactNode }) {
  const t = useTranslations('reminders');
  const params = useParams<{ id?: string; sessionId?: string }>();
  const manageHref =
    params?.id && params.sessionId ? `/projects/${params.id}/reminders?session=${params.sessionId}` : null;
  return (
    <PlatformPromptMessage
      data-testid="reminder-turn"
      data-reminder-id={info.id}
      text={info.prompt}
      actions={actions}
      pill={
        <SourcePill
          mark={<AlarmIcon className="size-3 shrink-0" aria-hidden />}
          source={t('cardLabel')}
          sender={info.recurring ? t('cardRecurring') : t('cardOneTime')}
          card={
            <SourceCard
              mark={<AlarmIcon className="size-3.5 shrink-0" aria-hidden />}
              title={t('cardLabel')}
              footer={
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground truncate font-mono">{info.id}</span>
                  {manageHref && (
                    <HoverPrefetchLink
                      href={manageHref}
                      className="text-foreground shrink-0 font-medium underline-offset-2 hover:underline"
                    >
                      {t('cardManage')}
                    </HoverPrefetchLink>
                  )}
                </div>
              }
            />
          }
        />
      }
    />
  );
}

/** A trigger fire (`<trigger_event>{…}</trigger_event>`): the trigger's name in the pill, the prompt in the bubble. */
function TriggerMessage({ info, actions }: { info: TriggerEventInfo; actions?: React.ReactNode }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const name = info.data?.trigger || tI18nComplete.raw('text512618790549');
  const manual = Boolean(info.data?.data?.manual);
  const source = tI18nComplete.raw('text8b9c643731c9');
  return (
    <PlatformPromptMessage
      data-testid="trigger-turn"
      text={info.prompt}
      actions={actions}
      pill={
        <SourcePill
          mark={<LightningIcon className="size-3 shrink-0" aria-hidden />}
          source={source}
          sender={name}
          card={
            <SourceCard
              mark={<LightningIcon className="size-3.5 shrink-0" aria-hidden />}
              title={source}
              footer={
                <div className="flex items-center justify-between gap-3">
                  <span className="text-foreground truncate font-mono">{name}</span>
                  {manual && (
                    <span className="text-muted-foreground shrink-0">{tI18nComplete.raw('textb0b9fe24ffa9')}</span>
                  )}
                </div>
              }
            />
          }
        />
      }
    />
  );
}

export interface NormalizedAttachment {
  key: string;
  /** The attachment identity of a file this tab sent — see `sent-attachment-previews.ts`. */
  id?: string;
  filename: string;
  mime?: string;
  src?: string;
  path?: string;
  /** A `<pasted_content>` block: drawn as a text tile that opens its full text. */
  pasted?: PastedContent;
}

/** The tile of one paste. Keyed by the paste id, so the optimistic and sent turns draw the same tile. */
export function pastedAttachment(paste: PastedContent): NormalizedAttachment {
  return { key: `pasted:${paste.id}`, filename: 'Pasted text', pasted: paste };
}

interface OrderedUploadReference {
  path: string;
  mime: string;
  filename: string;
  attachment?: string;
  sourcePartIndex: number;
}

interface ParsedAttachmentContent {
  rawText: string;
  textAfterFiles: string;
  /** Every `<reply_context>` quote across all text parts, in order. The
   *  quote markers left in `textAfterFiles` index into this array. */
  quotes: string[];
  uploads: OrderedUploadReference[];
  /** Every `<pasted_content>` block across all text parts, in order. */
  pastes: PastedContent[];
}

/**
 * Shift every quote marker in `text` by `offset`. Text parsed on its own has
 * markers counting from 0; appended after `offset` earlier quotes, its markers
 * must index the combined list.
 */
function offsetQuoteMarkers(text: string, offset: number): string {
  if (offset === 0) return text;
  return text.replace(new RegExp(QUOTE_MARKER_RE), (_marker, index: string) =>
    quoteMarker(offset + Number(index)),
  );
}

/**
 * Where the `/command` chip sits in a quoted command body — see
 * `quotedPieces` in `UserMessage`. A private-use character, like the quote
 * markers: never typed, not whitespace, untouched by every parser.
 */
const COMMAND_SLOT = '\uE002';

/**
 * Parse visible text parts once while retaining each upload reference's source
 * part. The source index lets the attachment normalizer merge references and
 * native file parts without changing their persisted order.
 */
function parseAttachmentContent(parts: readonly Part[]): ParsedAttachmentContent {
  const rawTextParts: string[] = [];
  const cleanTextParts: string[] = [];
  const uploads: OrderedUploadReference[] = [];
  const quotes: string[] = [];
  const pastes: PastedContent[] = [];

  parts.forEach((part, sourcePartIndex) => {
    if (
      !isTextPart(part) ||
      !(part as TextPart).text?.trim() ||
      (part as TextPart).synthetic ||
      (part as TextPart & { ignored?: boolean }).ignored
    ) {
      return;
    }

    // Pastes come out FIRST: a paste is the user's text, so a `<file>` or
    // `<reply_context>` inside one is paste content, not a ref.
    const pasted = splitPastedContent(stripSystemPtyText((part as TextPart).text));
    const rawPartText = pasted.text;
    pastes.push(...pasted.pastes);
    rawTextParts.push(rawPartText);

    // Each part is parsed on its own, so its markers count from 0. Shift them
    // by the quotes already collected, or part 2's first marker would name
    // part 1's first quote.
    const parsedReply = parseReplyContexts(rawPartText);
    const partText = offsetQuoteMarkers(parsedReply.cleanText, quotes.length);
    quotes.push(...parsedReply.quotes);

    const parsedFiles = parseFileReferences(partText);
    cleanTextParts.push(parsedFiles.cleanText);
    uploads.push(
      ...parsedFiles.files.map((file) => ({
        ...file,
        sourcePartIndex,
      })),
    );
  });

  return {
    rawText: rawTextParts.join('\n'),
    textAfterFiles: cleanTextParts.join('\n'),
    quotes,
    uploads,
    pastes,
  };
}

/**
 * The attachment strip's input, merged in original message-part order.
 *
 * A sent ref is keyed by its attachment identity. Any other upload is keyed by
 * POSITION first, then its path: three screenshots pasted in one message are
 * all named `image.png`, and path-only keys made React collapse them.
 *
 * A user attachment is never pending. A ref with no path is a file the runtime
 * does not hold yet; it draws its sent picture or its name, never a spinner.
 */
export function normalizeAttachments(
  parts: readonly Part[],
  uploads: ReadonlyArray<{
    path: string;
    mime: string;
    filename: string;
    attachment?: string;
    sourcePartIndex?: number;
  }>,
): NormalizedAttachment[] {
  const normalized: NormalizedAttachment[] = [];
  const uploadsByPart = new Map<number, Array<{ file: (typeof uploads)[number]; index: number }>>();
  const unpositionedUploads: Array<{ file: (typeof uploads)[number]; index: number }> = [];

  uploads.forEach((file, index) => {
    if (file.sourcePartIndex === undefined) {
      unpositionedUploads.push({ file, index });
      return;
    }
    const references = uploadsByPart.get(file.sourcePartIndex) ?? [];
    references.push({ file, index });
    uploadsByPart.set(file.sourcePartIndex, references);
  });

  const addUpload = (file: (typeof uploads)[number], index: number) => {
    normalized.push({
      key: file.attachment ? `attachment:${file.attachment}` : `upload:${index}:${file.path}`,
      ...(file.attachment && !isSessionAttachmentRef(file.attachment) ? { id: file.attachment } : {}),
      filename: file.filename || getFilename(file.path),
      mime: file.mime,
      src: isSessionAttachmentRef(file.attachment) ? file.attachment : file.path || undefined,
      path: file.path || undefined,
    });
  };

  parts.forEach((part, sourcePartIndex) => {
    if (isFilePart(part)) {
      const file = part as FilePart;
      normalized.push({
        key: file.id,
        filename: file.filename || 'File',
        mime: file.mime,
        src: file.url,
      });
    }
    for (const { file, index } of uploadsByPart.get(sourcePartIndex) ?? []) {
      addUpload(file, index);
    }
  });

  for (const { file, index } of unpositionedUploads) addUpload(file, index);
  return normalized;
}

/**
 * The strip of a message this tab sent: its submitted list in send order, each
 * entry keyed by its attachment identity.
 *
 * An entry draws the delivered tile that matches it (same identity, else the
 * next unclaimed tile with the same filename), or its own tile until that part
 * renders. The runtime streams the text part before the file parts, so the
 * strip never shrinks and no tile remounts. Unclaimed delivered tiles follow.
 * A reload has no submitted list and draws what arrived.
 */
export function mergeSentAttachments(
  arrived: NormalizedAttachment[],
  sent: ReadonlyArray<SentAttachment> | undefined,
): NormalizedAttachment[] {
  if (!sent?.length) return arrived;
  const unclaimed = [...arrived];
  const claim = (entry: SentAttachment) => {
    let index = entry.id ? unclaimed.findIndex((tile) => tile.id === entry.id) : -1;
    if (index < 0) {
      // The API stores a sanitized name for an attachment and a trimmed name for an inline part.
      const names = new Set([
        entry.filename,
        entry.filename.trim(),
        sanitizePromptUploadFilename(entry.filename),
      ]);
      index = unclaimed.findIndex((tile) => !tile.id && names.has(tile.filename));
    }
    return index < 0 ? undefined : unclaimed.splice(index, 1)[0];
  };
  const drawn = sent.map((entry, index): NormalizedAttachment => {
    const tile = claim(entry);
    const identity = entry.id
      ? { key: `attachment:${entry.id}`, id: entry.id }
      : { key: `sent:${index}:${entry.filename}` };
    return tile
      ? { ...tile, ...identity }
      : { ...identity, filename: entry.filename, mime: entry.mime };
  });
  return [...drawn, ...unclaimed];
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

/** A picture tile: a previewable image with a delivered source or a sent identity. */
const isImageAttachment = (file: NormalizedAttachment) =>
  isPreviewableImage(file.filename, file.mime) && Boolean(file.src || file.id);

// `AttachmentTile` (name top-left, extension badge bottom-left, or the picture
// itself) lives in `../attachment-tile` — shared with the composer's preview so
// the two can never drift apart. See that module for why.

/**
 * An image attachment: a square tile that opens full-size on click.
 *
 * Source order: the picture the composer showed (a file this tab sent, from
 * the first frame), then the delivered source. The delivered source loads
 * offscreen, and the tile swaps to it only after `img.decode()` resolves, so it
 * never passes through a spinner or a name tile. With neither (a reload, bytes
 * still loading) the tile is the named tile and swaps once when they decode.
 *
 * Resolving the src here (rather than handing the path to `SandboxImage`) gives
 * the lightbox the URL the tile shows, at any tile size.
 */
function AttachmentImage({ file, className }: { file: NormalizedAttachment; className?: string }) {
  // Read at mount: the cache revokes this URL once the delivered source decodes.
  const [sentPreview] = useState(() => sentAttachmentPreview(file.id));
  const { resolvedSrc } = useSandboxImageSrc(file.src ?? '');
  // With no sent picture on screen, bytes the browser already holds show on the first frame. A
  // sent picture stays until the delivered source decodes. HEIC may not decode here, so it waits.
  const decodedSrc = useDecodedImageSrc(resolvedSrc, !sentPreview && !isHeicImage(file));
  const shownSrc = decodedSrc ?? sentPreview;

  useEffect(() => {
    if (decodedSrc && file.id) releaseSentAttachmentPreview(file.id);
  }, [decodedSrc, file.id]);

  if (!shownSrc) {
    return <AttachmentTile filename={file.filename} mime={file.mime} className={className} />;
  }
  return (
    <PreviewImage>
      <PreviewImageTrigger asChild>
        {/* No `title` here: the inner tile carries it and fills this button, so
            the tooltip is the same, and one tile answers `[title=…]` once. */}
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(TILE_SURFACE, TILE_INTERACTIVE, className)}
        >
          <AttachmentTile
            filename={file.filename}
            mime={file.mime}
            imageSrc={shownSrc}
            className="border-0 bg-transparent"
          />
        </button>
      </PreviewImageTrigger>
      <PreviewImageContent fileContent={shownSrc} fileName={file.filename} fullscreen />
    </PreviewImage>
  );
}

/** Bytes the browser already holds: an inline part or a local object URL. */
const IN_BROWSER_SOURCE = /^(data|blob):/i;

const isHeicImage = (file: NormalizedAttachment) =>
  /^image\/hei[cf]\b/i.test(file.mime ?? '') || /\.hei[cf]$/i.test(file.filename);

/**
 * `src` once it can show without a visible swap. With `showBytesNow`, a `data:` or `blob:`
 * source shows on the first frame. Any other source decodes offscreen first; until then the
 * last decoded source, or null.
 */
function useDecodedImageSrc(src: string | null, showBytesNow: boolean): string | null {
  const [decoded, setDecoded] = useState<string | null>(null);
  const now = showBytesNow && !!src && IN_BROWSER_SOURCE.test(src);
  useEffect(() => {
    if (!src || now) return;
    let cancelled = false;
    const image = new Image();
    image.src = src;
    image.decode().then(
      () => {
        if (!cancelled) setDecoded(src);
      },
      // Undecodable here (a HEIC echo, a broken file): keep what is on screen.
      () => { },
    );
    return () => {
      cancelled = true;
    };
  }, [src, now]);
  return now ? src : decoded;
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
/**
 * A failed send, the one attachment state the strip says out loud.
 *
 * Upload progress lives on the composer tile only. A sent message is a
 * finished object from its first frame, so the strip has no uploading state.
 */
export interface AttachmentUploadStatus {
  state: 'failed';
  /** Why it failed, shown verbatim. */
  message?: string;
  /** Sends the message again. Present when the host kept a failed send on screen. */
  onRetry?: () => void;
}

function StoredAttachmentFile({ file }: { file: NormalizedAttachment }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const stored = isSessionAttachmentRef(file.src);
      const url = stored ? URL.createObjectURL(await fetchSessionAttachment(file.src!)) : sentAttachmentPreview(file.id);
      if (!url) return;
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (stored) setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : tI18nComplete('text7f755292bf51'));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div aria-busy={downloading}>
      <AttachmentTile
        filename={file.filename}
        mime={file.mime}
        className={downloading ? 'cursor-wait' : undefined}
        onOpen={() => void download()}
      />
    </div>
  );
}

export function MessageAttachments({
  attachments,
  status,
  onOpenPastedContent,
}: {
  attachments: NormalizedAttachment[];
  /** A failed send — see {@link AttachmentUploadStatus}. */
  status?: AttachmentUploadStatus;
  /** Opens a paste's full text. Absent (no side panel), a paste tile is inert. */
  onOpenPastedContent?: (id: string, text: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tComposerAttachments = useTranslations('hardcodedUi.composerAttachments');
  const openFileInComputer = useKortixComputerStore((s) => s.openFileInComputer);
  const [expanded, setExpanded] = useState(false);

  const { visible, hidden } = planAttachmentGrid(attachments, expanded);

  // A sent message never shows upload chrome: no spinner, no progress, no
  // status text. A failed send is the one state a tile cannot show, so only it
  // gets a line: "Couldn't send", then the reason when one is known. A kept
  // send with no files (a text-only send delivered detached) gets the line too.
  const failed = status?.state === 'failed' ? status : null;
  if (visible.length === 0 && !failed) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {visible.length > 0 && (
        <ul className="flex max-w-md flex-wrap justify-end gap-2">
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
                    aria-label={tI18nComplete('textf9c98eec768a', {
                      value0: hidden,
                      value1: hidden === 1 ? '' : 's',
                    })}
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

            const { pasted } = file;
            if (pasted) {
              return (
                <li key={file.key} className="contents">
                  <AttachmentTile
                    filename={file.filename}
                    preview={pasted.text.slice(0, PASTE_PREVIEW_CHARS)}
                    onOpen={
                      onOpenPastedContent
                        ? () => onOpenPastedContent(pasted.id, pasted.text)
                        : undefined
                    }
                  />
                </li>
              );
            }

            if (isImageAttachment(file)) {
              return (
                <li key={file.key} className="contents">
                  <AttachmentImage file={file} />
                </li>
              );
            }

            if (isSessionAttachmentRef(file.src) || sentAttachmentPreview(file.id)) {
              return <li key={file.key} className="contents"><StoredAttachmentFile file={file} /></li>;
            }
            const canOpen = Boolean(file.path);
            return (
              <li key={file.key} className="contents">
                <AttachmentTile
                  filename={file.filename}
                  mime={file.mime}
                  onOpen={canOpen ? () => openFileInComputer(file.path!) : undefined}
                />
              </li>
            );
          })}
        </ul>
      )}
      {failed && (
        // Right-aligned under the strip, on the same rail as the tiles. Muted
        // text, not a status card: the WORDS carry the failure, so it needs no
        // colour the palette does not have.
        <p
          className="text-muted-foreground max-w-md text-right text-xs leading-tight"
          role="alert"
        >
          {tComposerAttachments('couldNotSend')}
          {failed.message && <span className="block">{failed.message}</span>}
        </p>
      )}
      {failed?.onRetry && (
        <Button type="button" variant="ghost" size="xs" onClick={failed.onRetry}>
          {tI18nComplete('text942087cc2d41')}
        </Button>
      )}
    </div>
  );
}

/**
 * A paste's full text, in the side panel's detail view. Its one action, Copy,
 * sits in the panel header (`PastedTextCopy`): the text is already in the
 * chat, so there is nothing to download or add.
 */
export function PastedTextBody({ text }: { text: string }) {
  return (
    <pre className="bg-popover text-foreground rounded-md border px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap select-text">
      {text}
    </pre>
  );
}

export function PastedTextCopy({ text }: { text: string }) {
  return <CopyButton code={text} size="sm" />;
}

/** Word and character counts for the panel header. */
export function pastedTextCounts(text: string) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { words, chars: text.length };
}

// ============================================================================
// Inline reply quotes
// ============================================================================

/**
 * Key each mention segment by its character offset in the text — stable
 * across renders, unlike an array index.
 */
function keyMentionSegments(segs: MentionSegment[]) {
  const keyed: Array<MentionSegment & { key: string }> = [];
  let offset = 0;
  for (const seg of segs) {
    keyed.push({ ...seg, key: `${offset}-${seg.type ?? 'text'}` });
    offset += seg.text.length;
  }
  return keyed;
}

/** One piece of a message body split at its quote markers. */
export type QuotedBodyPiece = ReturnType<typeof splitAtQuoteMarkers>[number];

/**
 * A message body with its `<reply_context>` quotes drawn where they were
 * written — quote, reply, quote, reply — instead of one quote pinned
 * above the text.
 *
 * Shared by the sent bubble and `OptimisticTurn`, so the optimistic → echo
 * swap draws the same markup and cannot jump. `renderText` draws one text run
 * (mention chips included); this component owns only the order, the quote
 * treatment and the spacing.
 *
 * A quote is a rule, not a card. A filled, bordered banner sitting on the
 * already-filled bubble made two nested surfaces, and the louder one was the
 * quote rather than the message the reader came for. `line-clamp-2` wraps to a
 * second line and ends cleanly, and the full text stays in the DOM to copy.
 *
 * `gap-2` is the old quote's `mb-2`, moved to the parent so every gap has one
 * owner: quote → reply, reply → quote and quote → quote are all the same step.
 * `BUBBLE_TEXT` sits on each text run, not on the column: a quote inside the
 * `font-medium whitespace-pre-wrap` run would inherit both.
 */
export function QuotedMessageBody({
  pieces,
  renderText,
}: {
  pieces: readonly QuotedBodyPiece[];
  renderText: (text: string) => React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {pieces.map((piece, position) => {
        if (piece.kind === 'quote') {
          return (
            <blockquote key={`quote-${piece.index}`} className="border-border border-l-2 pl-2.5">
              <p className="text-muted-foreground line-clamp-2 text-sm leading-5">{piece.text}</p>
            </blockquote>
          );
        }
        // Two text runs are never adjacent — a quote always separates them —
        // so "the run after quote N" is a unique, content-stable key.
        const previous = pieces[position - 1];
        const after = previous?.kind === 'quote' ? previous.index : 'start';
        return (
          <div key={`text-after-${after}`} className={BUBBLE_TEXT}>
            {renderText(piece.text)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The text the inline edit-from-here editor starts from. That editor is a
 * plain `<textarea>` (`UserMessageEditor`), not the composer, so it has no
 * quote list to hold a `<reply_context>` block — it would show raw XML.
 * Quotes are dropped; the reply text stays, in order.
 */
export function editablePromptText(
  copyText: string,
  command?: { name: string; args?: string } | null,
): string {
  if (command) {
    // A command's args carry its quotes and pastes too (the composer writes
    // them ahead of the args). The pastes stay as the editor's tiles.
    const args = command.args ? stripReplyContexts(splitPastedContent(command.args).text) : '';
    return `/${command.name}${args ? ` ${args}` : ''}`;
  }
  const withoutReply = stripReplyContexts(splitPastedContent(copyText).text);
  const withoutUploads = parseFileReferences(withoutReply).cleanText;
  const withoutProjects = parseProjectReferences(withoutUploads).cleanText;
  const withoutFiles = parseFileMentionReferences(withoutProjects).cleanText;
  const withoutAgents = parseAgentMentionReferences(withoutFiles).cleanText;
  const withoutSessions = parseSessionReferences(withoutAgents).cleanText;
  return stripKortixSystemTags(withoutSessions).trim();
}

/**
 * What an edited prompt sends again for the attachments the editor kept.
 *
 * A saved copy (`kortix-attachment://`) or a native file part rides as a URL
 * part; the API writes a saved copy into the sandbox again. An upload whose
 * saved copy is missing is still in the sandbox, so its `<file>` ref is resent
 * as text, joined under the trimmed `text` (refs alone when the text is blank).
 * A tile with neither source has nothing to resend. A kept paste is written
 * back as its `<pasted_content>` block, ahead of the text, as the composer does.
 */
export function editResendAttachments(
  kept: readonly NormalizedAttachment[],
  text: string,
): {
  files: AttachedFile[];
  text: string;
} {
  const files: AttachedFile[] = [];
  const refs: string[] = [];
  const pastes: PastedContent[] = [];
  for (const { src, path, filename, mime: kind, pasted } of kept) {
    if (pasted) {
      pastes.push(pasted);
      continue;
    }
    const mime = kind || 'application/octet-stream';
    if (src && (isSessionAttachmentRef(src) || !path)) {
      const isImage = isPreviewableImage(filename, mime);
      files.push({ kind: 'remote', url: src, filename, mime, isImage });
    } else if (path) {
      refs.push(uploadedFileRefXml({ path, mime, filename }));
    }
  }
  const joined = refs.join('\n');
  const body = text.trim();
  const withRefs = joined ? (body ? `${body}\n\n${joined}` : joined) : text;
  return { files, text: serializePromptWithPastes(withRefs, pastes) };
}

// ============================================================================
// The bubble
// ============================================================================

/**
 * The message bubble, including the clamp and its expand affordance.
 *
 * The expand control is the "Show more" button, not the bubble. The bubble used to carry
 * `role="button"` + `tabIndex={0}` whenever the text was clamped, and it
 * contains `MentionChip` buttons — a file or session chip that opens what it
 * names. Interactive content inside a `role="button"` is invalid for a reason
 * that bites in practice: assistive technology flattens a button's subtree into
 * its accessible name, so the chips stopped existing as controls, while still
 * being tab stops in the browser — a bubble that a keyboard user could enter,
 * tab through, and never operate.
 *
 * A real `<button>` carries a name (its visible "Show more" text), state
 * (`aria-expanded`) and a target (`aria-controls` → the clamped region). It is
 * the ONLY toggle. The bubble itself used to toggle on click, and selecting
 * text to copy from a long prompt opened or closed it at random: a drag that
 * ends inside the bubble is a click.
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
  quoted,
  tail = false,
  children,
}: {
  /** The sender's avatar sits above: the top-right corner, under it, is 4px. */
  tail?: boolean;
  /** The text overflows its clamp, so there is something to expand. */
  canExpand: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** A plan-owning turn takes the full column instead of hugging its text. */
  fullWidth?: boolean;
  /** Ties the toggle's `aria-controls` to the region it expands. */
  textId: string;
  textRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * `children` is a {@link QuotedMessageBody}: it styles its own text runs,
   * so the clamped region must not apply `BUBBLE_TEXT` over its quotes.
   */
  quoted?: boolean;
  children?: React.ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div
      className={cn(
        BUBBLE_SURFACE,
        'relative overflow-hidden',
        // 4px: `--radius` (10) minus 6, the corner under the sender's avatar.
        tail && 'rounded-tr-[calc(var(--radius)-6px)]',
        fullWidth ? 'w-full' : 'w-fit',
      )}
    >
      {/* Text content. Quoted context, when the message has any, is part of
          it — see `QuotedMessageBody`. */}
      {children && (
        <div className="relative">
          <div
            ref={textRef}
            id={textId}
            className={cn(
              'max-w-full min-w-0',
              !quoted && BUBBLE_TEXT,
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
        </div>
      )}
      {/* "Show more" / "Show less", under the text at the bottom left, where a
          reader's eye ends the clamped run. Text, not a corner chevron: the
          chevron read as decoration and sat on top of the last line. Visible
          text is its accessible name. `hit-area-x-2 hit-area-y-2` grows the
          target past the 16px line without moving it; the bubble padding
          holds the extension, so its `overflow-hidden` clips none of it.
          `print:hidden`: a printed page has nothing to expand. */}
      {children && canExpand && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground hit-area-x-2  hit-area-r-20 hit-area-y-2 focus-visible:ring-ring mt-1.5 self-start rounded-sm text-xs font-medium transition-colors duration-(--duration-normal) focus-visible:ring-2 focus-visible:outline-none print:hidden"
        >
          {expanded ? tI18nComplete.raw('text94ea9b1d33a0') : tI18nComplete.raw('textf5c9bd131486')}
        </button>
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
  deliveryStatus,
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
   * ALWAYS visible, at the row's right edge — a queued prompt's delivery
   * progress (`QueuedPromptProgress`) or its failure and recovery actions
   * (`QueuedPromptFailure`).
   */
  deliveryStatus?: React.ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Copy stays available while the agent is busy / rewind is locked.
  // Only edit-from-here is gated — hiding the whole bar was wrong.
  const canRewind = Boolean(onRewind && messageId && !rewindDisabled);
  const hasMeta = timestamp !== null || Boolean(edited);

  // Nothing to say and nothing to do — don't leave an empty row behind.
  if (!hasMeta && !copyText && !deliveryStatus) return null;

  return (
    // The fade sits on the ROW, so the timestamp and the buttons reveal
    // together as one object rather than a label with controls growing out of
    // it. `opacity`, never mounting: the row holds its height whether or not
    // the pointer is over the turn, so nothing in the transcript reflows.
    // The status word (when there is one) sits OUTSIDE the fade: it is the
    // one thing on this row a user must not have to hover to learn. It is the
    // LAST child, pinned to the right edge: the faded group still takes its
    // width, and the server stamp lands while a prompt is still `delivering`,
    // so a status to its left slid 56px for a frame before it vanished.
    <div className="flex w-full items-center justify-end gap-2">
      <div
        className={cn(
          'flex items-center gap-2 transition-opacity duration-normal',
          // `max-md:opacity-100` — the reveal is a DESKTOP affordance only.
          //
          // A touch screen has no hover, so under 768px this row would sit
          // at zero opacity for the whole session: the timestamp, Copy and
          // Edit-from-here all present, all invisible, all unreachable.
          // Worse than absent, because the row still holds its height.
          //
          // Touch browsers also emulate `:hover` on tap and leave it stuck
          // on the last-tapped element until you tap elsewhere — so the
          // pre-fix behavior was not "never shows", it was "one arbitrary
          // turn's actions stay lit while every other turn's stay hidden".
          //
          // Appended rather than folded into the desktop classes on
          // purpose: the only utility it truly conflicts with is the bare
          // `opacity-0`, and a variant always sorts after its bare
          // counterpart. The two `opacity-100` variants it sits beside
          // agree with it, so no ordering assumption is being made and the
          // desktop string is unchanged.
          'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100 max-md:opacity-100',
        )}
      >
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
              <Hint label={tI18nComplete.raw('textc72e5d059e24')} side="top" align="center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  // 24px visible, 40px target — grown with a pseudo-element so the
                  // dense action row keeps its rhythm.
                  className="hit-area-2"
                  aria-label={tI18nComplete.raw('text673d6a594efa')}
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
      {deliveryStatus}
    </div>
  );
}

// ============================================================================
// Inline edit-from-here editor
// ============================================================================

/**
 * The full-width editor that REPLACES the bubble while an edit-from-here is
 * being composed — the ChatGPT pattern. It replaced a `ConfirmDialog`: the
 * dialog made the user confirm an abstract "rewind" before they had typed
 * anything, when the real decision point is Send. Cancel restores the bubble
 * untouched; nothing has happened yet, so there is nothing to confirm.
 *
 * Send is the commit: the parent stages the session rewind and delivers the
 * edited text as the replacement prompt, which is what truncates every turn
 * below this message.
 *
 * The surface is `BUBBLE_SURFACE` stretched to the full column width, so the
 * bubble reads as "opening up" into its editable form rather than being
 * swapped for foreign chrome. `select-text` overrides the surface's
 * `select-none` — this is now an input, not a transcript artifact.
 */
export function UserMessageEditor({
  initialText,
  attachments = [],
  pending,
  onCancel,
  onSend,
}: {
  initialText: string;
  /** The message's attachments. The user keeps or removes each; Send carries the kept ones. */
  attachments?: NormalizedAttachment[];
  /** The staged rewind is on the wire — hold both buttons. */
  pending?: boolean;
  onCancel: () => void;
  onSend: (text: string, kept: NormalizedAttachment[]) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [draft, setDraft] = useState(initialText);
  const [kept, setKept] = useState(attachments);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  // Text is required, attachments or not: a text-less replacement prompt does
  // not commit the staged rewind, so the original turn would stay (KRTX-962).
  const canSend = Boolean(draft.trim()) && !pending;

  // Focus with the caret at the END on mount — autofocus alone puts it at the
  // start, and an edit almost always continues the sentence.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Grow with the content. `height = auto` first so the textarea can also
  // SHRINK when lines are deleted — scrollHeight never reports smaller than
  // the current box. The class caps it at 50vh and scrolls from there.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  return (
    <div className={cn(BUBBLE_SURFACE, 'w-full gap-2 py-3 select-text')}>
      {kept.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {kept.map((file) => (
            <li key={file.key} className="contents">
              <div className="group relative">
                {file.pasted ? (
                  <AttachmentTile
                    filename={file.filename}
                    preview={file.pasted.text.slice(0, PASTE_PREVIEW_CHARS)}
                  />
                ) : isImageAttachment(file) ? (
                  <AttachmentImage file={file} />
                ) : (
                  <AttachmentTile filename={file.filename} mime={file.mime} />
                )}
                {!pending && (
                  <AttachmentRemoveButton
                    filename={file.filename}
                    onRemove={() => setKept((all) => all.filter((f) => f.key !== file.key))}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={editorRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !pending) {
            e.preventDefault();
            onCancel();
            return;
          }
          // Same contract as the composer: Enter sends, Shift+Enter breaks the
          // line. The IME guard keeps a Japanese/Chinese conversion commit
          // from firing the send.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSend(draft, kept);
          }
        }}
        aria-label={tI18nComplete.raw('text9757ccd5ef12')}
        className={cn(
          BUBBLE_TEXT,
          'max-h-[50vh] w-full resize-none overflow-y-auto bg-transparent outline-none',
        )}
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={onCancel}>
          {tI18nComplete.raw('text19766ed6ccb2')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSend}
          onClick={() => canSend && onSend(draft, kept)}
        >
          {pending && <Loading variant="spokes" className="size-3.5 shrink-0" />}
          {tI18nComplete.raw('textf6f4688ff23d')}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// User Message
// ============================================================================

/** The message's own text parts, joined: what the edit-from-here editor starts from. */
function messagePromptText(parts: readonly Part[]): string {
  const lines: string[] = [];
  for (const p of parts) {
    if (!isTextPart(p) || (p as TextPart).synthetic || (p as TextPart & { ignored?: boolean }).ignored) continue;
    const stripped = stripSystemPtyText((p as TextPart).text);
    if (stripped.trim()) lines.push(stripped);
  }
  return lines.join('\n').trim();
}

/** What "Copy message" copies: the prompt with each paste as its text, not its XML. */
export function userMessageCopyText(parts: readonly Part[]): string {
  return expandPastedContent(messagePromptText(parts));
}

export function UserMessage({
  message,
  author,
  showAuthor,
  agentNames,
  commandInfo,
  commands,
  sessionId,
  ownsPlan,
  onRewind,
  rewindDisabled = false,
  editingText,
  editPending,
  onEditCancel,
  onEditSend,
  deliveryStatus,
  pendingAttachments,
  uploadStatus,
  pendingText,
  onOpenPastedContent,
}: {
  message: MessageWithParts;
  /** Who wrote this message, from the server's prompt record. */
  author?: SessionMessageAuthor;
  /** Draw the author's name above the bubble (group chat). */
  showAuthor?: boolean;
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
  /**
   * Non-null while THIS message is being edited from here: the bubble is
   * replaced by `UserMessageEditor` prefilled with this text. The value is the
   * cleaned prompt text the pencil captured (`rewindPromptText`), not the raw
   * message — same text the old flow prefilled into the composer.
   */
  editingText?: string | null;
  /** See `UserMessageEditor.pending`. */
  editPending?: boolean;
  onEditCancel?: () => void;
  /** Send the edit: stage the rewind at this message and deliver `text`. */
  onEditSend?: (messageId: string, text: string, kept: NormalizedAttachment[]) => void;
  /** See `UserMessageActions.deliveryStatus`. */
  deliveryStatus?: React.ReactNode;
  /**
   * The files this message's Send carried, in send order. The runtime streams
   * a message's parts text-first and the file parts seconds later; these keep
   * every tile on screen, keyed by identity, until its delivered part renders
   * (`mergeSentAttachments`).
   */
  pendingAttachments?: ReadonlyArray<SentAttachment>;
  /** A failed accepted send remains visible until retry. */
  uploadStatus?: AttachmentUploadStatus;
  /**
   * The prompt's text as the sender knew it, for the frames where this
   * message has no text part of its own — the store swaps the optimistic copy
   * for the runtime's echo and the parts stream back in over ~176 ms. Without
   * it the bubble blanked for that window (2026-09-06).
   */
  pendingText?: string;
  /** See `MessageAttachments.onOpenPastedContent`. */
  onOpenPastedContent?: (id: string, text: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const openFileInComputer = useKortixComputerStore((s) => s.openFileInComputer);
  const { stickyParts } = useMemo(() => splitUserParts(message.parts), [message.parts]);

  // Extract visible text and file references in original part order. This must
  // keep the source part index because a later native file cannot move ahead
  // of workspace references that appeared in earlier text parts.
  const {
    rawText,
    textAfterFiles,
    quotes,
    uploads: uploadedFiles,
    pastes: partPastes,
  } = useMemo(() => parseAttachmentContent(message.parts), [message.parts]);
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
  const fileAttachments = useMemo(
    () =>
      mergeSentAttachments(normalizeAttachments(message.parts, uploadedFiles), pendingAttachments),
    [message.parts, uploadedFiles, pendingAttachments],
  );

  /**
   * Whether THIS turn draws the plan.
   *
   * `ownsPlan` alone is not the answer: `planAnchorMessageId` falls back to the
   * last turn when no turn ever wrote todos, so a session with zero todos still
   * nominates an owner. (It is also already false on every turn while the Easy
   * panel is drawing the plan — see `chatPlanAnchorId`.) `useHasPlan` is the
   * second half — it asks the runtime
   * whether a plan exists at all, on the same query key the `todo.updated` SSE
   * event writes, so the card appears the moment the agent writes its first
   * todo and never appears for a session that has none.
   *
   * The bubble itself hugs its text either way; only the column cap moves.
   */
  // Called UNCONDITIONALLY. `ownsPlan && useHasPlan(...)` short-circuits, so
  // the hook would go uncalled whenever `ownsPlan` is false — and the anchor
  // moves between turns as the agent re-plans, so React would see the hook
  // count change on a live component. Read first, combine second.
  const hasPlan = useHasPlan(sessionId);
  const showPlan = ownsPlan && hasPlan;

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
  // The composer writes a command's pastes into its args and `split.before`
  // (`planDraftSubmission`), so both halves lose their blocks here.
  const commandSplit = commandInfo?.split;
  const commandBefore = useMemo(
    () => splitPastedContent(commandSplit?.before ?? ''),
    [commandSplit?.before],
  );
  const commandArgs = useMemo(
    () => splitPastedContent(effectiveCommandInfo?.args ?? ''),
    [effectiveCommandInfo?.args],
  );
  const bodyText = effectiveCommandInfo
    ? commandSplit
      ? commandSplit.after
      : commandArgs.text
    : // While this message has no text part of its own (the store is swapping
    // in the runtime's echo), the sender's copy keeps the bubble on screen.
    text || (pendingText ?? '');

  // Pastes lead the strip, as in the composer. A command carries each one up to
  // three times (template, args, `split.before`): one tile per paste id.
  const allAttachments = useMemo(() => {
    const seen = new Set<string>();
    const pastes = [...partPastes, ...commandBefore.pastes, ...commandArgs.pastes].filter((paste) => {
      if (seen.has(paste.id)) return false;
      seen.add(paste.id);
      return true;
    });
    return pastes.length > 0 ? [...pastes.map(pastedAttachment), ...fileAttachments] : fileAttachments;
  }, [partPastes, commandBefore.pastes, commandArgs.pastes, fileAttachments]);

  const promptText = useMemo(() => messagePromptText(message.parts), [message.parts]);
  const copyText = useMemo(() => expandPastedContent(promptText), [promptText]);

  const rewindPromptText = useMemo(() => {
    return editablePromptText(promptText, effectiveCommandInfo);
  }, [promptText, effectiveCommandInfo]);

  // Detect a channel message (Slack / Microsoft Teams / Telegram): the API
  // scaffolds these prompts with ids and turn instructions the person never
  // typed, so the card shows only the platform, the sender, and their words.
  const channelMessageInfo = useMemo(() => parseChannelMessage(rawText), [rawText]);

  // Detect trigger_event in user message
  const triggerEventInfo = useMemo(() => parseTriggerEvent(rawText), [rawText]);

  // A reminder fire: platform-written `[REMINDER …]` header + the reminder text.
  const reminderInfo = useMemo(() => parseReminderPrompt(rawText), [rawText]);

  // Check if any text part was edited
  const isEdited = message.parts.some(
    (part) =>
      isTextPart(part) &&
      (part as TextPart).text?.trim() &&
      !(part as TextPart).synthetic &&
      !(part as TextPart & { ignored?: boolean }).ignored &&
      Boolean((part as TextPart & { metadata?: { edited?: boolean } }).metadata?.edited),
  );

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
      deliveryStatus={deliveryStatus}
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
  const segments = useMemo(
    () =>
      keyMentionSegments(
        buildMentionSegments({
          text: bodyText,
          sourceRefs,
          sessionTitles,
          agentNames,
        }),
      ),
    [bodyText, sourceRefs, sessionTitles, agentNames],
  );

  /**
   * The body split at its reply quotes, or `null` for a message without any —
   * that message keeps the single-run render below, unchanged.
   *
   * A quoted message drops `sourceRefs`, for the reason a command message
   * does: the server's offsets index the raw part text, and every stripped
   * block (a quote most of all) moved the characters under them. Each text
   * run gets the regex fill in `buildMentionSegments`, which finds the same
   * `@` mentions from the run's own text.
   *
   * A command message is parsed from its own halves, not from the part text:
   * the composer writes its quotes into the args and into `split.before`, as
   * raw `<reply_context>` blocks ahead of the chip (older messages can hold
   * them on either side). The part text is
   * the expanded template, which repeats the args — so the part's `quotes`
   * are ignored here, or every quote would draw twice. `COMMAND_SLOT` marks
   * where the chip goes between the two halves.
   */
  const quotedPieces = useMemo<QuotedBodyPiece[] | null>(() => {
    if (effectiveCommandInfo) {
      const before = parseReplyContexts(commandBefore.text);
      const after = parseReplyContexts(bodyText);
      if (before.quotes.length === 0 && after.quotes.length === 0) return null;
      return splitAtQuoteMarkers(
        before.cleanText + COMMAND_SLOT + offsetQuoteMarkers(after.cleanText, before.quotes.length),
        [...before.quotes, ...after.quotes],
      );
    }
    if (quotes.length === 0) return null;
    return splitAtQuoteMarkers(bodyText, quotes);
  }, [quotes, effectiveCommandInfo, commandBefore.text, bodyText]);

  const sessionHref = useProjectSessionHref();

  const openSessionMention = (raw: string) => {
    // `/projects/<id>/sessions/<id>`, not `/sessions/<id>`. The latter is not a
    // route — the tab stays mounted so the click looks fine, but the URL it
    // writes into history 404s on reload or Back. See `session-href.ts`.
    // Direct session ID (ses_...) — navigate without title lookup
    if (raw.startsWith('ses_')) {
      const href = sessionHref(raw);
      if (!href) return;
      openTabAndNavigate({
        id: raw,
        title: tI18nComplete.raw('text6959b4159575'),
        type: 'session',
        href,
      });
      return;
    }
    const ref = sessionRefs.find((s) => s.title === raw);
    if (!ref) return;
    const href = sessionHref(ref.id);
    if (!href) return;
    openTabAndNavigate({
      id: ref.id,
      title: ref.title || 'Session',
      type: 'session',
      href,
    });
  };

  /* The `/command` chip sits exactly where it was typed — leading the line,
     between two words, or trailing — because that is where the composer drew
     it. `split.before` is the prose that preceded the chip; without it every
     command message rebuilt as `/name` + args and a chip typed mid-sentence
     silently jumped to the front. */
  const commandLead = effectiveCommandInfo ? (
    <>
      {commandBefore.text ? <span>{commandBefore.text} </span> : null}
      <MentionChip kind="command" label={effectiveCommandInfo.name} />
      {bodyText ? ' ' : null}
    </>
  ) : null;

  const renderSegments = (segs: ReturnType<typeof keyMentionSegments>) =>
    segs.map((seg) =>
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
    );

  const renderRunSegments = (runText: string) =>
    renderSegments(
      keyMentionSegments(buildMentionSegments({ text: runText, sessionTitles, agentNames })),
    );

  /** One text run of a quoted body. The run holding `COMMAND_SLOT` draws the
   *  chip there, with the same spacing `commandLead` uses. */
  const renderQuotedRun = (runText: string) => {
    const slot = runText.indexOf(COMMAND_SLOT);
    if (slot === -1 || !effectiveCommandInfo) return renderRunSegments(runText);
    const lead = runText.slice(0, slot);
    const rest = runText.slice(slot + COMMAND_SLOT.length);
    return (
      <>
        {lead ? <span>{lead} </span> : null}
        <MentionChip kind="command" label={effectiveCommandInfo.name} />
        {rest ? ' ' : null}
        {renderRunSegments(rest)}
      </>
    );
  };

  // Editing replaces the WHOLE message column — bubble, attachments, meta row —
  // with the full-width editor, ChatGPT-style. Placed after every hook above so
  // the hook count never changes when editing starts or ends.
  if (editingText != null && onEditSend && onEditCancel) {
    return (
      <UserMessageEditor
        initialText={editingText}
        attachments={allAttachments}
        pending={editPending}
        onCancel={onEditCancel}
        onSend={(text, kept) => onEditSend(message.info.id, text, kept)}
      />
    );
  }

  // Channel messages (Slack / Microsoft Teams / Telegram): a branded card with the sender
  if (channelMessageInfo) {
    return <ChannelMessage info={channelMessageInfo} actions={actions} />;
  }

  if (reminderInfo) {
    return <ReminderMessage info={reminderInfo} actions={actions} />;
  }

  if (triggerEventInfo) {
    return <TriggerMessage info={triggerEventInfo} actions={actions} />;
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
        // The bubble hugs its own text (`w-fit`), so lifting the cap widens
        // ONLY the plan card — the message itself does not stretch.
        showPlan ? 'max-w-full' : 'max-w-[80%]',
      )}
    >
      {/* A member author is the avatar above the bubble; another session's
          agent has no face, so it keeps the named label. */}
      {showAuthor && author?.kind === 'session' && <MessageAuthorLabel author={author} />}
      {/* A kept failed send with no files still states its failure, with Retry. */}
      {(allAttachments.length > 0 || uploadStatus?.state === 'failed') && (
        <MessageAttachments
          attachments={allAttachments}
          status={uploadStatus}
          onOpenPastedContent={onOpenPastedContent}
        />
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
      {(bodyText || quotedPieces || effectiveCommandInfo) && (
        <MessageSenderAbove sender={showAuthor && author?.kind === 'member' ? author : null}>
          <UserMessageBubble
            tail={showAuthor && author?.kind === 'member'}
            canExpand={canExpand}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            textId={`${message.info.id}-text`}
            textRef={textRef}
            quoted={Boolean(quotedPieces)}
          >
            {quotedPieces ? (
              <QuotedMessageBody pieces={quotedPieces} renderText={renderQuotedRun} />
            ) : (
              (bodyText || effectiveCommandInfo) && (
                <>
                  {commandLead}
                  {renderSegments(segments)}
                </>
              )
            )}
          </UserMessageBubble>
        </MessageSenderAbove>
      )}
      {/* Sent-at, "edited", and the hover actions are ONE row, sitting directly
          under the bubble they describe — notification cards below are separate
          objects and must not come between a message and its own meta. */}
      {actions}

      {/* The plan, last — closest to the assistant work it governs.
          MOBILE ONLY: `session-chat` nulls the anchor on every desktop width
          (`usePlanInChat` -> `chatPlanAnchorId`), where the Easy panel's Plan
          card draws it instead. Under 768px there is no panel column, so this
          is the only surface session todos have — `session-chat` drops every
          `todowrite` part before segmentation, so without it the plan renders
          nowhere and reads as "no plan was made".
          `w-full` because the column is `items-end`: a checklist is a panel
          across the column, not something trailing off a sentence. */}
      {showPlan && (
        <div className="w-full">
          <PlanCard sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}
