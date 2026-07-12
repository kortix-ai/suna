'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { SandboxImage } from '@/features/session/sandbox-image';
import { SessionApprovalPrompt } from '@/features/session/session-approval-prompt';
import { isPendingAction, useSessionAudit } from '@/features/session/session-audit-shared';
import { SessionPermissionPrompt } from '@/features/session/session-permission-prompt';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Image as ImageIcon,
  Layers,
  Loader2,
  MessageSquare,
  Reply,
  Scissors,
  Search,
  Terminal,
  Timer,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { NO_MODEL_AVAILABLE_MESSAGE } from '@/features/session/model-availability';
import { ConnectProviderDialog } from '@/features/session/model-selector';
import {
  type QuestionAction,
  QuestionPrompt,
  type QuestionPromptHandle,
} from '@/features/session/question-prompt';
import {
  isInvisibleActivityPart,
  isNoGroupActivityTool,
  isShellActivityTool,
  shellActivityGroupLabel,
} from '@/features/session/session-activity-groups';
import {
  type AttachedFile,
  SessionChatInput,
  type TrackedMention,
} from '@/features/session/session-chat-input';
import { SessionContextModal } from '@/features/session/session-context-modal';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { SessionWelcome } from '@/features/session/session-welcome';
import { GridFileCard } from './grid-file-card';

import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { STATUS_BG, STATUS_BORDER, STATUS_TEXT } from '@/components/ui/status';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { searchWorkspaceFiles } from '@/features/files';
import { uploadFile } from '@/features/files/api/runtime-files';
import { AssistantPendingRow } from '@/features/session/assistant-pending-row';
// billingApi / invalidateAccountState / useQueryClient removed — billing is handled server-side by the router
import { ChatMinimap } from '@/features/session/chat-minimap';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import { contextToolSummary, contextToolTrigger } from '@/features/session/tool-meta';
import { ToolActivateContext, ToolPartRenderer } from '@/features/session/tool-renderers';
import {
  buildOptimisticPromptTextWithUploads,
  buildPromptPartsWithUploads,
} from '@/features/session/uploaded-file-refs';
import { useRuntimeConfig } from '@/hooks/runtime/use-runtime-config';
import {
  type ModelKey,
  formatModelString,
  formatPromptModel,
  parseModelKey,
  useRuntimeLocal,
} from '@/hooks/runtime/use-runtime-local';
import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';
import {
  ascendingId,
  rejectQuestion,
  replyToPermission,
  replyToQuestion,
  useAbortRuntimeSession,
  useRuntimeAgents,
  useRuntimeCommands,
  useRuntimeProviders,
  useRuntimeReady,
  useRuntimeSession,
  useRuntimeSessions,
} from '@/hooks/runtime/use-runtime-sessions';
import { useSessionSync } from '@/hooks/runtime/use-session-sync';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { useModelPricingLookup } from '@/lib/model-pricing';
import { getRuntimeClient as getClient } from '@kortix/sdk/runtime-client';
import {
  type AgentRefLike,
  type FileRefLike,
  buildAgentRefsBlock,
  buildFileRefsBlock,
} from '@/lib/project-preamble';
import { playSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';
import {
  type KortixSystemMessage,
  type SessionReport,
  extractKortixSystemMessages,
  extractSessionReport,
  stripKortixSystemTags,
} from '@/lib/utils/kortix-system-tags';
import { useChatSendStore } from '@/stores/chat-send-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useMessageJumpStore } from '@/stores/message-jump-store';
import { useOnboardingModeStore } from '@/stores/onboarding-mode-store';
import { useRuntimeCompactionStore } from '@/stores/runtime-compaction-store';
import { useRuntimePendingStore } from '@/stores/runtime-pending-store';
import { useSyncStore } from '@/stores/runtime-sync-store';
import { usePendingFilesStore } from '@/stores/pending-files-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import {
  type KortixSendError,
  abandonOptimisticSend,
  applyOptimisticAbort,
  beginOptimisticSend,
  classifySendError,
  clearStartStash,
  readStartStash,
  replayStartStash,
  sendAndRecover,
  usePermissionSelfHeal,
  useProjectConfig,
  useQuestionSelfHeal,
} from '@kortix/sdk/react';
// Shared UI primitives (framework-agnostic, reusable on mobile)
import {
  type AgentPart,
  type Command,
  type FilePart,
  type MessageWithParts,
  type Part,
  type PermissionRequest,
  type QuestionRequest,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
  type Turn,
  collectTurnParts,
  findLastTextPart,
  formatCost,
  formatDuration,
  formatTokens,
  getHiddenToolParts,
  getPermissionForTool,
  getRetryInfo,
  getRetryMessage,
  getShellModePart,
  getTurnCost,
  getTurnError,
  getTurnStatus,
  getWorkingState,
  groupMessagesIntoTurns,
  isAgentPart,
  isAttachment,
  isCompactionPart,
  isFilePart,
  isLastUserMessage,
  isPatchPart,
  isReasoningPart,
  isSnapshotPart,
  isTextPart,
  isToolPart,
  isToolPartHidden,
  shouldShowToolPart,
  splitUserParts,
} from '@/ui';
import { SandboxUrlDetector } from './sandbox-url-detector';

// ============================================================================
// Reply-to context (select & reply feature)
// ============================================================================

/** Selected text the user wants to reference in their next message. */
export interface ReplyToContext {
  text: string;
}

// ============================================================================
// Sub-Session Breadcrumb
// ============================================================================

// SubSessionBar removed — subsessions now use SessionSiteHeader + chat input indicator

// ============================================================================
// Optimistic answers cache
// ============================================================================
// When a user answers a question, we save the answers here immediately.
// This survives SSE `message.part.updated` events that may overwrite the
// tool part's state before the server has merged the answers.  The cache
// is keyed by the question tool part's `id` (stable across updates).
// Entries are cleaned up once the server's authoritative part arrives with
// real `metadata.answers`.

const optimisticAnswersCache = new Map<
  string,
  { answers: string[][]; input: Record<string, unknown> }
>();

// ============================================================================
// Parse answers from the question tool's output string
// ============================================================================
// When metadata.answers is missing (e.g. after page reload, or the server
// never finalized the tool part), we can try to extract answers from the
// output string. The server formats it as:
//   "User has answered your questions: \"Q1\"=\"A1\". You can now continue..."
// This is a best-effort parser; if it can't match, returns null.

function parseAnswersFromOutput(
  output: string,
  input?: { questions?: Array<{ question: string }> },
): string[][] | null {
  if (!output) return null;

  const questions = input?.questions;
  if (!questions || questions.length === 0) return null;

  // Try to extract "question"="answer" pairs from the output
  const pairRegex = /"([^"]*)"="([^"]*)"/g;
  const pairs: { question: string; answer: string }[] = [];
  let match;
  while ((match = pairRegex.exec(output)) !== null) {
    pairs.push({ question: match[1], answer: match[2] });
  }

  if (pairs.length > 0) {
    // Match pairs to input questions by order (they correspond 1:1)
    return questions.map((_, i) => {
      const pair = pairs[i];
      return pair ? [pair.answer] : [];
    });
  }

  // Fallback: if we can't parse pairs but the output mentions "answered",
  // return a placeholder to indicate the question was answered
  if (output.toLowerCase().includes('answered')) {
    return questions.map(() => ['Answered']);
  }

  return null;
}

function formatCommandError(errorLike: unknown): string {
  const err = errorLike as any;
  const root = err?.data ?? err;
  const data = root?.data;
  const directMessage =
    root?.message ||
    err?.message ||
    root?.error ||
    err?.error ||
    (typeof err === 'string' ? err : '');

  if (typeof directMessage === 'string' && directMessage.trim()) {
    return directMessage.trim();
  }

  if (root?.name === 'ProviderModelNotFoundError') {
    const providerID =
      typeof data?.providerID === 'string' && data.providerID
        ? data.providerID
        : 'selected provider';
    const modelID =
      typeof data?.modelID === 'string' && data.modelID ? data.modelID : 'selected model';
    if (providerID === '[object Object]') {
      return 'Invalid model selection was sent to the command endpoint. Please reselect a model and try again.';
    }
    return `Model ${modelID} was not found for provider ${providerID}.`;
  }

  if (typeof root?.name === 'string' && root.name) {
    return root.name;
  }

  if (typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return 'Command failed';
    }
  }

  return 'Command failed';
}

/**
 * Classify a send/command failure onto the SDK's typed `KortixSendError`
 * layer (billing vs runtime-not-ready vs runtime-error) so the banner can key
 * off `.kind` instead of regexing the message — while keeping this file's
 * richer message formatting (`formatCommandError` special-cases things like
 * `ProviderModelNotFoundError` that the SDK's generic formatter doesn't know
 * about).
 */
function classifySessionError(err: unknown): KortixSendError {
  return { ...classifySendError(err), message: formatCommandError(err) };
}

// ============================================================================
// System message indicator — subtle inline pill for kortix_system messages
// ============================================================================

function SystemMessageIndicator({ messages }: { messages: KortixSystemMessage[] }) {
  if (messages.length === 0) return null;

  // Combine all messages into a single line: "Goal · iteration 3/50"
  const parts = messages.map((msg) => (msg.detail ? `${msg.label} · ${msg.detail}` : msg.label));
  const text = parts.join('  ·  ');

  return (
    <div className="-my-1 flex items-center gap-2">
      <div className="bg-border/30 h-px flex-1" />
      <span className="text-muted-foreground/30 text-xs whitespace-nowrap select-none">{text}</span>
      <div className="bg-border/30 h-px flex-1" />
    </div>
  );
}

// ============================================================================
// Answered question card — collapsible summary of completed Q&A
// ============================================================================

