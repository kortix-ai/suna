'use client';

/** Moved from session-chat.tsx (`UserMessageRow`) so the turn module owns the
 *  user-message card. Full-width card, no reference chips — see
 *  docs/superpowers/sdd/2026-07-31-assistant-turn-ux/task-6-report.md. */

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CaretDownIcon as ChevronDown,
  FileTextIcon as FileText,
  ImageIcon,
  ArrowBendUpLeftIcon as Reply,
  ScissorsIcon as Scissors,
  TerminalWindowIcon as Terminal,
  TimerIcon as Timer,
} from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { detectCommandFromText } from '@/features/session/detect-command';
import { SandboxImage } from '@/features/session/sandbox-image';
import { cn } from '@/lib/utils';
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
    <div className="border-border/60 bg-card/50 overflow-hidden rounded-2xl border">
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

// ============================================================================
// User Message
// ============================================================================

export function UserMessage({
  message,
  agentNames,
  commandInfo,
  commands,
}: {
  message: MessageWithParts;
  agentNames?: string[];
  commandInfo?: { name: string; args?: string };
  commands?: Command[];
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

  // Resolve effective command info: use runtime-tracked info or fall back to template matching
  const effectiveCommandInfo = useMemo(
    () => commandInfo ?? detectCommandFromText(rawText, commands),
    [commandInfo, rawText, commands],
  );

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
        <div className="border-border/60 bg-muted/40 inline-flex max-w-[85%] flex-col gap-1.5 rounded-2xl border px-4 py-2.5">
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
      </div>
    );
  }

  // Trigger event messages: render as a right-aligned card
  if (triggerEventInfo) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="border-border/60 bg-muted/40 inline-flex flex-col gap-1.5 rounded-2xl border px-4 py-2.5">
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
      </div>
    );
  }

  // Command messages: render as a right-aligned card instead of the raw template text
  if (effectiveCommandInfo) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="border-border/60 bg-muted/40 inline-flex flex-col gap-1.5 rounded-2xl border px-4 py-2.5">
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
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          'bg-card/50 border-border/60 flex w-full flex-col overflow-hidden rounded-md border px-4 py-3',
          canExpand && 'hover:bg-card/80 cursor-pointer transition-colors',
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
        {/* Attachment thumbnails (images/PDFs) */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3 pb-0">
            {attachments.map((file) => (
              <div key={file.id} className="border-border/50 overflow-hidden rounded-lg border">
                {file.mime?.startsWith('image/') && file.url ? (
                  <SandboxImage
                    src={file.url}
                    alt={file.filename ?? 'Attachment'}
                    className="max-h-32 max-w-48 object-cover"
                    preview
                  />
                ) : file.mime === 'application/pdf' ? (
                  <div className="bg-muted/30 flex items-center gap-2 px-3 py-2">
                    <FileText className="text-muted-foreground size-4" />
                    <span className="text-muted-foreground text-xs">{file.filename || 'PDF'}</span>
                  </div>
                ) : (
                  <div className="bg-muted/30 flex items-center gap-2 px-3 py-2">
                    <ImageIcon className="text-muted-foreground size-4" />
                    <span className="text-muted-foreground text-xs">{file.filename || 'File'}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Reply context banner */}
        {replyContext && (
          <div className="bg-primary/5 border-primary/10 mx-3 mt-3 mb-0 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
            <Reply className="text-primary/60 size-3 flex-shrink-0" />
            <span className="text-muted-foreground truncate text-xs">
              {replyContext.length > 150 ? `${replyContext.slice(0, 150)}...` : replyContext}
            </span>
          </div>
        )}

        {/* Text content */}
        {text && (
          <div className="relative px-4 py-3">
            <div
              ref={textRef}
              className={cn(
                'min-w-0 text-sm leading-relaxed break-words whitespace-pre-wrap',
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

            {/* Gradient fade overlay for collapsed long messages */}
            {canExpand && !expanded && (
              <div className="from-card/50 pointer-events-none absolute inset-x-0 bottom-3 h-10 bg-gradient-to-t to-transparent" />
            )}

            {/* Expand/collapse indicator */}
            {canExpand && (
              <div className="bg-card/80 text-muted-foreground absolute right-4 bottom-3 z-10 rounded-md p-1 backdrop-blur-sm">
                <ChevronDown
                  className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                />
              </div>
            )}
          </div>
        )}
      </div>
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
    </div>
  );
}