function AnsweredQuestionCard({
  part,
  defaultExpanded = false,
}: {
  part: ToolPart;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const input = (part.state as any)?.input ?? {};
  const metadata = (part.state as any)?.metadata ?? {};
  const questions: Array<{ question: string; options?: { label: string }[] }> = Array.isArray(
    input.questions,
  )
    ? input.questions
    : [];
  const answers: string[][] = Array.isArray(metadata.answers) ? metadata.answers : [];
  if (questions.length === 0 || answers.length === 0) return null;

  const answeredCount = answers.filter((a) => a.length > 0).length;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="border-border/40 bg-muted/20 overflow-hidden rounded-2xl border">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="hover:bg-muted/40 flex h-auto w-full items-center justify-start gap-1.5 rounded-none px-2.5 py-1.5 text-left"
          >
            <MessageSquare className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-foreground text-xs font-medium">Questions</span>
            <span className="text-muted-foreground/70 text-xs">{answeredCount} answered</span>
            <ChevronDown
              className={cn(
                'text-muted-foreground ml-auto size-3 transition-transform',
                expanded && 'rotate-180',
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border/30 border-t">
            {questions.map((q, i) => {
              const answer = answers[i] || [];
              const answerText = answer.join(', ') || 'No answer';
              return (
                <div key={i} className="border-border/30 border-b px-2.5 py-2 last:border-b-0">
                  <div className="[&_*]:!text-muted-foreground/70 [&_strong]:!text-muted-foreground/60 [&_code]:!text-xs [&_li]:!my-0 [&_ol]:!my-0 [&_p]:!my-0 [&_p]:!text-xs [&_p]:!leading-relaxed [&_ul]:!my-0">
                    <UnifiedMarkdown content={q.question} />
                  </div>
                  <div className="text-foreground mt-0.5 text-sm font-medium">{answerText}</div>
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ============================================================================
// Highlight @mentions in plain text (for optimistic & user messages)
// ============================================================================

function HighlightMentions({
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
          <span
            key={i}
            className={mentionClass}
            onClick={(e) => {
              e.stopPropagation();
              onFileClick(seg.text.replace(/^@/, ''));
            }}
          >
            {seg.text}
          </span>
        ) : seg.type === 'session' ? (
          <span
            key={i}
            className={mentionClass}
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
          </span>
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

// ============================================================================
// Parse <file> XML references from uploaded file text parts
// ============================================================================

interface ParsedFileRef {
  path: string;
  mime: string;
  filename: string;
}

const FILE_TAG_REGEX =
  /<file\s+path="([^"]*?)"\s+mime="([^"]*?)"\s+filename="([^"]*?)">\s*[\s\S]*?<\/file>/g;

// Fixed third-party brand colors for channel-source cards. These are the
// platforms' own brand hues (not themeable), so they live as named
// constants rather than as inline hex literals.
const CHANNEL_BRAND_COLOR = {
  Telegram: '#29B6F6',
  Slack: '#E91E63',
} as const;

function parseFileReferences(text: string): {
  cleanText: string;
  files: ParsedFileRef[];
} {
  const files: ParsedFileRef[] = [];
  const cleanText = text
    .replace(FILE_TAG_REGEX, (_, path, mime, filename) => {
      files.push({ path, mime, filename });
      return '';
    })
    .trim();
  return { cleanText, files };
}

// ============================================================================
// Parse <session_ref> XML tags from session mention text parts
// ============================================================================

interface ParsedSessionRef {
  id: string;
  title: string;
}

function parseSessionReferences(text: string): {
  cleanText: string;
  sessions: ParsedSessionRef[];
} {
  const sessions: ParsedSessionRef[] = [];
  let cleaned = text.replace(
    /<session_ref\s+id="([^"]*?)"\s+title="([^"]*?)"\s*\/>/g,
    (_, id, title) => {
      sessions.push({ id, title });
      return '';
    },
  );
  // Strip the instruction header text
  cleaned = cleaned
    .replace(
      /\n*Referenced sessions \(use the session_context tool to fetch details when needed\):\n?/g,
      '',
    )
    .trim();
  return { cleanText: cleaned, sessions };
}

// ============================================================================
// Parse <project_ref> XML references from project mentions / selector
// ============================================================================

export interface ParsedProjectRef {
  id?: string;
  name: string;
  path?: string;
  description?: string;
}

function unescapeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function parseProjectReferences(text: string): {
  cleanText: string;
  projects: ParsedProjectRef[];
} {
  // Historical messages may contain <project_ref/> blocks. Projects are no
  // longer a user-facing/runtime concept, so strip the metadata without
  // rendering project chips or passing project refs forward.
  let cleaned = text.replace(/<project_ref\b([\s\S]*?)\/>/g, '');
  // Strip the instruction header (description uses [^)]* which is safe
  // because the header never contains a literal `)` before its closing one).
  cleaned = cleaned.replace(/\n*Referenced projects \([^)]*\):\n?/g, '').trim();
  return { cleanText: cleaned, projects: [] };
}

// ============================================================================
// Parse <file_ref> + <agent_ref> XML tags from @ mentions in chat input
// ============================================================================
//
// Uploaded files still use the existing <file path="..." mime="..." ...>
// tag (parseFileReferences). These new tags only cover @-mention-style refs
// to existing workspace files and agents, so the agent sees structured
// metadata and the renderer strips them out of the visible text.

export interface ParsedFileMentionRef {
  path: string;
  name: string;
}
export interface ParsedAgentMentionRef {
  name: string;
}

function parseFileMentionReferences(text: string): {
  cleanText: string;
  files: ParsedFileMentionRef[];
} {
  const files: ParsedFileMentionRef[] = [];
  let cleaned = text.replace(/<file_ref\b([\s\S]*?)\/>/g, (_, attrs: string) => {
    const pick = (key: string): string | undefined => {
      const m = attrs.match(new RegExp(`${key}="([^"]*?)"`));
      return m ? unescapeAttr(m[1]) : undefined;
    };
    const path = pick('path');
    const name = pick('name') ?? path;
    if (path) files.push({ path, name: name || path });
    return '';
  });
  cleaned = cleaned.replace(/\n*Referenced files \([^)]*\):\n?/g, '').trim();
  return { cleanText: cleaned, files };
}

function parseAgentMentionReferences(text: string): {
  cleanText: string;
  agents: ParsedAgentMentionRef[];
} {
  const agents: ParsedAgentMentionRef[] = [];
  let cleaned = text.replace(/<agent_ref\b([\s\S]*?)\/>/g, (_, attrs: string) => {
    const pick = (key: string): string | undefined => {
      const m = attrs.match(new RegExp(`${key}="([^"]*?)"`));
      return m ? unescapeAttr(m[1]) : undefined;
    };
    const name = pick('name');
    if (name) agents.push({ name });
    return '';
  });
  cleaned = cleaned.replace(/\n*Referenced agents \([^)]*\):\n?/g, '').trim();
  return { cleanText: cleaned, agents };
}

// ============================================================================
// Parse <reply_context> XML from select-and-reply feature
// ============================================================================

function parseReplyContext(text: string): {
  cleanText: string;
  replyContext: string | null;
} {
  const match = text.match(/<reply_context>([\s\S]*?)<\/reply_context>/);
  if (!match) return { cleanText: text, replyContext: null };
  const replyContext = match[1].trim();
  const cleanText = text.replace(/<reply_context>[\s\S]*?<\/reply_context>\s*/, '').trim();
  return { cleanText, replyContext };
}

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

// ── Generic XML notification parsing ──────────────────────────────────
//
// Matches any XML block: <tag_name>...content...</tag_name>
// No hardcoded tag names. Runs LAST in the parsing pipeline so all
// other XML subsystems (file refs, session refs, reply context, DCP,
// kortix_system) have already consumed their tags. Whatever remains
// is a system notification.
const XML_BLOCK_REGEX = /<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/gi;

interface SystemNotification {
  tag: string;
  label: string;
  fields: [string, string][];
  body: string;
}

/** A message typed while the agent was busy, held client-side until a safe boundary. */
interface QueuedMessage {
  id: string;
  text: string;
  files?: AttachedFile[];
  mentions?: TrackedMention[];
}

/** Parse all remaining XML blocks from text as system notifications. */
function parseSystemNotifications(text: string): {
  cleanText: string;
  notifications: SystemNotification[];
} {
  const notifications: SystemNotification[] = [];
  const cleanText = text
    .replace(XML_BLOCK_REGEX, (_full, tag: string, rawBody: string) => {
      const fields: [string, string][] = [];
      const bodyLines: string[] = [];
      let pastHeader = false;

      for (const line of rawBody.trim().split('\n')) {
        if (pastHeader) {
          bodyLines.push(line);
          continue;
        }
        if (line.trim() === '') {
          pastHeader = true;
          continue;
        }
        const m = line.match(/^([A-Za-z][\w\s]*?):\s*(.+)$/);
        if (m) {
          fields.push([m[1].trim(), m[2].trim()]);
        } else {
          pastHeader = true;
          bodyLines.push(line);
        }
      }

      notifications.push({
        tag: tag.toLowerCase(),
        label: tag.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        fields,
        body: bodyLines.join('\n').trim(),
      });
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanText, notifications };
}

function stripSystemPtyText(text: string): string {
  if (!text) return '';
  // Only strip kortix_system tags (backend-internal metadata).
  // Notification XML is stripped later by parseSystemNotifications()
  // which runs last in the parsing pipeline.
  return stripKortixSystemTags(text)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

function SystemNotificationCard({ notification }: { notification: SystemNotification }) {
  const [open, setOpen] = useState(false);

  // Show first 1-2 short field values inline as muted detail
  const inlineDetail = notification.fields
    .slice(0, 2)
    .map(([, v]) => v)
    .filter((v) => v.length < 40)
    .join(' · ');

  // Expandable when there's a body, >2 fields, or any long values
  const hasExpandable =
    !!notification.body ||
    notification.fields.length > 2 ||
    notification.fields.some(([, v]) => v.length >= 40);

  const isError = notification.tag.includes('failed') || notification.tag.includes('blocker');
  const isWarning = notification.tag.includes('stopped');

  const iconColor = isError
    ? 'text-destructive/50'
    : isWarning
      ? STATUS_TEXT.warning
      : 'text-muted-foreground/50';

  const trigger = (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-2xl px-2.5 py-1.5',
        'bg-muted/20 border-border/40 border',
        'max-w-full text-xs select-none',
        hasExpandable && 'hover:bg-muted/40 cursor-pointer transition-colors',
      )}
    >
      <Terminal className={cn('size-3.5 flex-shrink-0', iconColor)} />
      <span className="text-muted-foreground/70 truncate">
        {notification.label}
        {inlineDetail && (
          <span className="text-muted-foreground/40 ml-1.5 font-mono">{inlineDetail}</span>
        )}
      </span>
      {hasExpandable && (
        <ChevronRight
          className={cn(
            'text-muted-foreground/30 ml-auto size-3 flex-shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
      )}
    </div>
  );

  if (!hasExpandable) return trigger;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>{trigger}</CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/40 bg-muted/10 space-y-1 rounded-b-lg border border-t-0 px-3 py-2 text-xs">
          {notification.fields.length > 0 && (
            <div className="space-y-0.5">
              {notification.fields.map(([key, value], i) => (
                <div key={i} className="flex min-w-0 gap-2">
                  <span className="text-muted-foreground/40 flex-shrink-0">{key}:</span>
                  <span className="text-muted-foreground/60 font-mono text-xs break-all">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          )}
          {notification.body && (
            <div className="text-muted-foreground/50 max-h-48 overflow-y-auto font-mono text-xs break-all whitespace-pre-wrap">
              {notification.body.slice(0, 2000)}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// Notification-only turn detection
// ============================================================================

/** True when a turn's user message contains only system notification XML
 *  with no real user-authored text. */
function isNotificationOnlyMessage(parts: Part[]): boolean {
  if (parts.length === 0) return false;
  const textParts = parts.filter(
    (p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored,
  ) as TextPart[];
  if (textParts.length === 0) return false;
  const raw = textParts.map((p) => p.text || '').join('\n');
  const { cleanText, notifications } = parseSystemNotifications(stripKortixSystemTags(raw));
  return notifications.length > 0 && !cleanText.trim();
}

// ============================================================================
// NotificationTurn — lightweight turn for system notification messages
// ============================================================================

/** Renders notification-only turns (PTY exits, agent completions, etc.)
 *  inline with the conversation flow, styled like tool-call cards. */
function NotificationTurn({ turn }: { turn: Turn }) {
  const rawText = useMemo(() => {
    return turn.userMessage.parts
      .filter((p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored)
      .map((p) => (p as TextPart).text || '')
      .join('\n');
  }, [turn.userMessage.parts]);

  const { notifications } = useMemo(
    () => parseSystemNotifications(stripKortixSystemTags(rawText)),
    [rawText],
  );

  if (notifications.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {notifications.map((n, i) => (
        <SystemNotificationCard key={`${n.tag}-${i}`} notification={n} />
      ))}
    </div>
  );
}

// ============================================================================
// Edit Part Dialog — inline editing for text parts
// ============================================================================


// ============================================================================
// User Message Row
// ============================================================================

/**
 * Detect if user message text matches a known command template.
 * Returns the command name + extracted args, or undefined if no match.
 * Works by splitting each command template at its first placeholder ($1 or $ARGUMENTS)
 * and checking if the message text starts with that prefix.
 */
function detectCommandFromText(
  rawText: string,
  commands?: Command[],
): { name: string; args?: string } | undefined {
  if (!commands || !rawText) return undefined;

  const trimmedRawText = rawText.trim();
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const cmd of commands) {
    if (!cmd.template) continue;
    const tpl = cmd.template.trim();

    // For large templates (e.g. onboarding.md), skip regex entirely and do a
    // fast exact-match: strip the trailing $ARGUMENTS placeholder and check
    // if rawText matches the body. This handles commands whose template is the
    // full file content (which opencode sends verbatim as the user message).
    if (tpl.length > 2000) {
      // Strip trailing $ARGUMENTS (with optional surrounding whitespace/newlines)
      const tplBody = tpl.replace(/\s*\$ARGUMENTS\s*$/, '').trimEnd();
      // Fast check: does rawText equal the template body exactly?
      if (tplBody.length > 0 && trimmedRawText === tplBody) {
        return { name: cmd.name, args: undefined };
      }
      // Also handle the case where $ARGUMENTS is at the end and the user
      // provided some text after the template body.
      if (tplBody.length > 0 && trimmedRawText.startsWith(tplBody)) {
        const after = trimmedRawText.slice(tplBody.length).trim();
        return {
          name: cmd.name,
          args: after.length > 0 && after.length < 200 ? after : undefined,
        };
      }
      continue;
    }

    // Find the first placeholder position ($1, $2, ..., $ARGUMENTS)
    const placeholderMatch = tpl.match(/\$(\d+|\bARGUMENTS\b)/);
    // Use the text before the first placeholder as the prefix to match
    const prefix = placeholderMatch
      ? tpl.slice(0, placeholderMatch.index).trimEnd()
      : tpl.trimEnd();

    // Require a meaningful prefix (at least 20 chars) to avoid false positives
    if (prefix.length < 20) continue;

    if (trimmedRawText.startsWith(prefix)) {
      // Extract the user's arguments: text after the template prefix (approximate)
      // For templates ending with the placeholder, the args are what comes after the prefix
      let args: string | undefined;
      if (placeholderMatch) {
        const afterPrefix = trimmedRawText.slice(prefix.length).trim();
        // The args are at the end; try to extract the last meaningful section
        const lastNewlineBlock = afterPrefix.split('\n\n').pop()?.trim();
        if (lastNewlineBlock && lastNewlineBlock.length < 200) {
          args = lastNewlineBlock;
        }
      }
      return { name: cmd.name, args };
    }

    // Fallback: robust full-template match where placeholders are wildcards.
    // This handles commands whose template begins with a placeholder.
    const placeholderRegex = /\$(\d+|\bARGUMENTS\b)/g;
    const placeholderOrder: string[] = [];
    let regexSource = '^';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(tpl)) !== null) {
      regexSource += escapeRegExp(tpl.slice(lastIndex, match.index));
      regexSource += '([\\s\\S]*?)';
      placeholderOrder.push(match[1]);
      lastIndex = match.index + match[0].length;
    }

    regexSource += escapeRegExp(tpl.slice(lastIndex));
    regexSource += '$';

    let fullTemplateMatch: RegExpMatchArray | null;
    try {
      fullTemplateMatch = trimmedRawText.match(new RegExp(regexSource));
    } catch {
      // Regex too large or invalid — skip this command template
      continue;
    }
    if (!fullTemplateMatch) continue;

    let args: string | undefined;
    const captures = fullTemplateMatch.slice(1).map((value) => value?.trim() ?? '');
    const argumentsIndex = placeholderOrder.findIndex((name) => name.toUpperCase() === 'ARGUMENTS');
    const bestCapture =
      (argumentsIndex >= 0 ? captures[argumentsIndex] : undefined) ||
      captures.find((value) => value.length > 0);
    if (bestCapture && bestCapture.length < 200) {
      args = bestCapture;
    }

    return { name: cmd.name, args };
  }
  return undefined;
}

function UserMessageRow({
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
  const openPreview = useFilePreviewStore((s) => s.openPreview);
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
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          'bg-card flex max-w-[90%] flex-col overflow-hidden rounded-3xl rounded-br-lg border',
          canExpand && 'hover:bg-card/80 cursor-pointer transition-colors',
        )}
        onClick={() => canExpand && setExpanded(!expanded)}
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

        {/* Uploaded file references (from <file> XML tags) */}
        {uploadedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3 pb-0">
            {uploadedFiles.map((f, i) => (
              <div key={i} onClick={(e) => e.stopPropagation()}>
                <GridFileCard
                  filePath={f.path}
                  fileName={f.path.split('/').pop() || f.path}
                  onClick={() => openPreview(f.path)}
                />
              </div>
            ))}
          </div>
        )}

        {/* Project references — compact neutral chips, one per referenced project */}
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
          <div className="group relative px-4 py-3">
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
                    <span
                      key={i}
                      className={mentionClass}
                      onClick={(e) => {
                        e.stopPropagation();
                        openFileInComputer(seg.text.replace(/^@/, ''));
                      }}
                    >
                      {seg.text}
                    </span>
                  ) : seg.type === 'session' ? (
                    <span
                      key={i}
                      className={mentionClass}
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
                    </span>
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
              <div className="from-card pointer-events-none absolute inset-x-0 bottom-3 h-10 bg-gradient-to-t to-transparent" />
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

// ============================================================================
// Throttled Markdown — limits re-renders during streaming (~30fps)
// ============================================================================

/**
 * Strip the incomplete trailing table row while streaming so the markdown
 * parser doesn't render broken borders / pipe characters.
 *
 * A markdown table row must start with `|` and end with `|` followed by a
 * newline. If the last line of the content looks like an incomplete row
 * (starts with `|` but doesn't end with `|`), we trim it. We also trim a
 * trailing separator row that is still being typed (e.g. `| --- | --`).
 */
function trimIncompleteTableRow(text: string): string {
  // Fast path: no pipe at all → nothing to trim
  if (!text.includes('|')) return text;

  const lines = text.split('\n');
  // Walk backwards and remove incomplete table lines from the end.
  // A table row must start AND end with `|` to be considered complete.
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const trimmed = last.trim();
    // Empty trailing line — stop
    if (trimmed === '') break;
    // A complete table row/separator ends with `|`
    if (trimmed.startsWith('|') && !trimmed.endsWith('|')) {
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join('\n');
}

function closeUnterminatedCodeFence(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  let fenceCount = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      fenceCount++;
    }
  }
  if (fenceCount % 2 === 0) return text;
  return `${text}\n\n\`\`\``;
}

function ThrottledMarkdown({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  // During streaming, only close unterminated code fences (safe — just
  // appends closing backticks). Do NOT trim table rows — that strips
  // real content mid-stream and causes garbled text until completion.
  // The reference (opencode PacedMarkdown) does zero content modification.
  const displayContent = isStreaming
    ? closeUnterminatedCodeFence(content)
    : trimIncompleteTableRow(content);
  return <UnifiedMarkdown content={displayContent} isStreaming={isStreaming} />;
}

/**
 * @deprecated Use `ActivityCard`. Kept only to avoid ripple edits elsewhere.
 */
function GroupedReasoningCard({
  parts,
  isStreaming,
}: {
  parts: ReasoningPart[];
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [streamSeconds, setStreamSeconds] = useState(0);

  // Determine if the last part is still streaming
  const lastPart = parts[parts.length - 1];
  const lastEnd = (lastPart as any).time?.end;
  const reasoningStreaming = isStreaming && !(typeof lastEnd === 'number' && lastEnd > 0);

  // Find the earliest start across all parts for the live timer
  const earliestStart = useMemo(() => {
    let earliest: number | undefined;
    for (const p of parts) {
      const s = (p as any).time?.start;
      if (typeof s === 'number' && (earliest === undefined || s < earliest)) earliest = s;
    }
    return earliest;
  }, [parts]);

  useEffect(() => {
    if (!reasoningStreaming || typeof earliestStart !== 'number') {
      setStreamSeconds(0);
      return;
    }
    const update = () =>
      setStreamSeconds(Math.max(0, Math.round((Date.now() - earliestStart) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [reasoningStreaming, earliestStart]);

  // Aggregate total duration from all completed parts
  const totalDuration = useMemo(() => {
    let total = 0;
    let any = false;
    for (const p of parts) {
      const s = (p as any).time?.start;
      const e = (p as any).time?.end;
      if (typeof s === 'number' && typeof e === 'number' && e > s) {
        total += e - s;
        any = true;
      }
    }
    return any ? total : undefined;
  }, [parts]);

  // Build a one-line preview from the first reasoning block
  const preview = useMemo(() => {
    for (const p of parts) {
      const t = p.text?.trim();
      if (t) {
        // Extract the first bold heading or first sentence
        const boldMatch = t.match(/\*\*(.+?)\*\*/);
        if (boldMatch) return boldMatch[1];
        const firstLine = t.split('\n')[0].replace(/^#+\s*/, '');
        return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
      }
    }
    return '';
  }, [parts]);

  const nonEmptyParts = useMemo(() => parts.filter((p) => p.text?.trim()), [parts]);

  if (nonEmptyParts.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1.5 py-0.5',
            'cursor-pointer text-xs select-none',
            'text-muted-foreground/70',
            'group/reasoning max-w-full transition-colors',
          )}
        >
          <Brain
            className={cn(
              'text-muted-foreground/50 size-3.5 flex-shrink-0',
              reasoningStreaming && 'animate-pulse-heartbeat',
            )}
          />

          <span className="min-w-0 flex-1 truncate">{preview || 'Thinking'}</span>
          {reasoningStreaming && (
            <Loader2 className="text-muted-foreground/40 size-3 flex-shrink-0 animate-spin" />
          )}
          <ChevronRight
            className={cn(
              'size-3 flex-shrink-0 transition-transform',
              'text-muted-foreground/30 opacity-0 group-hover/reasoning:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-border/30 mt-0.5 mb-1.5 ml-[7px] border-l pl-3">
          <div className="text-muted-foreground/50 [&_.kortix-markdown_div]:!text-muted-foreground/50 [&_.kortix-markdown_li]:!text-muted-foreground/50 [&_.kortix-markdown_strong]:!text-muted-foreground/60 [&_.kortix-markdown_em]:!text-muted-foreground/60 space-y-2 [&_.kortix-markdown]:italic [&_.kortix-markdown_div]:!text-xs [&_.kortix-markdown_div]:!leading-[1.5] [&_.kortix-markdown_li]:!text-xs [&_.kortix-markdown_li]:!leading-[1.5]">
            {nonEmptyParts.map((p, i) => (
              <div key={p.id ?? i}>
                <ThrottledMarkdown content={p.text!} isStreaming={false} />
              </div>
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Unified "activity" card that collapses any run of agent-side work —
 * reasoning + tool calls, in original order — into a single compact shelf.
 * Text parts (and other user-facing dividers) break the run.
 *
 * Auto-opens while anything is still streaming/running; collapses once the
 * burst settles. Respects manual user toggles thereafter.
 */
/**
 * Folded Tier-1 "exploration" card.
 *
 * Holds a run of reasoning + Tier-1 tool calls and renders:
 *   • Collapsed: `<icon> <verb> <N noun> · <current/last primary arg>   <timer>`
 *     Verb comes from the run's categories (e.g. "Searched", "Read",
 *     "Explored"), not a generic "N actions".
 *   • Expanded:  reasoning blocks + compact per-tool rows (each row is the
 *     existing ToolPartRenderer, which itself is expandable for full output).
 *
 * Auto-opens while anything is streaming; collapses once settled. Respects
 * manual user toggles after the first click.
 */
/**
 * Same-tool group: collapses 2+ consecutive calls of the same tool into
 * one collapsible row. Header: "Read · 5 files · 3s". Expanded: flat
 * one-liners per call with individual durations.
 */
function SameToolGroup({
  toolName,
  entries,
  sessionId,
  disableNavigation,
  busy,
}: {
  toolName: string;
  entries: Array<{ part: ToolPart; message: MessageWithParts }>;
  sessionId: string;
  disableNavigation?: boolean;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const anyRunning = useMemo(
    () =>
      !!busy &&
      entries.some(
        ({ part }) =>
          (part.state as any)?.status === 'pending' || (part.state as any)?.status === 'running',
      ),
    [busy, entries],
  );

  const totalDurationMs = useMemo(() => {
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;
    for (const { part } of entries) {
      const s = (part.state as any)?.time?.start;
      const e = (part.state as any)?.time?.end;
      if (typeof s === 'number' && s < earliest) earliest = s;
      if (typeof e === 'number' && e > latest) latest = e;
    }
    return latest > earliest ? latest - earliest : 0;
  }, [entries]);

  const durationLabel =
    !anyRunning && totalDurationMs >= 1000 ? `${Math.round(totalDurationMs / 1000)}s` : '';

  const isContext = toolName === '__context__';
  const isResearch = toolName === '__research__';
  const isShell = useMemo(() => {
    return isShellActivityTool(entries[0]?.part.tool);
  }, [entries]);

  const headerLabel = useMemo(() => {
    if (isContext) {
      const s = contextToolSummary(entries.map((e) => e.part));
      const items: string[] = [];
      if (s.read > 0) items.push(`${s.read} read${s.read > 1 ? 's' : ''}`);
      if (s.search > 0) items.push(`${s.search} search${s.search > 1 ? 'es' : ''}`);
      if (s.list > 0) items.push(`${s.list} list${s.list > 1 ? 's' : ''}`);
      const summary = items.join(', ');
      const prefix = anyRunning ? 'Gathering context' : 'Gathered context';
      return summary ? `${prefix} · ${summary}` : prefix;
    }

    if (isResearch) {
      let searches = 0;
      let fetches = 0;
      let scrapes = 0;
      for (const { part } of entries) {
        const n = part.tool.replace(/^oc-/, '').replace(/-/g, '_');
        if (n === 'web_search' || n === 'websearch') searches++;
        else if (n === 'webfetch' || n === 'web_fetch') fetches++;
        else if (n === 'scrape' || n === 'scrape_webpage') scrapes++;
      }
      const items: string[] = [];
      if (searches > 0) items.push(`${searches} search${searches > 1 ? 'es' : ''}`);
      if (fetches > 0) items.push(`${fetches} fetch${fetches > 1 ? 'es' : ''}`);
      if (scrapes > 0) items.push(`${scrapes} scrape${scrapes > 1 ? 's' : ''}`);
      const summary = items.join(', ');
      const prefix = anyRunning ? 'Researching' : 'Researched';
      return summary ? `${prefix} · ${summary}` : `${prefix} · ${entries.length}x`;
    }

    if (isShell) {
      return shellActivityGroupLabel(entries.length, anyRunning);
    }

    const t = contextToolTrigger(entries[0].part);
    return `${t.title} · ${entries.length}x`;
  }, [isContext, isResearch, isShell, entries, anyRunning]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1.5 py-0.5',
            'cursor-pointer text-xs select-none',
            'text-muted-foreground/70',
            'group/grp max-w-full transition-colors',
          )}
        >
          {isResearch ? (
            <Globe
              className={cn(
                'text-muted-foreground/50 size-3.5 flex-shrink-0',
                anyRunning && 'animate-pulse-heartbeat',
              )}
            />
          ) : isShell ? (
            <Terminal
              className={cn(
                'text-muted-foreground/50 size-3.5 flex-shrink-0',
                anyRunning && 'animate-pulse-heartbeat',
              )}
            />
          ) : (
            <Search
              className={cn(
                'text-muted-foreground/50 size-3.5 flex-shrink-0',
                anyRunning && 'animate-pulse-heartbeat',
              )}
            />
          )}
          <span className="min-w-0 flex-1 truncate">{headerLabel}</span>
          {durationLabel && (
            <span className="text-muted-foreground/40 flex-shrink-0 font-mono text-xs tabular-nums">
              {durationLabel}
            </span>
          )}
          {anyRunning && (
            <Loader2 className="text-muted-foreground/40 size-3 flex-shrink-0 animate-spin" />
          )}
          <ChevronRight
            className={cn(
              'size-3 flex-shrink-0 transition-transform',
              'text-muted-foreground/30 opacity-0 group-hover/grp:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-border/30 mt-0.5 mb-1.5 ml-[7px] space-y-0.5 border-l pl-3">
          {isContext
            ? entries.map(({ part }) => {
                const t = contextToolTrigger(part);
                const running =
                  (part.state as any)?.status === 'pending' ||
                  (part.state as any)?.status === 'running';
                const s = (part.state as any)?.time?.start;
                const e = (part.state as any)?.time?.end;
                const dur = typeof s === 'number' && typeof e === 'number' && e > s ? e - s : 0;
                return (
                  <div
                    key={part.id}
                    className="text-muted-foreground/60 flex min-w-0 items-center gap-1.5 py-0.5 text-xs"
                  >
                    <span className="flex-shrink-0">{t.title}</span>
                    {!running && t.subtitle && (
                      <span
                        className="min-w-0 flex-1 truncate font-mono opacity-70"
                        title={t.subtitle}
                      >
                        {t.subtitle}
                      </span>
                    )}
                    {!running && dur >= 1000 && (
                      <span className="text-muted-foreground/40 ml-auto flex-shrink-0 font-mono text-xs tabular-nums">
                        {Math.round(dur / 1000)}s
                      </span>
                    )}
                    {running && (
                      <Loader2 className="text-muted-foreground/40 size-2.5 flex-shrink-0 animate-spin" />
                    )}
                  </div>
                );
              })
            : entries.map(({ part }) => (
                // Same-tool, non-context groups (e.g. 3x web_search) render
                // each call with its full ToolPartRenderer so users see real
                // results — answers, sources, images — not just the input arg.
                // Sits inside the rail's left padding (no negative margin) so
                // each row aligns under the group header label, matching the
                // reasoning block's nested treatment.
                <div key={part.id}>
                  <ToolPartRenderer
                    part={part}
                    sessionId={sessionId}
                    disableNavigation={disableNavigation}
                  />
                </div>
              ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// Session Turn — core turn component
// ============================================================================

interface SessionTurnProps {
  turn: Turn;
  allMessages: MessageWithParts[];
  sessionId: string;
  sessionStatus: import('@/ui').SessionStatus | undefined;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  agentNames?: string[];
  /** Whether this is the first turn in the session */
  isFirstTurn: boolean;
  /** Whether the session is busy */
  isBusy: boolean;
  /** Whether this turn contains a compaction */
  isCompaction?: boolean;
  /** Providers data for the Connect Provider dialog */
  providers?: ProviderListResponse;
  /** Map of user message IDs to command info for rendering command pills */
  commandMessages?: Map<string, { name: string; args?: string }>;
  /** Available commands for template prefix matching (page refresh detection) */
  commands?: Command[];
  /** Disable redirect-style tool navigation (used during onboarding) */
  disableToolNavigation?: boolean;
  /** Permission reply handler */
  onPermissionReply: (requestId: string, reply: 'once' | 'always' | 'reject') => Promise<void>;
}

function SessionTurn({
  turn,
  allMessages,
  sessionId,
  sessionStatus,
  permissions,
  questions,
  agentNames,
  isFirstTurn,
  isBusy,
  isCompaction,
  providers,
  commandMessages,
  commands,
  disableToolNavigation,
  onPermissionReply,
}: SessionTurnProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);
  const [userCopied, setUserCopied] = useState(false);
  const [connectProviderOpen, setConnectProviderOpen] = useState(false);
  const pricingLookup = useModelPricingLookup(providers);

  // Derived state from shared helpers
  const allParts = useMemo(() => collectTurnParts(turn), [turn]);
  // Check if there are visible steps that actually render inside the
  // collapsible steps section. Tool parts that are rendered elsewhere
  // (todowrite, task, question) don't count as "steps".
  const hasSteps = useMemo(() => {
    return allParts.some(({ part }) => {
      if (part.type === 'compaction' || part.type === 'snapshot' || part.type === 'patch')
        return true;
      if (isToolPart(part)) {
        if (part.tool === 'todowrite' || part.tool === 'task' || part.tool === 'question')
          return false;
        return shouldShowToolPart(part);
      }
      return false;
    });
  }, [allParts]);
  const hasReasoning = useMemo(
    () => allParts.some(({ part }) => isReasoningPart(part) && !!part.text?.trim()),
    [allParts],
  );
  const isLast = useMemo(
    () => isLastUserMessage(turn.userMessage.info.id, allMessages),
    [turn.userMessage.info.id, allMessages],
  );
  // A turn is "working" when:
  // 1. The session status says busy/retry (via getWorkingState), OR
  // 2. This is the last turn AND the parent component says isBusy (e.g. we
  //    just sent a message but sessionStatus hasn't updated to busy yet).
  //    This covers the race between sending and the server acknowledging.
  const working = useMemo(
    () => getWorkingState(sessionStatus, isLast) || (isLast && isBusy),
    [sessionStatus, isLast, isBusy],
  );
  const activeAssistantMessage = useMemo(() => {
    if (turn.assistantMessages.length === 0) return undefined;
    for (let i = turn.assistantMessages.length - 1; i >= 0; i--) {
      const msg = turn.assistantMessages[i];
      if (!(msg.info as any)?.time?.completed) return msg;
    }
    return turn.assistantMessages[turn.assistantMessages.length - 1];
  }, [turn.assistantMessages]);
  const streamingResponseRaw = useMemo(() => {
    if (!activeAssistantMessage) return '';
    return activeAssistantMessage.parts
      .filter(isTextPart)
      .map((p) => p.text ?? '')
      .join('');
  }, [activeAssistantMessage]);
  const lastTextPart = useMemo(() => findLastTextPart(allParts), [allParts]);
  const responseRaw = lastTextPart?.text ?? '';
  // Fallback: when aborted, collect ALL non-empty text parts if the
  // primary response is empty.  The last text part may have been lost
  // (timing between text-start and first text-delta) but earlier parts
  // might still have content.
  const abortedTextFallback = useMemo(() => {
    if (responseRaw) return ''; // primary response exists — no fallback needed
    // Only activate for aborted/errored turns
    const hasError = turn.assistantMessages.some((m) => (m.info as any).error);
    if (!hasError) return '';
    const texts: string[] = [];
    for (const { part } of allParts) {
      if (isTextPart(part) && part.text?.trim()) {
        texts.push(part.text);
      }
    }
    return texts.join('\n\n').trim();
  }, [responseRaw, allParts, turn.assistantMessages]);
  const completedTextParts = useMemo(
    () =>
      allParts
        .map(({ part }) => (isTextPart(part) ? part.text?.trim() : ''))
        .filter((text): text is string => Boolean(text)),
    [allParts],
  );
  const response = working
    ? streamingResponseRaw || responseRaw
    : !hasSteps && completedTextParts.length > 0
      ? completedTextParts.join('\n\n')
      : responseRaw.trim() || abortedTextFallback;
  // Retry info (only on last turn)
  const retryInfo = useMemo(
    () => (isLast ? getRetryInfo(sessionStatus) : undefined),
    [sessionStatus, isLast],
  );
  const retryMessage = useMemo(
    () => (isLast ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, isLast],
  );

  // Cost info (only when not working)
  const costInfo = useMemo(
    () => (!working ? getTurnCost(allParts, pricingLookup) : undefined),
    [allParts, working, pricingLookup],
  );

  // Turn error — derived directly from message data (same approach as SolidJS reference).
  // Falls back to checking for dismissed question tool errors when no message-level error exists.
  const turnError = useMemo(() => {
    const msgError = getTurnError(turn);
    if (msgError) return msgError;
    // Check for dismissed question tool errors
    for (const msg of turn.assistantMessages) {
      for (const part of msg.parts) {
        if (part.type !== 'tool') continue;
        const tool = part as ToolPart;
        if (tool.tool === 'question' && tool.state.status === 'error' && 'error' in tool.state) {
          return (tool.state as { error: string }).error.replace(/^Error:\s*/, '');
        }
      }
    }
    return undefined;
  }, [turn]);

  // Shell mode detection
  const shellModePart = useMemo(() => getShellModePart(turn), [turn]);

  // Permission matching for this session (used for tool-level permission overlays)
  const nextPermission = useMemo(
    () => permissions.filter((p) => p.sessionID === sessionId)[0],
    [permissions, sessionId],
  );

  // Question matching for this turn (used to pass to ToolPartRenderer for forceOpen/locked state)
  const nextQuestion = useMemo(() => {
    const sessionQuestions = questions.filter((q) => q.sessionID === sessionId);
    if (sessionQuestions.length === 0) return undefined;
    const turnMessageIds = new Set(turn.assistantMessages.map((m) => m.info.id));
    const matched = sessionQuestions.find((q) => q.tool && turnMessageIds.has(q.tool.messageID));
    if (matched) return matched;
    if (isLast) return sessionQuestions[0];
    return undefined;
  }, [questions, sessionId, turn.assistantMessages, isLast]);

  // Hidden tool parts (when permission/question is active)
  const hidden = useMemo(
    () => getHiddenToolParts(nextPermission, nextQuestion),
    [nextPermission, nextQuestion],
  );

  // Answered question parts — shown inline alongside streamed text.
  // Uses the optimisticAnswersCache as a fallback: when the user answers a
  // question we cache {answers, input} immediately. SSE message.part.updated
  // events can overwrite the tool part's state (wiping metadata.answers)
  // before the server has merged them. By checking the cache we guarantee
  // the answered card stays visible regardless of SSE timing.
  // Only skip tool parts whose callID matches a currently-pending question.
  const answeredQuestionParts = useMemo(() => {
    const pendingCallIds = new Set(
      questions
        .filter((q) => q.sessionID === sessionId)
        .map((q) => q.tool?.callID)
        .filter(Boolean),
    );

    // Collect ALL question tool parts first so we can determine which ones
    // were implicitly answered (i.e. the assistant continued past them).
    const questionInfos: {
      tool: ToolPart;
      msgId: string;
      msgIndex: number;
      partIndex: number;
    }[] = [];
    for (let mi = 0; mi < turn.assistantMessages.length; mi++) {
      const msg = turn.assistantMessages[mi];
      for (let pi = 0; pi < msg.parts.length; pi++) {
        const part = msg.parts[pi];
        if (part.type !== 'tool') continue;
        const tool = part as ToolPart;
        if (tool.tool !== 'question') continue;
        questionInfos.push({
          tool,
          msgId: msg.info.id,
          msgIndex: mi,
          partIndex: pi,
        });
      }
    }

    const result: { part: ToolPart; messageId: string }[] = [];
    for (const qInfo of questionInfos) {
      const { tool, msgId, msgIndex, partIndex } = qInfo;

      // Check if there are subsequent parts/messages AFTER this question
      // in the turn. If the assistant continued, this question was answered.
      const hasSubsequentContent = (() => {
        // Check for later parts in the same message
        const msg = turn.assistantMessages[msgIndex];
        for (let pi = partIndex + 1; pi < msg.parts.length; pi++) {
          const p = msg.parts[pi];
          if (p.type === 'step-finish' || p.type === 'step-start') continue;
          return true;
        }
        // Check for later messages in the turn
        return msgIndex < turn.assistantMessages.length - 1;
      })();

      const isPending = pendingCallIds.has(tool.callID);

      // Skip only if it IS the currently-pending question AND there's no
      // evidence it was already answered (no subsequent content).
      if (isPending && !hasSubsequentContent) continue;

      const serverAnswers = (tool.state as any)?.metadata?.answers;
      const cached = optimisticAnswersCache.get(tool.id);
      const toolOutput = (tool.state as any)?.output as string | undefined;

      if (serverAnswers && serverAnswers.length > 0) {
        // Server has real answers — clean up cache if present
        if (cached) optimisticAnswersCache.delete(tool.id);
        result.push({ part: tool, messageId: msgId });
      } else if (cached) {
        // Server hasn't confirmed yet — use cached answers.
        // Build a synthetic tool part with the cached data so
        // AnsweredQuestionCard can render.
        const syntheticPart = {
          ...tool,
          state: {
            ...(tool.state as any),
            status: 'completed',
            input: cached.input,
            metadata: {
              ...((tool.state as any)?.metadata ?? {}),
              answers: cached.answers,
            },
          },
        } as unknown as ToolPart;
        result.push({ part: syntheticPart, messageId: msgId });
      } else if (toolOutput && hasSubsequentContent) {
        // Question was answered (output exists and assistant continued)
        // but metadata.answers was never set (e.g. after page reload).
        // Parse answers from the output string as a fallback.
        const parsed = parseAnswersFromOutput(toolOutput, (tool.state as any)?.input);
        if (parsed) {
          const syntheticPart = {
            ...tool,
            state: {
              ...(tool.state as any),
              status: 'completed',
              metadata: {
                ...((tool.state as any)?.metadata ?? {}),
                answers: parsed,
              },
            },
          } as unknown as ToolPart;
          result.push({ part: syntheticPart, messageId: msgId });
        }
      } else if (!toolOutput && hasSubsequentContent) {
        // Question was implicitly answered (assistant continued past it)
        // but neither metadata.answers nor output is available.
        // Show a minimal answered card using the input questions
        // with placeholder answers extracted from context.
        const input = (tool.state as any)?.input;
        const questionsList: { question: string }[] = Array.isArray(input?.questions)
          ? input.questions
          : [];
        if (questionsList.length > 0) {
          const placeholderAnswers = questionsList.map(() => ['Answered']);
          const syntheticPart = {
            ...tool,
            state: {
              ...(tool.state as any),
              status: 'completed',
              metadata: {
                ...((tool.state as any)?.metadata ?? {}),
                answers: placeholderAnswers,
              },
            },
          } as unknown as ToolPart;
          result.push({ part: syntheticPart, messageId: msgId });
        }
      }
    }
    return result;
  }, [questions, sessionId, turn.assistantMessages]);
  const answeredQuestionIds = useMemo(
    () => new Set(answeredQuestionParts.map(({ part }) => part.id)),
    [answeredQuestionParts],
  );

  // Inline content parts — interleaves text and answered question parts in natural order.
  // When a turn contains answered questions, we need to render text and questions
  // in their original order rather than extracting the last text as a separate "response".
  // This works both during streaming and after completion so that answered questions
  // stay in the correct position while the AI continues responding.
  // Important: for question parts we use the (possibly synthetic) part from
  // answeredQuestionParts — NOT the raw store part — so that optimistic
  // answers from the cache are included even if the server hasn't confirmed yet.
  const answeredQuestionPartsById = useMemo(
    () => new Map(answeredQuestionParts.map(({ part }) => [part.id, part])),
    [answeredQuestionParts],
  );
  const inlineContentParts = useMemo(() => {
    if (answeredQuestionParts.length === 0) return null;
    const items: Array<
      | { type: 'text'; part: TextPart; id: string }
      | { type: 'question'; part: ToolPart; id: string }
    > = [];
    for (const { part } of allParts) {
      if (isTextPart(part) && part.text?.trim()) {
        items.push({ type: 'text', part, id: part.id });
      } else if (
        isToolPart(part) &&
        part.tool === 'question' &&
        answeredQuestionPartsById.has(part.id)
      ) {
        // Use the answered part (may be synthetic with cached answers)
        items.push({
          type: 'question',
          part: answeredQuestionPartsById.get(part.id)!,
          id: part.id,
        });
      }
    }
    // Only use inline rendering if there are both text and question items
    const hasText = items.some((i) => i.type === 'text');
    const hasQuestion = items.some((i) => i.type === 'question');
    if (!hasText || !hasQuestion) return null;
    return items;
  }, [allParts, answeredQuestionPartsById, answeredQuestionParts.length]);
  const shouldUseInlineContent = !hasSteps && !!inlineContentParts;

  // Whether the user message has any visible content (non-synthetic, non-ignored
  // text, or attachments). Background task notifications inject synthetic-only
  // user messages that should not render a user bubble.
  // Extract session report from user message (if present)
  const sessionReport = useMemo<SessionReport | null>(() => {
    for (const p of turn.userMessage.parts) {
      if (isTextPart(p)) {
        const report = extractSessionReport((p as TextPart).text || '');
        if (report) return report;
      }
    }
    return null;
  }, [turn.userMessage.parts]);
  const [sessionReportModalOpen, setSessionReportModalOpen] = useState(false);

  // Extract kortix_system messages for inline rendering (goal continuations, etc.)
  const systemMessages = useMemo<KortixSystemMessage[]>(() => {
    const msgs: KortixSystemMessage[] = [];
    for (const p of turn.userMessage.parts) {
      if (isTextPart(p) && (p as TextPart).text) {
        msgs.push(...extractKortixSystemMessages((p as TextPart).text!));
      }
    }
    return msgs;
  }, [turn.userMessage.parts]);

  const hasVisibleUserContent = useMemo(() => {
    // Session reports render as their own card — don't show as user bubble
    if (sessionReport) return false;
    const parts = turn.userMessage.parts;
    // Parts not loaded yet (bridging / transient state) — assume visible
    // to prevent a flash where the bubble disappears momentarily.
    if (parts.length === 0) return true;
    // Has any non-synthetic, non-ignored text (including notification XML)?
    const hasVisibleText = parts.some(
      (p) =>
        isTextPart(p) &&
        !(p as TextPart).synthetic &&
        !(p as any).ignored &&
        !!stripKortixSystemTags((p as TextPart).text || '').trim(),
    );
    if (hasVisibleText) return true;
    // Has any attachment (image/PDF)?
    if (parts.some(isAttachment)) return true;
    // Has any agent part?
    if (parts.some(isAgentPart)) return true;
    return false;
  }, [turn.userMessage.parts, sessionReport]);

  // User message text — for copy action
  const userMessageText = useMemo(() => {
    const textParts = turn.userMessage.parts.filter(
      (p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored,
    ) as TextPart[];
    return textParts
      .map((p) => stripSystemPtyText(p.text))
      .filter((t) => t.trim())
      .join('\n')
      .trim();
  }, [turn.userMessage.parts]);

  const commandForTurn = useMemo(() => {
    const mapped = commandMessages?.get(turn.userMessage.info.id);
    if (mapped) return mapped;
    if (!userMessageText) return undefined;
    return detectCommandFromText(userMessageText, commands);
  }, [commandMessages, turn.userMessage.info.id, userMessageText, commands]);

  const handleCopyUser = async () => {
    if (!userMessageText) return;
    await navigator.clipboard.writeText(userMessageText);
    setUserCopied(true);
    setTimeout(() => setUserCopied(false), 2000);
  };

  // ---- Status throttling (2.5s) ----
  const lastStatusChangeRef = useRef(Date.now());
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const childMessages = undefined as MessageWithParts[] | undefined; // placeholder for child session delegation
  const rawStatus = useMemo(
    () => getTurnStatus(allParts, childMessages),
    [allParts, childMessages],
  );
  const [throttledStatus, setThrottledStatus] = useState('');

  useEffect(() => {
    const newStatus = rawStatus;
    if (newStatus === throttledStatus || !newStatus) return;
    const elapsed = Date.now() - lastStatusChangeRef.current;
    if (elapsed >= 2500) {
      setThrottledStatus(newStatus);
      lastStatusChangeRef.current = Date.now();
    } else {
      clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = setTimeout(() => {
        setThrottledStatus(getTurnStatus(allParts, childMessages));
        lastStatusChangeRef.current = Date.now();
      }, 2500 - elapsed);
    }
    return () => clearTimeout(statusTimeoutRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParts, rawStatus, throttledStatus]);

  // ---- Retry countdown ----
  const [retrySecondsLeft, setRetrySecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryInfo) {
      setRetrySecondsLeft(0);
      return;
    }
    const update = () =>
      setRetrySecondsLeft(Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [retryInfo]);

  // ---- Duration ticking ----
  const [duration, setDuration] = useState('');
  useEffect(() => {
    const startTime = (turn.userMessage.info as any)?.time?.created;
    if (!startTime) return;

    if (!working) {
      const lastMsg = turn.assistantMessages[turn.assistantMessages.length - 1];
      const endTime =
        (lastMsg?.info as any)?.time?.completed ||
        (lastMsg?.info as any)?.time?.created ||
        startTime;
      setDuration(formatDuration(endTime - startTime));
      return;
    }
    const update = () => setDuration(formatDuration(Date.now() - startTime));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [working, turn]);

  // ---- Copy response ----
  const handleCopy = async () => {
    // When inline content is active, copy all text parts (not just the last one)
    const textToCopy = inlineContentParts
      ? inlineContentParts
          .filter((item) => item.type === 'text')
          .map((item) => (item.part as TextPart).text?.trim())
          .filter(Boolean)
          .join('\n\n')
      : response;
    if (!textToCopy) return;
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ============================================================================
  // Shell mode — short-circuit rendering
  // ============================================================================

  if (shellModePart) {
    return (
      <div className="space-y-1">
        <ToolPartRenderer
          part={shellModePart}
          sessionId={sessionId}
          disableNavigation={disableToolNavigation}
          permission={nextPermission?.tool ? nextPermission : undefined}
          onPermissionReply={onPermissionReply}
          defaultOpen
        />
        {turnError && <TurnErrorDisplay errorText={turnError} className="mt-2" />}
        <ConnectProviderDialog
          open={connectProviderOpen}
          onOpenChange={setConnectProviderOpen}
          providers={providers}
        />
      </div>
    );
  }

  // ============================================================================
  // Compaction mode — render as a distinct card, no user bubble / logo / steps
  // ============================================================================

  if (isCompaction && !working && response) {
    return (
      <div className="group/turn">
        <div className="border-border/60 bg-card/50 overflow-hidden rounded-2xl border">
          <div className="border-border/40 bg-muted/40 flex items-center gap-2 border-b px-4 py-2.5">
            <Layers className="text-muted-foreground/70 size-3.5" />
            <span className="text-muted-foreground/70 text-xs font-medium tracking-wider uppercase">
              Compaction
            </span>
          </div>
          <div className="text-muted-foreground/90 [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_strong]:text-foreground/90 px-4 py-3 text-sm">
            <SandboxUrlDetector content={response} isStreaming={false} />
          </div>
        </div>
      </div>
    );
  }

  // ============================================================================
  // Normal mode rendering — 1:1 port of SolidJS session-turn.tsx
  //
  // Structure:
  //   1. User message + actions
  //   2. Kortix logo
  //   3. Steps trigger (spinner/chevron + status + duration) — if working || hasSteps
  //   4. Collapsible steps (if expanded): all parts EXCEPT response part
  //   5. Answered question parts (if collapsed + has answered questions)
  //   6. Response section (ONLY when NOT working) — the extracted last text part
  //   7. Error (when steps collapsed)
  //   8. Question prompt
  //   9. Action bar (copy)
  //
  // The response (last text part) is NEVER rendered twice:
  //   - While working: it renders INSIDE steps as a regular text part (hideResponsePart=false)
  //   - When done: it's HIDDEN from steps (hideResponsePart=true) and shown below as Response
  // ============================================================================

  return (
    <div className="group/turn space-y-3">
      {/* ── Session report card — clickable, opens worker session modal ── */}
      {sessionReport && (
        <>
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSessionReportModalOpen(true)}
            onKeyDown={(e) => e.key === 'Enter' && setSessionReportModalOpen(true)}
            className={cn(
              'flex items-center gap-2 rounded-2xl px-3 py-2 text-xs',
              'group/report cursor-pointer border transition-colors select-none',
              sessionReport.status === 'COMPLETE'
                ? cn(STATUS_BG.success, STATUS_BORDER.success, 'hover:bg-emerald-500/15')
                : 'bg-destructive/5 border-destructive/20 hover:bg-destructive/10',
            )}
          >
            {sessionReport.status === 'COMPLETE' ? (
              <CheckCircle className={cn('size-3.5 flex-shrink-0', STATUS_TEXT.success)} />
            ) : (
              <AlertTriangle className="text-destructive size-3.5 flex-shrink-0" />
            )}
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span
                className={cn(
                  'font-medium',
                  sessionReport.status === 'COMPLETE' ? STATUS_TEXT.success : 'text-destructive',
                )}
              >
                Worker {sessionReport.status === 'COMPLETE' ? 'Complete' : 'Failed'}
              </span>
              {sessionReport.project && (
                <span className="text-muted-foreground/60">· {sessionReport.project}</span>
              )}
              {sessionReport.prompt && (
                <span className="text-muted-foreground/40 truncate">
                  {sessionReport.prompt.slice(0, 60)}
                </span>
              )}
            </div>
            <ExternalLink className="text-muted-foreground/30 group-hover/report:text-muted-foreground/60 size-3 flex-shrink-0 transition-colors" />
          </div>
          <SubSessionModal
            open={sessionReportModalOpen}
            onOpenChange={setSessionReportModalOpen}
            sessionId={sessionReport.sessionId}
            title={`Worker${sessionReport.project ? ` · ${sessionReport.project}` : ''}`}
          />
        </>
      )}

      {/* ── System message indicator — shown for kortix_system-only messages ── */}
      {!hasVisibleUserContent && !sessionReport && systemMessages.length > 0 && (
        <SystemMessageIndicator messages={systemMessages} />
      )}

      {/* ── User message ── */}
      {/* Hide the user bubble when the user message has no visible content
			    (e.g. background task notification with only synthetic parts). */}
      {hasVisibleUserContent && (
        <div>
          <UserMessageRow
            message={turn.userMessage}
            agentNames={agentNames}
            commandInfo={commandMessages?.get(turn.userMessage.info.id)}
            commands={commands}
          />
          {userMessageText && (
            <div className="mt-1 flex justify-end opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={handleCopyUser}>
                    {userCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{userCopied ? 'Copied!' : 'Copy'}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      )}

      {/* Kortix logo header */}
      {(working || hasSteps || hasReasoning) && (
        <div className="mt-3 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/kortix-logomark-white.svg"
            alt="Kortix"
            className="h-[14px] w-auto flex-shrink-0 invert dark:invert-0"
          />
        </div>
      )}

      {/* ── Assistant parts content ──
			  Renders ALL parts from all assistant messages,
			  EXCEPT: the response part (last text) is hidden when not working
			  (it renders separately below as the Response section). */}
      {(working || hasSteps || hasReasoning) && turn.assistantMessages.length > 0 && (
        <div className="space-y-2">
          {(() => {
            // Same-tool grouping: consecutive calls of the SAME tool
            // (e.g. 5 reads, 3 greps) fold into one collapsible.
            // Singles stay individual. Reasoning groups separately.
            // ALL tool rows get a left border rail for visual separation.
            type ToolEntry = { part: ToolPart; message: MessageWithParts };
            type RenderItem =
              | { type: 'part'; part: Part; message: MessageWithParts }
              | { type: 'reasoning-group'; parts: ReasoningPart[]; key: string }
              | { type: 'tool-group'; toolName: string; entries: ToolEntry[]; key: string }
              | { type: 'tool-single'; part: ToolPart; message: MessageWithParts };

            const items: RenderItem[] = [];
            let pendingReasoning: ReasoningPart[] = [];
            let pendingTools: ToolEntry[] = [];
            let pendingToolName: string | null = null;

            const flushReasoning = () => {
              if (pendingReasoning.length > 0) {
                items.push({
                  type: 'reasoning-group',
                  parts: pendingReasoning,
                  key: `reasoning-${(pendingReasoning[0] as any).id ?? items.length}`,
                });
                pendingReasoning = [];
              }
            };

            const flushTools = () => {
              if (pendingTools.length >= 2 && pendingToolName) {
                items.push({
                  type: 'tool-group',
                  toolName: pendingToolName,
                  entries: pendingTools,
                  key: `tg-${pendingTools[0].part.id}`,
                });
              } else if (pendingTools.length === 1) {
                items.push({
                  type: 'tool-single',
                  part: pendingTools[0].part,
                  message: pendingTools[0].message,
                });
              }
              pendingTools = [];
              pendingToolName = null;
            };

            // Normalize tool name for grouping.
            //   __context__ — read/glob/grep/list collapse into one
            //                "Gathered context" pile (compact one-liners).
            //   __research__ — web_search / webfetch / scrape collapse into
            //                  one "Research" pile (full results expanded).
            // Same-tool runs (e.g. 3× apply_patch, 3× edit) group naturally
            // by their normalized tool name and render full per-call results.
            const CONTEXT_SET = new Set(['read', 'glob', 'grep', 'list']);
            const RESEARCH_SET = new Set([
              'web_search',
              'websearch',
              'webfetch',
              'web_fetch',
              'scrape',
              'scrape_webpage',
            ]);
            const norm = (t: string) => {
              const n = t.replace(/^oc-/, '').replace(/-/g, '_');
              if (CONTEXT_SET.has(n)) return '__context__';
              if (RESEARCH_SET.has(n)) return '__research__';
              return n;
            };

            for (const { part, message } of allParts) {
              if (isReasoningPart(part)) {
                if (part.text?.trim()) {
                  flushTools();
                  pendingReasoning.push(part);
                }
                continue;
              }
              // Render-nothing parts (blank text, internal snapshot/patch
              // bookkeeping) must not split a run of groupable tools — otherwise
              // consecutive shells fragment into inconsistent singles instead of
              // one "Ran N commands" group.
              if (isInvisibleActivityPart(part)) continue;
              flushReasoning();

              if (isToolPart(part)) {
                const tp = part as ToolPart;
                const hasPermission = !!getPermissionForTool(permissions, tp.callID);
                const groupable =
                  shouldShowToolPart(tp) &&
                  tp.tool !== 'todowrite' &&
                  tp.tool !== 'question' &&
                  !isNoGroupActivityTool(tp.tool) &&
                  !hasPermission &&
                  !isToolPartHidden(tp, message.info.id, hidden);

                if (groupable) {
                  const n = norm(tp.tool);
                  if (pendingToolName === n) {
                    pendingTools.push({ part: tp, message });
                  } else {
                    flushTools();
                    pendingToolName = n;
                    pendingTools = [{ part: tp, message }];
                  }
                  continue;
                }
              }

              flushTools();
              items.push({ type: 'part', part, message });
            }
            flushReasoning();
            flushTools();

            const reasoningActive = working && permissions.length === 0 && questions.length === 0;

            return items.map((item) => {
              // Reasoning group
              if (item.type === 'reasoning-group') {
                return (
                  <div key={item.key}>
                    <GroupedReasoningCard parts={item.parts} isStreaming={reasoningActive} />
                  </div>
                );
              }

              // Same-tool group (2+ consecutive)
              if (item.type === 'tool-group') {
                return (
                  <div key={item.key}>
                    <SameToolGroup
                      toolName={item.toolName}
                      entries={item.entries}
                      sessionId={sessionId}
                      disableNavigation={disableToolNavigation}
                      busy={working}
                    />
                  </div>
                );
              }

              // Single tool (with left rail)
              if (item.type === 'tool-single') {
                if (!shouldShowToolPart(item.part)) return null;
                const perm = getPermissionForTool(permissions, item.part.callID);
                if (isToolPartHidden(item.part, item.message.info.id, hidden)) return null;
                return (
                  <div key={item.part.id}>
                    <ToolPartRenderer
                      part={item.part}
                      sessionId={sessionId}
                      disableNavigation={disableToolNavigation}
                      permission={perm}
                      onPermissionReply={onPermissionReply}
                    />
                  </div>
                );
              }

              const { part, message } = item;

              // When inline content rendering is active (text + answered questions in order),
              // hide ALL text parts from steps since they render in the inline section
              if (shouldUseInlineContent && isTextPart(part) && part.text?.trim()) return null;

              // Text parts (intermediate + streaming response while working)
              if (isTextPart(part)) {
                if (!part.text?.trim()) return null;
                // Text response rendering for no-step turns is handled below in
                // the dedicated response section to avoid duplicate output.
                if (!hasSteps) return null;
                return (
                  <div key={part.id} className="min-w-0 text-sm">
                    <ThrottledMarkdown content={part.text} isStreaming={working} />
                  </div>
                );
              }

              // Compaction indicator
              if (isCompactionPart(part)) {
                return (
                  <div key={part.id} className="flex items-center gap-2 py-2.5">
                    <div className="bg-border h-px flex-1" />
                    <div className="bg-muted/80 border-border/60 flex items-center gap-1.5 rounded-2xl border px-2.5 py-1">
                      <Layers className="text-muted-foreground size-3" />
                      <span className="text-muted-foreground text-xs font-semibold tracking-wide">
                        Compaction
                      </span>
                    </div>
                    <div className="bg-border h-px flex-1" />
                  </div>
                );
              }

              // Tool parts
              if (isToolPart(part)) {
                if (!shouldShowToolPart(part)) return null;
                if (part.tool === 'todowrite') return null;
                if (part.tool === 'question') {
                  // When inline content rendering is active, answered questions
                  // render in the inline content section — skip here to avoid duplicates.
                  if (shouldUseInlineContent) return null;
                  // Render answered questions inline at their natural position
                  // so they appear exactly where the user answered them.
                  const answeredPart = answeredQuestionPartsById.get(part.id);
                  if (answeredPart) {
                    return (
                      <AnsweredQuestionCard key={part.id} part={answeredPart} defaultExpanded />
                    );
                  }
                  // Unanswered/dismissed questions: don't render in steps;
                  // dismissed ones show via the turnError banner.
                  return null;
                }

                const perm = getPermissionForTool(permissions, part.callID);

                // Hide tool parts that have active permission
                if (isToolPartHidden(part, message.info.id, hidden)) return null;

                return (
                  <div key={part.id}>
                    <ToolPartRenderer
                      part={part}
                      sessionId={sessionId}
                      disableNavigation={disableToolNavigation}
                      permission={perm}
                      onPermissionReply={onPermissionReply}
                    />
                  </div>
                );
              }

              // Snapshot & patch parts — internal bookkeeping, not rendered in chat
              if (isSnapshotPart(part) || isPatchPart(part)) {
                return null;
              }

              return null;
            });
          })()}
        </div>
      )}

      {/* Kortix logo — shown when there are no steps and not working (otherwise logo is already above the steps trigger) */}
      {!hasSteps &&
        !hasReasoning &&
        !working &&
        (response || answeredQuestionParts.length > 0 || turnError) && (
          <div className="mt-3 mb-3 flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/kortix-logomark-white.svg"
              alt="Kortix"
              className="h-[14px] w-auto flex-shrink-0 invert dark:invert-0"
            />
          </div>
        )}

      {/* ── Screen reader ── */}
      <div className="sr-only" aria-live="polite">
        {!working && response ? response : ''}
      </div>

      {/* Inline content: text and answered questions rendered in natural order.
			    Works both during streaming and after completion. */}
      {working && !hasSteps && !shouldUseInlineContent && response && (
        <div className="min-w-0 text-sm">
          <ThrottledMarkdown content={response} isStreaming />
        </div>
      )}
      {shouldUseInlineContent ? (
        <div className="space-y-3">
          {(() => {
            // Find the last text item index — it might still be streaming
            let lastTextIdx = -1;
            if (working) {
              for (let i = inlineContentParts!.length - 1; i >= 0; i--) {
                if (inlineContentParts![i].type === 'text') {
                  lastTextIdx = i;
                  break;
                }
              }
            }
            return inlineContentParts!.map((item, idx) => {
              if (item.type === 'text') {
                const isStreaming = idx === lastTextIdx;
                const text = isStreaming ? item.part.text! : item.part.text!.trim();
                return (
                  <div key={item.id} className="min-w-0 text-sm">
                    {isStreaming ? (
                      <ThrottledMarkdown content={text} isStreaming />
                    ) : (
                      <SandboxUrlDetector content={text} isStreaming={false} />
                    )}
                  </div>
                );
              }
              return <AnsweredQuestionCard key={item.id} part={item.part} defaultExpanded />;
            });
          })()}
        </div>
      ) : (
        <>
          {/* Response section for text-only turns (no tools/steps content) */}
          {!working &&
            !hasSteps &&
            response &&
            (commandForTurn ? (
              <div className="border-border/60 from-muted/15 to-background overflow-hidden rounded-2xl border bg-gradient-to-b">
                <div className="border-border/50 bg-muted/25 flex items-center gap-2 border-b px-3 py-2">
                  <Terminal className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="text-foreground font-mono text-xs">/{commandForTurn.name}</span>
                  {commandForTurn.args && (
                    <span className="text-muted-foreground truncate text-xs">
                      {commandForTurn.args}
                    </span>
                  )}
                </div>
                <div className="px-3 py-2.5 text-sm">
                  <SandboxUrlDetector content={response} isStreaming={false} />
                </div>
              </div>
            ) : (
              <div className="text-sm">
                <SandboxUrlDetector content={response} isStreaming={false} />
              </div>
            ))}

          {/* Answered question parts — shown after the response text only when
				    NONE of the upstream renderers fire. The steps section above is
				    gated by `working || hasSteps || hasReasoning`; if any of those
				    is true, the question parts have already been rendered inline
				    there as AnsweredQuestionCards. Mirroring that guard's inverse
				    here is the only way to avoid the double-render that showed up
				    on interrupted sessions that contained reasoning but no tool
				    steps (e.g. "Planning a process for questions" → user answers
				    → interrupt; hasSteps=false, working=false, hasReasoning=true,
				    and without the !hasReasoning check the card rendered twice). */}
          {!hasSteps && !working && !hasReasoning && answeredQuestionParts.length > 0 && (
            <div className="mt-3 space-y-2">
              {answeredQuestionParts.map(({ part }) => (
                <AnsweredQuestionCard key={part.id} part={part as ToolPart} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Working status indicator (always at the end while working) ── */}
      {working && (
        <div className="space-y-2">
          {retryInfo && retryMessage && (
            <SessionRetryDisplay
              message={retryMessage}
              attempt={retryInfo.attempt}
              secondsLeft={retrySecondsLeft}
            />
          )}
          <div
            className={cn(
              'flex items-center gap-2 py-1 text-xs transition-colors',
              'text-muted-foreground',
            )}
          >
            <span className="relative flex size-3">
              <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
              <span className="bg-muted-foreground/50 relative inline-flex size-3 rounded-full" />
            </span>
            {retryInfo ? (
              <span className="text-muted-foreground/70">
                {tHardcodedUi.raw('componentsSessionSessionChat.line3820JsxTextWaitingToRetry')}
              </span>
            ) : (
              <AnimatedThinkingText statusText={throttledStatus || undefined} className="text-xs" />
            )}
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground/70">{duration}</span>
          </div>
        </div>
      )}

      {/* ── Error (abort / failure banner) ── */}
      {turnError && <TurnErrorDisplay errorText={turnError} />}

      {/* Question prompt — now rendered inside the chat input card (questionSlot) */}

      {/* ── Action bar (copy + duration/cost only) ── */}
      {!working && response && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
          {/* Duration & cost */}
          {duration && (
            <span className="text-muted-foreground/50 mr-1 text-xs">
              {duration}
              {costInfo && (
                <>
                  {' '}
                  · {formatCost(costInfo.cost)} ·{' '}
                  {formatTokens(costInfo.tokens.input + costInfo.tokens.output)}t
                </>
              )}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={handleCopy}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? 'Copied!' : 'Copy'}</TooltipContent>
          </Tooltip>
        </div>
      )}

      <ConnectProviderDialog
        open={connectProviderOpen}
        onOpenChange={setConnectProviderOpen}
        providers={providers}
      />
    </div>
  );
}

// ============================================================================
// Main SessionChat Component
// ============================================================================

interface SessionChatProps {
  sessionId: string;
  /** Project id lets agent pickers use the server-side project manifest/catalog. */
  projectId?: string;
  /** Immutable project-session agent. When set, prompts are locked to this agent. */
  boundAgentName?: string | null;
  /** Optional element rendered at the leading (left) edge of the session header */
  headerLeadingAction?: React.ReactNode;
  /** Hide the session site header entirely */
  hideHeader?: boolean;
  /** Read-only mode — hides the chat input bar (used for sub-session modal viewer) */
  readOnly?: boolean;
  /** Start scrolled to the top instead of the bottom (e.g. sub-session modal viewer) */
  initialScrollTop?: boolean;
}

export function SessionChat({
  sessionId,
  projectId,
  boundAgentName,
  headerLeadingAction,
  hideHeader,
  readOnly,
  initialScrollTop,
}: SessionChatProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const onboardingActive = useOnboardingModeStore((s) => s.active);
  const onboardingSessionId = useOnboardingModeStore((s) => s.sessionId);
  const disableToolNavigation = onboardingActive && onboardingSessionId === sessionId;
  // Every open session tab is pre-mounted at once (see layout-content.tsx), so
  // only the visible tab may be treated as "active" — otherwise every busy
  // session would react to global shortcuts (ESC-to-stop, auto question
  // handling) at the same time. The standalone project session route
  // (/projects/[id]/sessions/[sessionId]) mounts a single SessionChat whose id
  // is never registered in this tab store; there it's the only chat mounted, so
  // it's always active.
  //
  // Subscribe to the BOOLEAN result rather than the raw activeTabId value: a
  // tab switch then only re-renders the two sessions whose active state flips,
  // not every mounted SessionChat. This is what keeps tab switching 0-latency.
  const isActiveSessionTab = useTabStore((s) =>
    s.tabs[sessionId] ? s.activeTabId === sessionId : true,
  );

  // Clicking a tool call in the chat opens the side panel (Actions view)
  // focused on that tool's large preview — instead of expanding inline.
  const focusToolCall = useKortixComputerStore((s) => s.focusToolCall);
  const setSidePanelView = useSessionBrowserStore((s) => s.setView);
  const handleToolActivate = useCallback(
    (callID: string) => {
      setSidePanelView(sessionId, 'actions');
      focusToolCall(callID);
    },
    [sessionId, setSidePanelView, focusToolCall],
  );
  const toolActivate = readOnly || disableToolNavigation ? null : handleToolActivate;

  // ---- Context modal ----
  const [contextModalOpen, setContextModalOpen] = useState(false);

  // ---- Question prompt ref + action state (for unified send button) ----
  const questionPromptRef = useRef<QuestionPromptHandle>(null);
  const [questionAction, setQuestionAction] = useState<{
    label: string | null;
    canAct: boolean;
  }>({ label: null, canAct: true });
  const handleQuestionActionChange = useCallback((action: QuestionAction, canAct: boolean) => {
    const label = action === 'next' ? 'Next' : action === 'submit' ? 'Submit' : null;
    setQuestionAction({ label, canAct });
  }, []);

  // ---- Reply-to state (text selection → reply) ----
  const [replyTo, setReplyTo] = useState<ReplyToContext | null>(null);
  const handleClearReply = useCallback(() => setReplyTo(null), []);

  // Floating "Reply" popup — shown near selected text in the chat area
  const [selectionPopup, setSelectionPopup] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);

  // On mouseup inside the chat area, check for text selection
  const handleChatMouseUp = useCallback(() => {
    // Small delay so the selection is finalized
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const selectedText = sel?.toString().trim();
      if (!selectedText || selectedText.length < 2) {
        setSelectionPopup(null);
        return;
      }
      // Make sure the selection is inside the chat area
      if (!sel?.rangeCount || !chatAreaRef.current?.contains(sel.anchorNode)) {
        setSelectionPopup(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const containerRect = chatAreaRef.current.getBoundingClientRect();
      setSelectionPopup({
        x: rect.left + rect.width / 2 - containerRect.left,
        y: rect.top - containerRect.top - 8,
        text: selectedText.slice(0, 500),
      });
    });
  }, []);

  // Dismiss popup on mousedown (new click) unless clicking the popup itself
  const handleChatMouseDown = useCallback((e: React.MouseEvent) => {
    // If clicking inside the popup, don't dismiss
    const target = e.target as HTMLElement;
    if (target.closest('[data-reply-popup]')) return;
    setSelectionPopup(null);
  }, []);

  // Dismiss popup on scroll
  const handleChatScroll = useCallback(() => {
    setSelectionPopup(null);
  }, []);

  // When user clicks "Reply" in the popup
  const handleSelectionReply = useCallback(() => {
    if (!selectionPopup) return;
    setReplyTo({ text: selectionPopup.text });
    setSelectionPopup(null);
    window.getSelection()?.removeAllRanges();
  }, [selectionPopup]);

  // ---- KortixComputer side panel ----
  const { isSidePanelOpen, setIsSidePanelOpen, openFileInComputer } = useKortixComputerStore();
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const handleTogglePanel = useCallback(() => {
    setIsSidePanelOpen(!isSidePanelOpen);
  }, [isSidePanelOpen, setIsSidePanelOpen]);

  // ---- Hooks ----
  // runtimeReady gates the session query (it's disabled until the sandbox
  // runtime is connected + healthy). We need it here too so the render logic
  // can tell "still booting" apart from "genuinely gone".
  const runtimeReady = useRuntimeReady();
  const { data: session, isFetched: sessionFetched } = useRuntimeSession(sessionId);
  // useSessionSync is the SINGLE source of truth for messages (matches Runtime SolidJS).
  // It fetches on first access, then SSE events keep it up to date.
  // No React Query fallback — prevents stale refetches from overwriting live data.
  const { messages: syncMessages, isLoading: syncMessagesLoading } = useSessionSync(sessionId);
  const messages = syncMessages.length > 0 ? syncMessages : undefined;
  const messagesLoading = syncMessagesLoading;
  // Project sessions use the server-side project agent roster. Non-project
  // sessions fall back to Runtime's directory-scoped runtime discovery.
  const { data: agents } = useRuntimeAgents({ directory: session?.directory, projectId });
  // Pending connector-approvals for this session pause the run — lock the
  // composer (like a question) until they're resolved. Shares the query key with
  // SessionApprovalPrompt, so it's one request.
  const approvalRouteParams = useParams<{ id?: string; sessionId?: string }>();
  const { data: approvalAudit } = useSessionAudit(
    projectId ?? approvalRouteParams.id,
    approvalRouteParams.sessionId,
    { refetchInterval: 5_000 },
  );
  const hasPendingApproval = (approvalAudit?.actions ?? []).some(isPendingAction);
  const { data: commands } = useRuntimeCommands();
  const { data: providers } = useRuntimeProviders();
  const { data: allSessions } = useRuntimeSessions();
  const { data: config } = useRuntimeConfig();
  const projectConfig = useProjectConfig(projectId);
  const abortSession = useAbortRuntimeSession();

  // ---- Unified model/agent/variant state (1:1 port of SolidJS local.tsx) ----
  const local = useRuntimeLocal({
    agents,
    providers,
    config,
    sessionId,
    boundAgentName,
    defaultAgentName: projectConfig?.open_code_default_agent,
  });
  // Session agent-lock is DISABLED (mirrors the backend KORTIX_ENFORCE_SESSION_AGENT_LOCK,
  // default off): the picker still defaults to the session's agent (seeded via
  // useRuntimeLocal's boundAgentName) but stays switchable — sends use the current
  // pick, not a forced lock. Flip to true to restore the hard lock once per-agent
  // executor-token scoping lands (see docs/specs/2026-06-28-agent-defaults-todo.md).
  const SESSION_AGENT_LOCK_ENABLED: boolean = false;
  const lockedAgentName = SESSION_AGENT_LOCK_ENABLED ? boundAgentName?.trim() || null : null;
  const localAgentSet = local.agent.set;
  const localModelCurrentKey = local.model.currentKey;
  // Wire model to SEND: `auto` when on the default (gateway resolves it), else
  // the explicit pick. Always send this — not currentKey, which is for display.
  const localModelSendKey = local.model.sendKey;
  const localModelList = local.model.list;
  const localModelSet = local.model.set;
  const localModelVisible = local.model.visible;
  const localVariantSet = local.model.variant.set;

  // Default the agent picker to whichever agent owns the latest assistant
  // turn in this session. Catches PM onboarding sessions (first turn was PM),
  // "Ask PM" sessions, team-agent ticket sessions, etc. — without relying on
  // title patterns. Falls through if there's no assistant msg yet.
  const defaultedAgentRef = useRef(false);
  useEffect(() => {
    if (defaultedAgentRef.current) return;
    if (!messages || messages.length === 0) return;
    let lastAgent: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info as any;
      if (info?.role === 'assistant' && info?.agent) {
        lastAgent = info.agent as string;
        break;
      }
    }
    if (!lastAgent) return;
    const agentEntry = local.agent.list.find((a: any) => a?.name === lastAgent);
    if (!agentEntry) return;
    if (local.agent.current?.name !== lastAgent) {
      local.agent.set(lastAgent);
    }
    defaultedAgentRef.current = true;
  }, [messages, local.agent]);

  const pendingPromptHandled = useRef(false);

  // ---- Polling fallback & optimistic send ----
  const [pollingActive, setPollingActive] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<{
    name: string;
    description?: string;
  } | null>(null);
  const [commandError, setCommandError] = useState<KortixSendError | null>(null);
  // Map of user message IDs → command info, so UserMessageRow can render
  // a compact command pill instead of the raw expanded template text.
  const commandMessagesRef = useRef<Map<string, { name: string; args?: string }>>(new Map());
  // Stash the pending command info so we can associate it with the user message
  // even if the busy signal arrives before the message list updates.
  const pendingCommandStashRef = useRef<{ name: string; args?: string } | null>(null);
  // Track whether a pending prompt send is in flight (dashboard→session flow).
  // Keeps isBusy true until the server acknowledges with a busy status.
  const [pendingSendInFlight, setPendingSendInFlight] = useState(false);
  const [pendingSendMessageId, setPendingSendMessageId] = useState<string | null>(null);
  // Grace period: don't stop polling immediately on idle after a recent send
  const lastSendTimeRef = useRef<number>(0);
  // ---- Optimistic prompt (from dashboard/project page) ----
  // Backed by the SDK's start-stash (`readStartStash`/`clearStartStash`), which
  // understands both the modern `kortix:start:<id>` shape and every legacy
  // producer's bare `opencode_pending_prompt:<id>` + `opencode_pending_options:<id>`
  // pair — so pushState navigation still works with no `?new=true` dependency,
  // and no web code needs to know the storage key names directly.
  const [optimisticPrompt, setOptimisticPrompt] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return readStartStash(sessionId)?.prompt ?? null;
    }
    return null;
  });

  // Hydrate options from the SDK's start-stash and send the pending prompt for
  // new sessions. The dashboard/project page (or the instant session shell)
  // stashes the prompt and navigates here. We send the message from here (not
  // the producer) so that SSE listeners and polling are already active when the
  // response starts streaming back.
  //
  // The write-race retry (stash read), readiness poll (agent/model), and
  // failure-recovery (stash restore + classify + idle + rehydrate-or-remove)
  // mechanics are all owned by the SDK's `replayStartStash` — this effect only
  // supplies the web-specific pieces: resolving agent/model/variant readiness
  // against this session's own local model/agent stores, building the
  // optimistic text + outgoing parts (file uploads), and restoring pending
  // files on failure.
  useEffect(() => {
    if (pendingPromptHandled.current) return;

    // Set by `prepare` below (once, before any failure can occur) so
    // `onFailure` can restore the same files it consumed.
    let filesToRestoreOnFailure: AttachedFile[] = [];

    const handle = replayStartStash<{ options: Record<string, unknown> }>({
      sessionId,
      classify: classifySessionError,
      checkReadiness: (stash) => {
        // Restore agent/model/variant selections from the producer.
        const options: Record<string, unknown> = {};
        let selectedModelForSend: ModelKey | undefined;
        const isSelectableModel = (model: ModelKey): boolean =>
          localModelList.some(
            (m) => m.providerID === model.providerID && m.modelID === model.modelID,
          ) && localModelVisible(model);
        if (stash.agent) {
          if (!lockedAgentName || stash.agent === lockedAgentName) {
            options.agent = stash.agent;
            localAgentSet(stash.agent);
          }
        }
        if (stash.model && isSelectableModel(stash.model as ModelKey)) {
          options.model = stash.model;
          selectedModelForSend = stash.model as ModelKey;
          localModelSet(stash.model as ModelKey);
        }
        if (stash.variant) {
          options.variant = stash.variant;
          localVariantSet(stash.variant);
        }
        if (lockedAgentName) {
          options.agent = lockedAgentName;
        }
        if (!selectedModelForSend && localModelSendKey) {
          options.model = localModelSendKey;
          selectedModelForSend = localModelSendKey;
        }
        if (!selectedModelForSend) return null;
        return { options };
      },
      onReadinessTimeout: () => {
        setCommandError({
          kind: 'runtime-error',
          message: NO_MODEL_AVAILABLE_MESSAGE,
          cause: null,
        });
      },
      prepare: (stash, ready) => {
        pendingPromptHandled.current = true;
        setPollingActive(true);
        setPendingSendInFlight(true);
        clearStartStash(sessionId);

        const sendOpts = ready.options as {
          agent?: string;
          model?: ModelKey;
          variant?: string;
        };
        const messageID = ascendingId('msg');
        const textPartId = ascendingId('prt');
        // Consume pending files before rendering the optimistic message so
        // uploaded file cards are visible while the sandbox is still starting.
        const pendingFiles = usePendingFilesStore.getState().consumePendingFiles();
        filesToRestoreOnFailure = pendingFiles;
        const optimisticPendingPrompt = buildOptimisticPromptTextWithUploads(
          stash.prompt,
          pendingFiles,
        );
        setOptimisticPrompt(optimisticPendingPrompt);
        setPendingSendMessageId(messageID);
        lastSendTimeRef.current = Date.now();

        return {
          messageId: messageID,
          optimisticText: optimisticPendingPrompt,
          partIds: [textPartId],
          sendOptions: {
            ...(session?.directory ? { directory: session.directory } : {}),
            ...(sendOpts?.agent && { agent: sendOpts.agent }),
            ...(sendOpts?.model && { model: formatPromptModel(sendOpts.model) }),
            ...(sendOpts?.variant && { variant: sendOpts.variant }),
          },
          // Upload local files and build the parts array (text + file refs).
          buildParts: async () => {
            const built = await buildPromptPartsWithUploads(stash.prompt, pendingFiles, uploadFile);
            return [{ type: 'text' as const, text: built.text }, ...built.remoteParts];
          },
        };
      },
      onFailure: (_stash, _err, classified) => {
        setPendingSendInFlight(false);
        setPendingSendMessageId(null);
        setOptimisticPrompt(null);
        setPollingActive(false);
        setCommandError(classified);
        usePendingFilesStore.getState().setPendingFiles(filesToRestoreOnFailure);
        pendingPromptHandled.current = false;
      },
    });

    return () => handle.cancel();
  }, [
    sessionId,
    localAgentSet,
    localModelCurrentKey,
    localModelSendKey,
    localModelList,
    localModelSet,
    localModelVisible,
    localVariantSet,
    lockedAgentName,
    session?.directory,
  ]);

  // Clear optimistic prompt once real messages arrive
  useEffect(() => {
    if (optimisticPrompt && messages && messages.length > 0) {
      setOptimisticPrompt(null);
    }
  }, [optimisticPrompt, messages]);

  const agentNames = useMemo(() => local.agent.list.map((a) => a.name), [local.agent.list]);

  // ---- Check if any messages have tool calls ----
  // ---- Restore model/agent from last user message ----
  // Seeds agent/model from the last user message ONLY if there's no per-session
  // selection yet. This handles opening a session for the first time. If the user
  // already changed the model in this session (persisted per-session in localStorage),
  // we don't overwrite it — the per-session selection takes priority via the
  // resolution chain in useRuntimeLocal.
  const lastUserMessage = useMemo(
    () => (messages ? [...messages].reverse().find((m) => m.info.role === 'user') : undefined),
    [messages],
  );
  const lastUserMsgIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!lastUserMessage) return;
    if (lastUserMsgIdRef.current === lastUserMessage.info.id) return;
    lastUserMsgIdRef.current = lastUserMessage.info.id;
    const msg = lastUserMessage.info as any;
    if (msg.agent) local.agent.set(msg.agent);
    // Only seed model from message if the user hasn't already made a per-session
    // selection (e.g. changed the model after the last message, then reloaded).
    // The per-session model is checked first in the resolution chain, so we only
    // need to seed it here when it's empty (first open of this session).
    if (!local.model.hasSessionModel) {
      const parsedModel = parseModelKey(msg.model);
      if (parsedModel) local.model.set(parsedModel, { autoSeed: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUserMessage?.info.id]);

  // ---- Session status ----
  // Use sync store as primary (matches Runtime), fall back to status store
  const syncStatus = useSyncStore((s) => s.sessionStatus[sessionId]);
  const isOptimisticCompacting = useRuntimeCompactionStore((s) =>
    Boolean(s.compactingBySession[sessionId]),
  );
  const sessionStatus = syncStatus;
  const isServerBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';

  // Pending: last assistant message has no time.completed.
  // Used as a SECONDARY signal — only contributes to busy when the
  // server also says busy. Prevents the event-ordering race where
  // session.idle arrives before message.updated sets time.completed.
  const hasIncompleteAssistant = useMemo(() => {
    if (!messages || messages.length === 0) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'assistant') {
        return !(messages[i].info as any).time?.completed;
      }
    }
    return false;
  }, [messages]);

  const hasPendingUserReply = useMemo(() => {
    if (!messages || messages.length === 0) return false;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return false;
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      if (messages[i].info.role === 'assistant') return false;
    }
    return true;
  }, [messages]);

  // Matching the reference: session status is the PRIMARY source of truth.
  // hasIncompleteAssistant only matters while the server also says busy
  // (prevents the idle→incomplete race). pendingSendInFlight covers the
  // gap between user send and server ack.
  const effectiveBusy = isServerBusy || pendingSendInFlight || isOptimisticCompacting;

  // Short visual fade (300ms) — matches the reference's 260ms delay-hide.
  // Goes true immediately, stays visible briefly after going idle so the
  // UI doesn't flicker between agentic steps. NOT a 2s debounce.
  const [isBusy, setIsBusy] = useState(effectiveBusy);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (effectiveBusy) {
      clearTimeout(busyTimerRef.current);
      setIsBusy(true);
    } else {
      busyTimerRef.current = setTimeout(() => setIsBusy(false), 300);
    }
    return () => clearTimeout(busyTimerRef.current);
  }, [effectiveBusy]);

  const expectAssistantResponse =
    isServerBusy ||
    hasPendingUserReply ||
    (isServerBusy && hasIncompleteAssistant) ||
    pendingSendInFlight;

  const shouldRecoveryPoll = expectAssistantResponse;

  const streamCacheKey = `opencode_stream_cache:${sessionId}`;
  const streamCacheRestoredRef = useRef<string | null>(null);

  // Restore cached streaming prefix after refresh when SSE resumes from the
  // current point but backend hydrate has not yet returned the in-progress text.
  // Runs at most once per cache key to prevent re-triggering when the store
  // update causes `messages` to change (which would re-fire this effect).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!shouldRecoveryPoll) return;
    if (!messages || messages.length === 0) return;

    let cached: {
      messageID: string;
      parentID?: string;
      partID: string;
      text: string;
      updatedAt: number;
    } | null = null;
    try {
      const raw = sessionStorage.getItem(streamCacheKey);
      cached = raw ? JSON.parse(raw) : null;
    } catch {
      cached = null;
    }
    if (!cached || !cached.messageID || !cached.partID || !cached.text) return;
    // Ignore stale cache entries.
    if (Date.now() - (cached.updatedAt || 0) > 30 * 60 * 1000) return;
    // Prevent re-running after a successful restore for this exact cache entry.
    const cacheFingerprint = `${cached.messageID}:${cached.partID}:${cached.text.length}`;
    if (streamCacheRestoredRef.current === cacheFingerprint) return;

    const store = useSyncStore.getState();
    const currentMsgs = store.getMessages(sessionId);
    let latestUserId: string | undefined;
    for (let i = currentMsgs.length - 1; i >= 0; i--) {
      if (currentMsgs[i].info.role === 'user') {
        latestUserId = currentMsgs[i].info.id;
        break;
      }
    }
    if (hasPendingUserReply) {
      // For a fresh pending turn we must have an exact parent match.
      // If cached parentID is missing or mismatched, the cache likely
      // belongs to an older turn and would prepend stale mid-stream text.
      if (!cached.parentID || !latestUserId || cached.parentID !== latestUserId) {
        return;
      }
    }
    const hasMsg = currentMsgs.some((m) => m.info.id === cached!.messageID);
    const hasAnyUser = currentMsgs.some((m) => m.info.role === 'user');

    if (!hasMsg) {
      // Only create a synthetic assistant message if we can safely attach
      // it to an existing user turn.
      if (!hasAnyUser) return;
      const parentID = cached.parentID ?? latestUserId;
      if (hasPendingUserReply && !parentID) return;
      if (parentID) {
        const parentExists = currentMsgs.some((m) => m.info.id === parentID);
        if (!parentExists) return;
      }
      store.upsertMessage(sessionId, {
        id: cached.messageID,
        sessionID: sessionId,
        role: 'assistant',
        parentID,
      } as any);
    }

    const currentParts = store.parts[cached.messageID] ?? [];
    const existing = currentParts.find((p) => p.id === cached!.partID) as any;
    const existingText = typeof existing?.text === 'string' ? existing.text : '';
    if (cached.text.length <= existingText.length) {
      // Already restored or surpassed — mark as done.
      streamCacheRestoredRef.current = cacheFingerprint;
      return;
    }

    streamCacheRestoredRef.current = cacheFingerprint;
    store.upsertPart(cached.messageID, {
      ...(existing ?? {}),
      id: cached.partID,
      messageID: cached.messageID,
      sessionID: sessionId,
      type: 'text',
      text: cached.text,
    } as any);
  }, [messages, sessionId, shouldRecoveryPoll, streamCacheKey, hasPendingUserReply]);

  // Client-side message queue — mirrors Claude Code / Codex: a message typed
  // while the agent is mid-turn is held here instead of being sent straight
  // through (the Runtime server would happily accept it immediately, but
  // interleaving it into a live turn reads badly). It's flushed one at a time
  // at the next safe boundary: either a tool call finishing, or the turn
  // going idle. See SessionChatInput.handleSubmit → onQueueMessage, and the
  // drain effect below.
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const queuedMessagesRef = useRef<QueuedMessage[]>([]);
  useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);
  // Local, never-sent-to-server counter — separate from `ascendingId`, whose
  // prefix union ('msg' | 'prt') is meaningful for server-compatible message
  // ordering and shouldn't grow a prefix for a purely client-side draft id.
  const queuedIdCounterRef = useRef(0);

  const handleQueueMessage = useCallback(
    (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => {
      const id = `queued-${++queuedIdCounterRef.current}`;
      setQueuedMessages((prev) => [...prev, { id, text, files, mentions }]);
    },
    [],
  );

  const handleRemoveQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Stop polling when session goes idle (via SSE or polling fallback).
  // Grace period: if we sent a message recently (within 5s), don't stop polling
  // on the first idle status — the server may not have started processing yet.
  useEffect(() => {
    if (pollingActive && sessionStatus?.type === 'idle') {
      const timeSinceSend = Date.now() - lastSendTimeRef.current;
      if (timeSinceSend < 5000) {
        // Still within grace period — check again shortly
        const remaining = 5000 - timeSinceSend;
        const timer = setTimeout(() => {
          // Re-check: if still idle after grace period, stop polling
          const currentStatus = useSyncStore.getState().sessionStatus[sessionId];
          if (currentStatus?.type === 'idle') {
            setPollingActive(false);
          }
        }, remaining);
        return () => clearTimeout(timer);
      }
      setPollingActive(false);
    }
  }, [pollingActive, sessionStatus?.type, sessionId]);

  // Clear pendingSendInFlight once the server acknowledges it's working,
  // or when new messages arrive (fallback for command sends).
  // This bridges the gap between the optimistic prompt clearing and the
  // server status updating — keeps isBusy true so the turn shows a loader.
  useEffect(() => {
    if (!pendingSendInFlight) return;
    if (isServerBusy) {
      setPendingSendInFlight(false);
      setPendingSendMessageId(null);
      return;
    }
    // If we got an assistant reply for the pending user message, the server
    // already accepted and processed this send even if status events were missed.
    const hasAssistantReply = pendingSendMessageId
      ? !!messages?.some(
          (m) => m.info.role === 'assistant' && (m.info as any).parentID === pendingSendMessageId,
        )
      : false;
    if (hasAssistantReply) {
      setPendingSendInFlight(false);
      setPendingSendMessageId(null);
    }
  }, [pendingSendInFlight, isServerBusy, messages, pendingSendMessageId]);

  // Safety timeout: clear pendingSendInFlight after 30s even if the server
  // never acknowledged. Prevents the UI from being stuck forever in "busy"
  // when the send succeeded (HTTP 204) but the server never started processing.
  useEffect(() => {
    if (!pendingSendInFlight) return;
    const timer = setTimeout(() => {
      setPendingSendInFlight(false);
      setPendingSendMessageId(null);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [pendingSendInFlight]);

  // SSE + heartbeat timeout is the source of truth for streaming state.
  // No watchdogs, no polling, no reconcilers — matching the reference.

  // Clear pending user message when we can confirm the message is in cache
  // (by ID), or when new messages arrive (fallback for command sends).
  // When a command was pending, associate the newest user message with the
  // command info so UserMessageRow can render a nice pill instead of raw template text.
  const prevMsgLenRef = useRef(messages?.length || 0);
  useEffect(() => {
    if (!pendingUserMessage) return;
    const hasPendingMessage = pendingUserMessageId
      ? !!messages?.some((m) => m.info.id === pendingUserMessageId)
      : false;
    if (hasPendingMessage) {
      setPendingUserMessage(null);
      setPendingUserMessageId(null);
      setPendingCommand(null);
      return;
    }
    const len = messages?.length || 0;
    if (len > prevMsgLenRef.current) {
      setPendingUserMessage(null);
      setPendingUserMessageId(null);
      setPendingCommand(null);
    }
  }, [messages, messages?.length, pendingUserMessage, pendingUserMessageId]);

  // Associate stashed command info with the newest user message when messages arrive.
  // Runs separately so it captures the mapping even if busy fires before messages update.
  useEffect(() => {
    const stash = pendingCommandStashRef.current;
    if (!stash || !messages) return;
    const len = messages.length;
    if (len <= prevMsgLenRef.current) return;
    // Find the last user message — the one just created by the command
    for (let i = len - 1; i >= 0; i--) {
      if (messages[i].info.role === 'user') {
        commandMessagesRef.current.set(messages[i].info.id, stash);
        pendingCommandStashRef.current = null;
        break;
      }
    }
  }, [messages]);

  useEffect(() => {
    prevMsgLenRef.current = messages?.length || 0;
  }, [messages?.length]);

  // ---- Auto-scroll (replaces inline scroll logic) ----
  const hasActiveQuestion = useRuntimePendingStore((s) =>
    Object.values(s.questions).some((q) => q.sessionID === sessionId),
  );
  const messageCount = messages?.length ?? 0;
  const {
    scrollRef,
    contentRef,
    spacerElRef,
    showScrollButton,
    scrollToBottom,
    scrollToLastTurn,
    scrollToEnd,
    scrollToAbsoluteBottom,
    smoothScrollToAbsoluteBottom,
  } = useAutoScroll({
    working: isBusy && !hasActiveQuestion,
    hasContent: messageCount > 0,
  });

  // Scroll to the bottom on initial load / session change.
  // Uses a callback ref on the scroll container to guarantee it's mounted.
  // Strategy: start scrolled to ~90% instantly (no flash at top), then
  // smooth-scroll the last bit once content has rendered for a nice effect.
  const initialScrollDoneRef = useRef<string | null>(null);
  const scrollContainerCallbackRef = useCallback(
    (node: HTMLDivElement | null) => {
      // Always keep scrollRef updated
      (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      if (!node) return;
      if (initialScrollDoneRef.current === sessionId) return;
      initialScrollDoneRef.current = sessionId;

      // When viewing a sub-session from the top, don't scroll to bottom
      if (initialScrollTop) {
        node.scrollTop = 0;
        return;
      }

      // Instant scroll to near-bottom so user doesn't see top-of-page flash.
      // Position slightly above the bottom so the smooth scroll has room to animate.
      const scrollNearBottom = () => {
        const max = node.scrollHeight - node.clientHeight;
        node.scrollTop = Math.max(0, max - 300);
      };
      scrollNearBottom();

      // After content settles, smooth scroll the final stretch to the bottom.
      setTimeout(() => {
        node.scrollTo({
          top: node.scrollHeight - node.clientHeight,
          behavior: 'smooth',
        });
      }, 150);
      // Follow-up in case async content changed scrollHeight
      setTimeout(() => {
        node.scrollTo({
          top: node.scrollHeight - node.clientHeight,
          behavior: 'smooth',
        });
      }, 600);
    },
    [sessionId, scrollRef, initialScrollTop],
  );

  // Tab switch: the DOM stays mounted (hidden class), so the browser
  // preserves scroll position automatically. No action needed here.

  // ---- Pending permissions & questions ----
  const allPermissions = useRuntimePendingStore((s) => s.permissions);
  const allQuestions = useRuntimePendingStore((s) => s.questions);
  const pendingPermissions = useMemo(
    () => Object.values(allPermissions).filter((p) => p.sessionID === sessionId),
    [allPermissions, sessionId],
  );
  const suppressedQuestionIdsRef = useRef<Map<string, number>>(new Map());
  const suppressQuestionFor = useCallback((requestId: string, ms = 15000) => {
    suppressedQuestionIdsRef.current.set(requestId, Date.now() + ms);
  }, []);
  const isQuestionSuppressed = useCallback((requestId: string) => {
    const expiresAt = suppressedQuestionIdsRef.current.get(requestId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      suppressedQuestionIdsRef.current.delete(requestId);
      return false;
    }
    return true;
  }, []);
  const pendingQuestions = useMemo(
    () =>
      Object.values(allQuestions).filter(
        (q) => q.sessionID === sessionId && !isQuestionSuppressed(q.id),
      ),
    [allQuestions, sessionId, isQuestionSuppressed],
  );
  const QUESTION_PROMPT_ANIMATION_MS = 320;
  const activePendingQuestion = pendingQuestions[0] ?? null;
  const [renderedQuestion, setRenderedQuestion] = useState<QuestionRequest | null>(null);
  const [questionPromptVisible, setQuestionPromptVisible] = useState(false);
  const questionPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const nextQuestion = activePendingQuestion;

    if (questionPromptTimerRef.current) {
      clearTimeout(questionPromptTimerRef.current);
      questionPromptTimerRef.current = null;
    }

    if (nextQuestion) {
      setRenderedQuestion(nextQuestion);
      requestAnimationFrame(() => setQuestionPromptVisible(true));
      return;
    }

    setQuestionPromptVisible(false);
    questionPromptTimerRef.current = setTimeout(() => {
      setRenderedQuestion(null);
      questionPromptTimerRef.current = null;
    }, QUESTION_PROMPT_ANIMATION_MS);
  }, [activePendingQuestion]);

  useEffect(() => {
    return () => {
      if (questionPromptTimerRef.current) {
        clearTimeout(questionPromptTimerRef.current);
      }
    };
  }, []);
  const turns = useMemo(() => (messages ? groupMessagesIntoTurns(messages) : []), [messages]);
  const hasAnyMessages = turns.length > 0;
  const hasChatContent = hasAnyMessages || (!!optimisticPrompt && !hasAnyMessages);
  // Full-bleed wallpaper layer mounted by SessionLayout (null on mobile /
  // standalone). When present, the welcome wallpaper is portaled into it so it
  // spans the entire session width instead of shrinking with the chat panel.
  const wallpaperLayer = useSessionWallpaperLayer();
  const WELCOME_FADE_MS = 900;
  const [welcomeFadeActive, setWelcomeFadeActive] = useState(false);
  const welcomeFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevHasChatContentRef = useRef(hasChatContent);
  useEffect(() => {
    const hadContent = prevHasChatContentRef.current;
    if (!hadContent && hasChatContent) {
      setWelcomeFadeActive(true);
      if (welcomeFadeTimerRef.current) {
        clearTimeout(welcomeFadeTimerRef.current);
      }
      welcomeFadeTimerRef.current = setTimeout(() => {
        setWelcomeFadeActive(false);
        welcomeFadeTimerRef.current = null;
      }, WELCOME_FADE_MS + 120);
    }
    if (!hasChatContent) {
      setWelcomeFadeActive(false);
    }
    prevHasChatContentRef.current = hasChatContent;
  }, [hasChatContent]);

  useEffect(() => {
    return () => {
      if (welcomeFadeTimerRef.current) {
        clearTimeout(welcomeFadeTimerRef.current);
      }
    };
  }, []);
  // Self-heal a missed `question.asked` SSE event (a `question` tool part
  // rendering as running with nothing in the pending store for this session) —
  // see the SDK's `useQuestionSelfHeal` for why this poll is distinct from
  // `useRuntimeEventStream`'s reconnect-gap hydration.
  useQuestionSelfHeal(sessionId, messages, {
    enabled: isActiveSessionTab,
    isSuppressed: isQuestionSuppressed,
  });
  // The permission twin — a missed `permission.asked` frame otherwise leaves
  // the agent silently blocked with no card to answer (the "have to type
  // `continue`" wedge).
  usePermissionSelfHeal(sessionId, messages, { enabled: isActiveSessionTab });

  // ---- Permission/question reply handlers ----
  const removePermission = useRuntimePendingStore((s) => s.removePermission);
  const removeQuestion = useRuntimePendingStore((s) => s.removeQuestion);

  const handlePermissionReply = useCallback(
    async (requestId: string, reply: 'once' | 'always' | 'reject') => {
      // No optimistic remove: only drop the card once the runtime accepted the
      // reply — a failed reply must stay answerable. Rethrow so callers
      // (prompt buttons) reset their busy state and surface the error.
      await replyToPermission(requestId, reply);
      removePermission(requestId);
    },
    [removePermission],
  );

  const handleQuestionReply = useCallback(
    async (requestId: string, answers: string[][]) => {
      // Snapshot the question BEFORE removing it so we can cache the
      // answer against the tool part's ID.
      const questionReq = useRuntimePendingStore.getState().questions[requestId];

      suppressQuestionFor(requestId);
      // Optimistically remove the question so the textarea shows immediately
      removeQuestion(requestId);

      // Save the answers in the optimistic cache keyed by the tool part ID.
      // This cache survives SSE message.part.updated events that may
      // overwrite the tool part before the server includes metadata.answers.
      // answeredQuestionParts reads from this cache as a fallback.
      if (questionReq?.tool?.messageID) {
        const { messageID } = questionReq.tool;
        const parts = useSyncStore.getState().parts[messageID];
        if (parts) {
          const match = parts.find(
            (p) =>
              p.type === 'tool' &&
              (p as ToolPart).tool === 'question' &&
              (p as ToolPart).callID === questionReq.tool!.callID,
          );
          if (match) {
            optimisticAnswersCache.set(match.id, {
              answers,
              input: ((match as ToolPart).state?.input as Record<string, unknown>) ?? {},
            });
          }
        }
      }

      try {
        await replyToQuestion(requestId, answers);
      } catch {
        // ignore — SSE "question.replied" event will also remove it
      }
    },
    [removeQuestion, suppressQuestionFor],
  );

  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      suppressQuestionFor(requestId);
      // Optimistically remove the question so the textarea shows immediately
      removeQuestion(requestId);
      try {
        await rejectQuestion(requestId);
      } catch {
        // ignore — SSE "question.rejected" event will also remove it
      }
      // Also abort the session so the "The operation was aborted." banner appears
      if (!abortSession.isPending) {
        abortSession.mutate(sessionId);
      }
    },
    [removeQuestion, abortSession, sessionId, suppressQuestionFor],
  );
  const hasCompactionTurn = useMemo(
    () =>
      turns.some(
        (turn) =>
          turn.assistantMessages.some((msg) => (msg.info as any).summary === true) ||
          turn.assistantMessages.some((msg) => msg.parts.some((p) => p.type === 'compaction')),
      ),
    [turns],
  );

  // ---- Jump-to-message (from CMD+K or minimap) ----
  const targetMessageId = useMessageJumpStore((s) => s.targetMessageId);
  const clearJumpTarget = useMessageJumpStore((s) => s.clearTarget);
  useEffect(() => {
    if (!targetMessageId) return;
    const contentEl = contentRef.current;
    const scrollEl = scrollRef.current;
    if (!contentEl || !scrollEl) return;

    const target = contentEl.querySelector<HTMLElement>(`[data-turn-id="${targetMessageId}"]`);
    if (!target) {
      clearJumpTarget();
      return;
    }

    const scrollRect = scrollEl.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offset = targetRect.top - scrollRect.top + scrollEl.scrollTop - 24;
    scrollEl.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
    clearJumpTarget();
  }, [targetMessageId, clearJumpTarget, contentRef, scrollRef]);

  // Reset on session change
  useEffect(() => {
    setPollingActive(false);
    setPendingUserMessage(null);
    setPendingUserMessageId(null);
    setPendingCommand(null);
    setPendingSendInFlight(false);
    setPendingSendMessageId(null);
    lastSendTimeRef.current = 0;
  }, [sessionId]);

  // ============================================================================
  // Billing: DISABLED — billing is handled server-side by the router
  // (POST /v1/router/chat/completions deducts credits per LLM call).
  // This frontend useEffect was causing double-billing once opencode.jsonc
  // got cost config and step-finish.cost became non-zero.
  // ============================================================================

  // ============================================================================
  // TODO(session-rewind): Bring back an in-place "edit past message + rewind"
  // flow instead of the removed edit-fork-prompt feature. The old behaviour
  // created a native fork of the session at a message and reopened the new
  // session with the edited prompt restored in the composer — that UX was the
  // wrong model. What we actually want is a proper rewind/rollback on the SAME
  // session (edit a prior user message, roll the session back to that point,
  // and re-run from there), which opencode supports natively. Removed here so
  // it can be rebuilt correctly. The old surface spanned: useForkSession()
  // (SDK), the fork-draft stash (writeForkDraft/readForkDraft/clearForkDraft),
  // the Fork / Edit-fork buttons + Confirm/Edit dialogs on user messages, and
  // the composer draft-restore in session-chat-input.tsx.
  // ============================================================================

  // ============================================================================
  // Send / Stop / Command handlers
  // ============================================================================

  const handleSend = useCallback(
    async (
      rawText: string,
      files?: AttachedFile[],
      mentions?: TrackedMention[],
      /**
       * Optional per-call overrides — used by the message queue drain so a
       * queued message uses the agent/model/variant captured at enqueue time
       * rather than whatever is currently active in the local store
       * (matches Runtime FollowupDraft semantics).
       */
      overrides?: {
        agent?: string | null;
        model?: { providerID: string; modelID: string } | null;
        variant?: string | null;
      },
    ) => {
      setCommandError(null);

      // Wrap reply context in XML if present, then clear it
      let text = rawText;
      if (replyTo) {
        text = `<reply_context>${replyTo.text}</reply_context>\n\n${rawText}`;
        setReplyTo(null);
      }

      // Structured @-mention refs — emitted as <file_ref /> / <agent_ref />
      // blocks appended to the outgoing text. Same shape as
      // the existing <session_ref /> handling, so the agent gets uniform
      // metadata and the frontend can strip them back out on render.
      // File and agent refs from tracked @ mentions. File uploads still use
      // the separate <file path="..." mime="..." ...>…</file> block below —
      // these are only for plain @ references to existing files/agents.
      const fileMentionRefs: FileRefLike[] = (mentions ?? [])
        .filter((m) => m.kind === 'file' && m.label)
        .map((m) => ({ path: m.label, name: m.label }));
      const agentMentionRefs: AgentRefLike[] = (mentions ?? [])
        .filter((m) => m.kind === 'agent' && m.label)
        .map((m) => ({ name: m.label }));

      // Play send sound
      playSound('send');
      const messageID = ascendingId('msg');

      // Generate part IDs upfront so the optimistic message and the server
      // request use the SAME IDs. When the server echoes parts via
      // message.part.updated, the sync store's upsertPart will UPDATE
      // (not duplicate) the optimistic parts. This matches Runtime's
      // SolidJS approach where part IDs are sent with the prompt request.
      const textPartId = ascendingId('prt');
      const attachedFiles = files ?? [];

      // Build optimistic text that includes session ref XML so that
      // HighlightMentions / UserMessageRow can detect multi-word session
      // mentions (e.g. "@Intro message") before the server echoes back.
      const sessionMentionsForOptimistic =
        mentions?.filter((m) => m.kind === 'session' && m.value) ?? [];

      // Also detect raw @ses_<id> patterns typed directly
      const rawOptimisticSessionIds: typeof sessionMentionsForOptimistic = [];
      const rawOptimisticRegex = /@(ses_[A-Za-z0-9]+)/g;
      let rawOptimisticMatch: RegExpExecArray | null;
      while ((rawOptimisticMatch = rawOptimisticRegex.exec(text)) !== null) {
        const rawId = rawOptimisticMatch[1];
        if (sessionMentionsForOptimistic.some((m) => m.value === rawId)) continue;
        const found = allSessions?.find((s: any) => s.id === rawId);
        rawOptimisticSessionIds.push({
          kind: 'session',
          label: found?.title || rawId,
          value: rawId,
        });
      }

      const allOptimisticSessionMentions = [
        ...sessionMentionsForOptimistic,
        ...rawOptimisticSessionIds,
      ];
      let optimisticText = text;
      optimisticText = buildOptimisticPromptTextWithUploads(optimisticText, attachedFiles);
      if (allOptimisticSessionMentions.length > 0) {
        const refs = allOptimisticSessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        optimisticText = `${optimisticText}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }
      if (fileMentionRefs.length > 0) {
        const block = buildFileRefsBlock(fileMentionRefs);
        if (block) optimisticText = `${optimisticText}\n\n${block}`;
      }
      if (agentMentionRefs.length > 0) {
        const block = buildAgentRefsBlock(agentMentionRefs);
        if (block) optimisticText = `${optimisticText}\n\n${block}`;
      }

      // Optimistic: show message immediately in sync store + set busy
      // Matches Runtime: sync.set("session_status", session.id, { type: "busy" })
      beginOptimisticSend(sessionId, messageID, optimisticText, [textPartId]);

      // Scroll so the new user message appears at the top of the viewport.
      // MutationObserver recalcs spacer automatically when the new turn renders.
      // Fire twice: early (before DOM update) to reset scroll state so the RAF
      // auto-scroll loop is unblocked, and again after the turn likely rendered.
      scrollToBottom();
      setTimeout(() => scrollToBottom(), 100);

      const options: Record<string, unknown> = {};
      const overrideAgent = overrides?.agent;
      const overrideModel = overrides?.model;
      const overrideVariant = overrides?.variant;
      if (lockedAgentName) {
        options.agent = lockedAgentName;
      } else if (overrideAgent !== undefined) {
        if (overrideAgent) options.agent = overrideAgent;
      } else if (local.agent.current) {
        options.agent = local.agent.current.name;
      }
      if (overrideModel !== undefined) {
        if (overrideModel) options.model = overrideModel;
      } else if (local.model.sendKey) {
        options.model = local.model.sendKey;
      }
      if (overrideVariant !== undefined) {
        if (overrideVariant) options.variant = overrideVariant;
      } else if (local.model.variant.current) {
        options.variant = local.model.variant.current;
      }

      // Build parts: text first, then upload attached files to /workspace/uploads/
      // and send as XML text references (agent reads from disk on demand, not loaded into context)
      const textPrompt = { id: textPartId, type: 'text' as const, text };
      const parts: Array<
        typeof textPrompt | { type: 'file'; mime: string; url: string; filename: string }
      > = [textPrompt];
      let built: Awaited<ReturnType<typeof buildPromptPartsWithUploads>>;
      try {
        built = await buildPromptPartsWithUploads(textPrompt.text, attachedFiles, uploadFile);
      } catch (err) {
        // Never reached the network — nothing to rehydrate from the server,
        // so just clear busy and drop the optimistic message outright.
        abandonOptimisticSend(sessionId, messageID);
        const classified = classifySessionError(err);
        setCommandError(classified);
        throw err instanceof Error ? err : new Error(classified.message);
      }
      textPrompt.text = built.text;
      parts.push(...built.remoteParts);

      // Append session reference hints for @session mentions.
      // Merge tracked mentions with any raw @ses_<id> tags typed directly.
      const trackedSessionMentions = mentions?.filter((m) => m.kind === 'session' && m.value) ?? [];

      // Detect raw @ses_<id> patterns in the text (e.g. @ses_2ec118d4...)
      const rawSessionIdMentions: TrackedMention[] = [];
      const rawSessionIdRegex = /@(ses_[A-Za-z0-9]+)/g;
      let rawMatch: RegExpExecArray | null;
      while ((rawMatch = rawSessionIdRegex.exec(textPrompt.text)) !== null) {
        const rawId = rawMatch[1];
        // Skip if already covered by a tracked mention
        if (trackedSessionMentions.some((m) => m.value === rawId)) continue;
        // Look up session by ID
        const found = allSessions?.find((s: any) => s.id === rawId);
        if (found) {
          rawSessionIdMentions.push({
            kind: 'session',
            label: found.title || rawId,
            value: rawId,
          });
        } else {
          // Unknown session ID — still include it so the agent can attempt to fetch it
          rawSessionIdMentions.push({
            kind: 'session',
            label: rawId,
            value: rawId,
          });
        }
      }

      const allSessionMentions = [...trackedSessionMentions, ...rawSessionIdMentions];
      if (allSessionMentions.length > 0) {
        const refs = allSessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        textPrompt.text = `${textPrompt.text}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }
      if (fileMentionRefs.length > 0) {
        const block = buildFileRefsBlock(fileMentionRefs);
        if (block) textPrompt.text = `${textPrompt.text}\n\n${block}`;
      }
      if (agentMentionRefs.length > 0) {
        const block = buildAgentRefsBlock(agentMentionRefs);
        if (block) textPrompt.text = `${textPrompt.text}\n\n${block}`;
      }

      // Send via the SDK's promptRuntimeMessage — the server accepts the
      // prompt (204) and streams the response over SSE; we await the ACK so
      // callers (queue drain, input box) can handle send failures, but the
      // actual response body still arrives via the sync store.
      //
      // Don't send part IDs or messageID — let the server generate them with
      // its own clock. Client-generated IDs can sort before server IDs due to
      // clock skew (browser vs Docker container), causing the server's loop to
      // exit immediately thinking the prompt was already answered.
      const mappedParts = parts.map((p: any) => {
        if (p.type === 'file')
          return {
            type: 'file' as const,
            mime: p.mime,
            url: p.url,
            filename: p.filename,
          };
        return { type: 'text' as const, text: p.text };
      });
      const sendOpts = Object.keys(options).length > 0 ? options : undefined;

      // Sending to the sandbox's Runtime server can transiently fail — the
      // container may be waking from auto-stop, restarting, or the tunnel
      // blips. `promptRuntimeMessage` (packages/sdk) owns retrying transient
      // failures with backoff so a flaky send self-heals; only a real 4xx (bad
      // request / auth / missing model key), or exhausting the retry window,
      // surfaces here. The optimistic user message + busy status stay up the
      // whole time, so the UI shows the send in progress throughout. On
      // failure, `sendAndRecover` runs the shared recovery routine: clear
      // busy, then either rehydrate real messages from the server (some error
      // paths — e.g. missing API key — never emit a `session.error` SSE
      // event) or drop the optimistic message if the server has no record.
      const result = await sendAndRecover({
        sessionId,
        messageId: messageID,
        parts: mappedParts,
        options: {
          // Pass the session's directory so opencode resolves project-scoped
          // agents (.opencode/agent/*.md under the project) and applies them
          // when the user picked a project agent from the picker.
          ...(session?.directory ? { directory: session.directory } : {}),
          ...(sendOpts?.agent ? { agent: sendOpts.agent } : {}),
          ...(sendOpts?.model ? { model: formatPromptModel(sendOpts.model as ModelKey) } : {}),
          ...(sendOpts?.variant ? { variant: sendOpts.variant } : {}),
        } as any,
        classify: classifySessionError,
      });
      if (!result.ok) {
        setCommandError(result.error);
        throw result.cause instanceof Error ? result.cause : new Error(result.error.message);
      }

      return messageID;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionId,
      lockedAgentName,
      local.agent.current,
      local.model.currentKey,
      local.model.sendKey,
      local.model.variant.current,
      scrollToBottom,
      replyTo,
      messages,
    ],
  );

  // Expose this session's canonical sender so sibling surfaces (e.g. the
  // "Changes" side panel's "Ask agent to open a change request" button) can
  // drive the agent through the SAME robust path the input uses — optimistic
  // message, SSE wiring, error propagation — instead of copying a prompt to the
  // clipboard. Keyed by the Runtime chat session id (`sessionId`).
  const registerSender = useChatSendStore((s) => s.registerSender);
  const unregisterSender = useChatSendStore((s) => s.unregisterSender);
  useEffect(() => {
    registerSender(sessionId, (text: string) => handleSend(text));
    return () => unregisterSender(sessionId);
  }, [sessionId, handleSend, registerSender, unregisterSender]);

  // Drain the ENTIRE queue at once at the next safe boundary — a tool call
  // finishing (status flips to 'completed' or 'error'), or the turn going
  // idle (covers the case where a message was queued during what turns out
  // to be the LAST tool call, with nothing after it to hit). Everything
  // queued goes out together as soon as one boundary is hit; it does NOT
  // trickle out one message per subsequent boundary. Tracks tool completions
  // it's already reacted to in a ref so re-renders don't re-fire.
  const seenCompletedToolIdsRef = useRef<Set<string>>(new Set());
  const wasBusyForDrainRef = useRef(isBusy);
  useEffect(() => {
    let hitToolBoundary = false;
    if (messages) {
      const seen = seenCompletedToolIdsRef.current;
      for (const m of messages) {
        if (m.info.role !== 'assistant') continue;
        for (const part of m.parts) {
          if (part.type !== 'tool') continue;
          const status = (part as ToolPart).state?.status;
          if ((status === 'completed' || status === 'error') && !seen.has(part.id)) {
            seen.add(part.id);
            hitToolBoundary = true;
          }
        }
      }
    }

    const wasBusy = wasBusyForDrainRef.current;
    wasBusyForDrainRef.current = isBusy;
    const hitIdleBoundary = wasBusy && !isBusy;

    if (!hitToolBoundary && !hitIdleBoundary) return;

    const queue = queuedMessagesRef.current;
    if (queue.length === 0) return;

    setQueuedMessages([]);
    void (async () => {
      const failed: QueuedMessage[] = [];
      for (const item of queue) {
        try {
          await handleSend(item.text, item.files, item.mentions);
        } catch {
          failed.push(item);
        }
      }
      // Send failures are already surfaced via commandError — put any back
      // so the user doesn't silently lose the queued draft.
      if (failed.length > 0) setQueuedMessages((cur) => [...failed, ...cur]);
    })();
  }, [messages, isBusy, handleSend]);

  // NOTE: no client-side "auto-continue after approval" here — resuming the
  // agent when nobody was holding the gated call is the RESOLVE ENDPOINT's job
  // (server-side continueSession delivery in r7.ts), so it works with zero
  // browsers open. A web-side nudge would just double-send.

  const handleStop = useCallback(() => {
    // Guard against rapid clicks — ignore if an abort is already in flight
    if (abortSession.isPending) {
      console.log(`[handleStop] Ignoring - abort already in flight for session ${sessionId}`);
      return;
    }
    console.log(`[handleStop] Stopping session ${sessionId}`);
    // Optimistically mark the session idle + patch an abort error onto the
    // last assistant message (so the "Interrupted" label appears instantly —
    // no waiting for the SSE session.error round-trip). Also clear the busy
    // debounce timer to bypass the 2s delay.
    applyOptimisticAbort(sessionId);
    clearTimeout(busyTimerRef.current);
    setIsBusy(false);

    abortSession.mutate(sessionId);
  }, [sessionId, abortSession]);

  // ---- Triple-ESC to stop ----
  // ESC 1 → show hint (2 more). ESC 2 → show hint (1 more). ESC 3 → stop.
  // 4s cooloff window — resets if you wait too long between presses.
  const [escCount, setEscCount] = useState(0); // 0 = idle, 1 = first press, 2 = second press
  const escDeadlineRef = useRef(0);
  const escFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEscHint = useCallback(() => {
    escDeadlineRef.current = 0;
    setEscCount(0);
    if (escFadeTimerRef.current) {
      clearTimeout(escFadeTimerRef.current);
      escFadeTimerRef.current = null;
    }
  }, []);

  // When this SessionChat is not the active tab, make sure any lingering
  // ESC-counter state is cleared. Prevents stale "2 more to stop" hints from
  // being carried over when the user switches tabs.
  useEffect(() => {
    if (!isActiveSessionTab) clearEscHint();
  }, [isActiveSessionTab, clearEscHint]);

  useEffect(() => {
    // CRITICAL: all open session tabs are pre-mounted simultaneously by
    // SessionTabsContainer (see layout-content.tsx), so every mounted
    // SessionChat would otherwise receive the same window keydown event and
    // each busy session would independently advance its ESC counter and
    // abort itself on triple-ESC. Only the visible (active) session tab may
    // handle ESC — and never in read-only viewers (e.g. the sub-session
    // modal), which must not issue stop commands.
    if (!isActiveSessionTab || readOnly) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isBusy) return;

      // ESC was already consumed by something else — e.g. the composer's own
      // slash/mention popover (which calls preventDefault) or another focused
      // control that handled it — so it must never advance the stop counter.
      if (e.defaultPrevented) return;

      // ESC-to-stop is a page-wide shortcut: it must fire whether or not the
      // composer is focused, because users watch the agent run with focus
      // elsewhere (chat body, a tool view, or nothing at all). The only presses
      // we ignore are those meant for an open overlay the user is interacting
      // with — when focus sits inside a dialog/menu/popover/select, that ESC is
      // for dismissing it, not for stopping. (A hovered tooltip never takes
      // focus, so the stop button's own tooltip can't suppress the shortcut.)
      const active = document.activeElement;
      const focusInOverlay = active?.closest(
        '[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]',
      );
      if (focusInOverlay) return;

      e.preventDefault();

      const now = Date.now();
      const withinWindow = now < escDeadlineRef.current;

      if (withinWindow) {
        const currentCount = escDeadlineRef.current ? Math.max(1, escCount) : 0;
        if (currentCount >= 2) {
          // Third ESC → stop
          clearEscHint();
          handleStop();
        } else {
          // Second ESC → advance count, refresh cooloff
          setEscCount(2);
          escDeadlineRef.current = now + 4000;
          if (escFadeTimerRef.current) clearTimeout(escFadeTimerRef.current);
          escFadeTimerRef.current = setTimeout(() => {
            escDeadlineRef.current = 0;
            setEscCount(0);
          }, 4000);
        }
      } else {
        // First ESC (or cooloff expired) → start fresh
        setEscCount(1);
        escDeadlineRef.current = now + 4000;
        if (escFadeTimerRef.current) clearTimeout(escFadeTimerRef.current);
        escFadeTimerRef.current = setTimeout(() => {
          escDeadlineRef.current = 0;
          setEscCount(0);
        }, 4000);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActiveSessionTab, readOnly, isBusy, handleStop, clearEscHint, escCount]);

  // Reset when session goes idle
  useEffect(() => {
    if (!isBusy) clearEscHint();
  }, [isBusy, clearEscHint]);

  // Ref-based guard against rapid double-fire of commands (replaces
  // the old executeCommand.isPending check from the TQ mutation).
  const commandInFlightRef = useRef(false);

  const handleCommand = useCallback(
    (cmd: Command, args?: string) => {
      if (commandInFlightRef.current) return;
      setCommandError(null);

      playSound('send');
      const label = args ? `/${cmd.name} ${args}` : `/${cmd.name}`;
      const selectedModel = local.model.sendKey
        ? formatModelString(local.model.sendKey)
        : undefined;
      const handleCommandError = (err?: unknown) => {
        setPendingCommand(null);
        setPendingUserMessage(null);
        setPendingUserMessageId(null);
        setPollingActive(false);
        pendingCommandStashRef.current = null;
        useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
        setCommandError(classifySessionError(err));
      };

      setPendingCommand({
        name: cmd.name,
        description: args || cmd.description,
      });
      pendingCommandStashRef.current = {
        name: cmd.name,
        args: args || cmd.description,
      };
      setPendingUserMessage(label);
      setPendingUserMessageId(null);
      setPollingActive(true);
      lastSendTimeRef.current = Date.now();

      // Match SolidJS reference (submit.ts:259-289): fire command
      // directly via SDK — no TanStack Query, no mutation retry, no
      // optimistic message. The server creates the user message and
      // SSE delivers it. Commands use the blocking /command endpoint
      // which can take minutes; using TQ would cause retry on timeout.
      commandInFlightRef.current = true;
      const client = getClient();
      void client.session
        .command({
          sessionID: sessionId,
          command: cmd.name,
          arguments: args || '',
          ...((lockedAgentName || local.agent.current?.name) && {
            agent: lockedAgentName || local.agent.current?.name,
          }),
          ...(selectedModel && { model: selectedModel }),
          ...(local.model.variant.current && {
            variant: local.model.variant.current,
          }),
        } as any)
        .then((res: any) => {
          if (res?.error) {
            handleCommandError(res.error);
          }
        })
        .catch(handleCommandError)
        .finally(() => {
          commandInFlightRef.current = false;
        });
      setTimeout(() => scrollToBottom(), 50);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionId,
      scrollToBottom,
      lockedAgentName,
      local.agent.current,
      local.model.currentKey,
      local.model.sendKey,
      local.model.variant.current,
    ],
  );

  const handleFileSearch = useCallback(async (query: string): Promise<string[]> => {
    try {
      return await searchWorkspaceFiles(query);
    } catch {
      return [];
    }
  }, []);

  const pathname = usePathname();
  const router = useRouter();

  // Thread context for subsessions only (real parentID).
  const { data: parentSessionData } = useRuntimeSession(session?.parentID || '');
  const threadContext = useMemo(() => {
    if (!session?.parentID || !parentSessionData) return undefined;
    const projectRoute = pathname?.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)/);
    return {
      parentTitle: parentSessionData.title || 'Parent session',
      onBackToParent: () => {
        if (projectRoute) {
          const [, projectId, projectSessionId] = projectRoute;
          const href = parentSessionData.parentID
            ? `/projects/${projectId}/sessions/${projectSessionId}?oc=${encodeURIComponent(parentSessionData.id)}`
            : `/projects/${projectId}/sessions/${projectSessionId}`;
          router.push(href);
          return;
        }
        openTabAndNavigate({
          id: parentSessionData.id,
          title: parentSessionData.title || 'Parent session',
          type: 'session',
          href: `/sessions/${parentSessionData.id}`,
        });
      },
    };
  }, [session?.parentID, parentSessionData, pathname, router]);

  // ============================================================================
  // Loading / Not-found states
  // ============================================================================
  //
  // IMPORTANT: Do NOT use early returns here. Returning a different component
  // tree unmounts the textarea, losing user input, focus, and all local state.
  // Instead, the loading/not-found states are rendered inline in the content
  // area while the header and input remain mounted.

  // Show loader ONLY when we have zero knowledge about this session.
  // Once session metadata is available (from cache, placeholderData, or
  // fetch), skip the loader and show the content area immediately — the
  // welcome screen for empty sessions, cached messages for non-empty ones.
  // This eliminates the loader for empty sessions entirely: instead of
  // spinning while we wait to confirm "0 messages", we show the welcome
  // screen right away.
  const hasMessages = messages && messages.length > 0;
  // "Not found" is a TERMINAL answer, never a loading guess. It's only true once
  // the runtime is connected AND the session lookup has actually run and come
  // back empty. While the runtime is still connecting (the query is disabled and
  // therefore reports isLoading=false) or the lookup is in flight, we know
  // nothing yet — so we must show the loading state, not the error. This is what
  // stops the "This session is not accessible right now." flash on boot.
  const sessionResolved = runtimeReady && sessionFetched;
  const isNotFound = !session && sessionResolved && !optimisticPrompt;
  // Everything that isn't "we have content" and isn't the terminal not-found
  // state is loading — including the boot window where the query is still
  // disabled (isLoading=false) waiting on the runtime.
  const isDataLoading = !session && !isNotFound && !hasMessages && !optimisticPrompt;
  const showOptimistic = !!optimisticPrompt && !hasMessages;
  const isTransitioningFromWelcome = !prevHasChatContentRef.current && hasChatContent;
  // The welcome wallpaper is the EMPTY-STATE backdrop for a *resolved* session.
  // The loading/connecting phase never reaches here (it early-returns the loader
  // below), so this only needs to exclude the not-found screen.
  const shouldShowWelcomeOverlay =
    !isNotFound && (!hasChatContent || welcomeFadeActive || isTransitioningFromWelcome);

  // The welcome wallpaper. When SessionLayout provides a root-level wallpaper
  // layer we portal it in there so it spans the FULL session width (never
  // squished into the chat panel when the side panel is open); otherwise it
  // renders inline (mobile / standalone, where the chat panel is full width).
  const welcomeWallpaper = shouldShowWelcomeOverlay ? (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-0 transition-opacity ease-out',
        hasChatContent ? 'opacity-0' : 'opacity-100',
      )}
      style={{ transitionDuration: `${WELCOME_FADE_MS}ms` }}
    >
      <SessionWelcome />
    </div>
  ) : null;

  // While the session is still connecting / loading its content, render ONLY the
  // staged loader — never the session shell (header + input) at the same time.
  // Showing both reads as "loaded and loading at once" (the very contradiction
  // the loader exists to avoid). The connection keeps running in the parent
  // ProjectSessionRuntimeConnection, so as soon as the runtime is ready
  // isDataLoading flips and the full shell renders in one shot.
  if (isDataLoading) {
    return (
      <div className="bg-background relative flex h-full flex-col" data-testid="session-chat">
        <SessionStartingLoader stage="ready" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex h-full flex-col pt-10',
        // Transparent in the welcome state so the root-level full-bleed wallpaper
        // (portaled into SessionLayout) reads through; solid once real content
        // takes over. Same base color either way, so non-welcome is unchanged.
        shouldShowWelcomeOverlay ? 'bg-transparent' : 'bg-background',
      )}
      data-testid="session-chat"
    >
      {/* Full-bleed welcome wallpaper — spans the entire session (behind header,
          messages, project selector, and chat input). Input renders as frosted
          glass so the wallpaper reads through uninterrupted. Portaled into
          SessionLayout's root layer when present so it stays full width even
          with the side panel open; falls back to inline otherwise. */}
      {wallpaperLayer
        ? welcomeWallpaper && createPortal(welcomeWallpaper, wallpaperLayer)
        : welcomeWallpaper}

      {/* Session header — always mounted */}
      {!hideHeader && (
        <SessionSiteHeader
          sessionId={sessionId}
          sessionTitle={session?.title || 'Untitled'}
          onToggleSidePanel={handleTogglePanel}
          isSidePanelOpen={isSidePanelOpen}
          leadingAction={headerLeadingAction}
        />
      )}

      {/* Context modal — triple-click the session title area to open */}
      <SessionContextModal
        open={contextModalOpen}
        onOpenChange={setContextModalOpen}
        messages={messages}
        session={session}
        providers={providers}
        allSessions={allSessions}
      />

      {/* Content area — loading, not-found, or actual messages. The single
          session loader (SessionStartingLoader) carries through here on its
          "Connecting" phase so there's never a second, different loader. */}
      {isNotFound ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-muted-foreground text-sm">
            {tHardcodedUi.raw(
              'componentsSessionSessionChat.line5821JsxTextThisSessionIsNotAccessibleRightNow',
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              try {
                if (sessionId) useTabStore.getState().closeTab?.(sessionId);
              } catch {}
              if (typeof window !== 'undefined') window.location.assign('/');
            }}
            className="text-primary text-sm hover:underline"
          >
            {tHardcodedUi.raw('componentsSessionSessionChat.line5833JsxTextGoToHome')}
          </button>
        </div>
      ) : (
        <div ref={chatAreaRef} className="relative z-10 min-h-0 flex-1">
          <div
            ref={scrollContainerCallbackRef}
            className={cn(
              'scrollbar-hide relative z-10 h-full flex-1 overflow-y-auto [scroll-behavior:auto] px-4 py-4',
              shouldShowWelcomeOverlay ? 'bg-transparent' : 'bg-background',
            )}
            onMouseUp={handleChatMouseUp}
            onMouseDown={handleChatMouseDown}
            onScroll={handleChatScroll}
          >
            <div
              ref={contentRef}
              role="log"
              className="mx-auto w-full max-w-3xl min-w-0 px-3 sm:px-6"
            >
              <div className="flex min-w-0 flex-col">
                {/* Optimistic user message */}
                {showOptimistic && (
                  <div data-turn-id="optimistic" className="mt-12 first:mt-0">
                    <div className="flex justify-end">
                      <div className="bg-card flex max-w-[90%] flex-col overflow-hidden rounded-3xl rounded-br-lg border">
                        {(() => {
                          const { cleanText: afterReply, replyContext: optReply } =
                            parseReplyContext(optimisticPrompt || '');
                          const { cleanText: afterFiles, files } = parseFileReferences(afterReply);
                          const { cleanText: afterProjects } = parseProjectReferences(afterFiles);
                          const { cleanText: afterFileMentions } =
                            parseFileMentionReferences(afterProjects);
                          const { cleanText: afterAgentMentions } =
                            parseAgentMentionReferences(afterFileMentions);
                          const { cleanText } = parseSessionReferences(afterAgentMentions);
                          return (
                            <>
                              {optReply && (
                                <div className="bg-primary/5 border-primary/10 mx-3 mt-3 mb-0 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
                                  <Reply className="text-primary/60 size-3 flex-shrink-0" />
                                  <span className="text-muted-foreground truncate text-xs">
                                    {optReply.length > 150
                                      ? `${optReply.slice(0, 150)}...`
                                      : optReply}
                                  </span>
                                </div>
                              )}
                              {files.length > 0 && (
                                <div className="flex flex-wrap gap-2 p-3 pb-0">
                                  {files.map((f, i) => (
                                    <div key={i} onClick={(e) => e.stopPropagation()}>
                                      <GridFileCard
                                        filePath={f.path}
                                        fileName={f.path.split('/').pop() || f.path}
                                        onClick={() => openPreview(f.path)}
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
                                    onFileClick={openFileInComputer}
                                  />
                                </p>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    <AssistantPendingRow className="mt-6" />
                  </div>
                )}

                {isOptimisticCompacting && !hasCompactionTurn && (
                  <div className="mt-12 space-y-3">
                    <div className="my-3 flex items-center gap-3 py-4">
                      <div className="bg-border h-px flex-1" />
                      <div className="bg-muted/80 border-border/60 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
                        <Layers className="text-muted-foreground size-3.5" />
                        <span className="text-muted-foreground text-xs font-semibold tracking-wide">
                          Compaction
                        </span>
                      </div>
                      <div className="bg-border h-px flex-1" />
                    </div>
                    <div className="flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src="/kortix-logomark-white.svg"
                        alt="Kortix"
                        className="h-[14px] w-auto flex-shrink-0 invert dark:invert-0"
                      />
                      <div className="text-muted-foreground text-sm">
                        {tHardcodedUi.raw(
                          'componentsSessionSessionChat.line5954JsxTextCompactingSession',
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Turn-based message rendering.
                    ToolActivateContext makes inline tool rows open the side
                    panel (Actions) focused on that tool, instead of expanding. */}
                <ToolActivateContext.Provider value={toolActivate}>
                  {turns.map((turn, turnIndex) => {
                    // Check if this turn is a compaction summary
                    const hasCompaction =
                      turn.assistantMessages.some((msg) => (msg.info as any).summary === true) ||
                      turn.assistantMessages.some((msg) =>
                        msg.parts.some((p) => p.type === 'compaction'),
                      );

                    // Notification-only early-return removed: it rendered the
                    // user's pty_* card but skipped turn.assistantMessages,
                    // hiding every subsequent assistant response in that turn.
                    // Fall through to the normal turn renderer instead.

                    return (
                      <div
                        key={turn.userMessage.info.id}
                        data-turn-id={turn.userMessage.info.id}
                        className={turnIndex === 0 ? '' : 'mt-12'}
                      >
                        {/* Compaction divider — shown before the first turn after compaction */}
                        {hasCompaction && (
                          <div className="my-3 flex items-center gap-3 py-4">
                            <div className="bg-border h-px flex-1" />
                            <div className="bg-muted/80 border-border/60 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
                              <Layers className="text-muted-foreground size-3.5" />
                              <span className="text-muted-foreground text-xs font-semibold tracking-wide">
                                Compaction
                              </span>
                            </div>
                            <div className="bg-border h-px flex-1" />
                          </div>
                        )}
                        <SessionTurn
                          turn={turn}
                          allMessages={messages!}
                          sessionId={sessionId}
                          sessionStatus={sessionStatus}
                          permissions={pendingPermissions}
                          questions={pendingQuestions}
                          agentNames={agentNames}
                          isFirstTurn={turnIndex === 0}
                          isBusy={isBusy}
                          isCompaction={hasCompaction}
                          providers={providers}
                          commandMessages={commandMessagesRef.current}
                          commands={commands}
                          disableToolNavigation={disableToolNavigation}
                          onPermissionReply={handlePermissionReply}
                        />
                      </div>
                    );
                  })}
                </ToolActivateContext.Provider>

                {/* Busy indicator when no turns yet but session is busy */}
                {commandError && <TurnErrorDisplay error={commandError} className="mt-2" />}
                {!showOptimistic && isBusy && turns.length === 0 && <AssistantPendingRow />}
              </div>
              {/* Spacer — ensures the last message can scroll to the top of
						    the viewport (ChatGPT-style). Without this, scrollToBottom
						    only brings the last message to the bottom of the screen.
						    Height is dynamically measured from the scroll container so
						    the newest message appears flush at the top. */}
              <div ref={spacerElRef} />
            </div>
          </div>

          {/* Selection "Reply" popup — floats near selected text */}
          {selectionPopup && (
            <div
              data-reply-popup
              className="animate-in fade-in-0 slide-in-from-bottom-1 absolute z-50 duration-150"
              style={{
                left: `${selectionPopup.x}px`,
                top: `${selectionPopup.y}px`,
                transform: 'translate(-50%, -100%)',
              }}
            >
              <Button
                onClick={handleSelectionReply}
                variant="outline"
                size="toolbar"
                className="bg-popover shadow-md"
              >
                <Reply className="size-3.5" />
                Reply
              </Button>
            </div>
          )}

          {/* Chat Minimap */}
          <ChatMinimap
            turns={turns}
            scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
            contentRef={contentRef as React.RefObject<HTMLDivElement>}
            messages={messages || []}
          />

          {/* Scroll to bottom FAB */}
          <div
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2 transition-colors duration-300 ease-out',
              showScrollButton
                ? 'translate-y-0 scale-100 opacity-100'
                : 'pointer-events-none translate-y-4 scale-95 opacity-0',
            )}
          >
            <Button
              variant="outline"
              size="sm"
              className="bg-background/90 border-border/60 h-7 rounded-full text-xs shadow-lg"
              onClick={smoothScrollToAbsoluteBottom}
            >
              <ArrowDown className="mr-1 size-3" />
              {tHardcodedUi.raw('componentsSessionSessionChat.line6095JsxTextScrollToBottom')}
            </Button>
          </div>
        </div>
      )}

      {/* Input — hidden in read-only mode (sub-session modal) */}
      {!readOnly && (
        <SessionChatInput
          onSend={async (text, files, mentions) => {
            await handleSend(text, files, mentions);
          }}
          isBusy={isBusy}
          queuedMessages={queuedMessages}
          onQueueMessage={handleQueueMessage}
          onRemoveQueuedMessage={handleRemoveQueuedMessage}
          onStop={handleStop}
          escCount={escCount}
          agents={local.agent.list}
          selectedAgent={lockedAgentName ?? local.agent.current?.name ?? null}
          onAgentChange={lockedAgentName ? undefined : (name) => local.agent.set(name ?? undefined)}
          agentSelectorLocked={!!lockedAgentName}
          commands={commands || []}
          onCommand={handleCommand}
          models={local.model.list}
          selectedModel={local.model.currentKey ?? null}
          onModelChange={(m) => local.model.set(m ?? undefined, { recent: true })}
          modelDefaultControls={{
            agentName: lockedAgentName ?? local.agent.current?.name,
            onSetAccountDefault: (m) => {
              void local.model.defaults.setAccountDefault(m);
            },
            onSetAgentDefault:
              lockedAgentName || local.agent.current
                ? (m) => {
                    const name = lockedAgentName ?? local.agent.current?.name;
                    if (name) void local.model.defaults.setAgentDefault(name, m);
                  }
                : undefined,
            onSetProjectDefault: (m) => {
              void local.model.defaults.setProjectDefault(m);
            },
          }}
          variants={local.model.variant.list}
          selectedVariant={local.model.variant.current ?? null}
          onVariantChange={(v) => local.model.variant.set(v ?? undefined)}
          messages={messages}
          sessionId={sessionId}
          onFileSearch={handleFileSearch}
          providers={providers}
          modelRequired
          threadContext={threadContext}
          onContextClick={() => setContextModalOpen(true)}
          replyTo={replyTo}
          onClearReply={handleClearReply}
          // Only lock the input into question-answer mode while the session is
          // actually busy (a live question keeps the run busy). If a question
          // chip is ever showing while the session is idle — e.g. a dead /
          // abandoned question the agent left behind — the input stays unlocked
          // so a typed message is sent to the agent instead of being swallowed
          // as a custom answer.
          lockForQuestion={!!renderedQuestion && isBusy}
          // Same dead-prompt guard as questions: only lock while the agent is
          // actually paused on the decision (isBusy), so a stale card can't
          // swallow the composer on an idle session.
          lockForApproval={hasPendingApproval || (pendingPermissions.length > 0 && isBusy)}
          onCustomAnswer={(text) => {
            questionPromptRef.current?.submitCustomAnswer(text);
          }}
          questionButtonLabel={renderedQuestion ? questionAction.label : null}
          questionCanAct={questionAction.canAct}
          onQuestionAction={() => {
            questionPromptRef.current?.performAction();
          }}
          inputSlot={
            <>
              {/* Connector actions a policy gated for approval — pauses the run
                  until the human decides. Self-hides when nothing's pending. */}
              <SessionApprovalPrompt />
              {/* Opencode tool permissions (bash/edit/…) awaiting a decision —
                  the turn is blocked inside the runtime and resumes the moment
                  a reply lands. Self-hides when nothing's pending. */}
              <SessionPermissionPrompt
                sessionId={sessionId}
                permissions={pendingPermissions}
                onReply={handlePermissionReply}
              />
              {renderedQuestion ? (
                <div
                  className={cn(
                    'overflow-hidden transition-[max-height,opacity,transform] ease-in-out',
                    questionPromptVisible
                      ? 'max-h-[520px] translate-y-0 opacity-100 duration-300'
                      : 'pointer-events-none max-h-0 -translate-y-1 opacity-0 duration-320',
                  )}
                >
                  <QuestionPrompt
                    key={renderedQuestion.id}
                    ref={questionPromptRef}
                    request={renderedQuestion}
                    onReply={handleQuestionReply}
                    onReject={handleQuestionReject}
                    onActionChange={handleQuestionActionChange}
                  />
                </div>
              ) : null}
            </>
          }
        />
      )}
    </div>
  );
}
