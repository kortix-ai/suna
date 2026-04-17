'use client';

import {
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  ArrowUpLeft,
  Brain,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Search,
  ChevronUp,
  Copy,
  Cpu,
  ExternalLink,
  FileText,
  GitFork,
  Image as ImageIcon,
  Layers,
  ListPlus,
  Loader2,
  MessageSquare,
  Pencil,
  Reply,
  Scissors,
  Send,
  Terminal,
  Timer,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { SandboxImage } from '@/components/session/sandbox-image';

import { ConnectProviderDialog } from '@/components/session/model-selector';
import {
  type AttachedFile,
  SessionChatInput,
  type TrackedMention,
} from '@/components/session/session-chat-input';
import { SessionContextModal } from '@/components/session/session-context-modal';
import {
  SessionRetryDisplay,
  TurnErrorDisplay,
} from '@/components/session/session-error-banner';
import { SessionSiteHeader } from '@/components/session/session-site-header';
import {
  QuestionPrompt,
  type QuestionPromptHandle,
  type QuestionAction,
} from '@/components/session/question-prompt';
import { SessionWelcome } from '@/components/session/session-welcome';
import { GridFileCard } from '@/components/thread/file-attachment/GridFileCard';

import { ToolPartRenderer } from '@/components/session/tool-renderers';
import {
  contextToolSummary,
  contextToolTrigger,
} from '@/components/session/tool-meta';
import { SandboxUrlDetector } from '@/components/thread/content/sandbox-url-detector';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { uploadFile } from '@/features/files/api/opencode-files';
import { searchWorkspaceFiles } from '@/features/files';
import { useOpenCodeConfig } from '@/hooks/opencode/use-opencode-config';
import {
  useOpenCodeLocal,
  parseModelKey,
  formatModelString,
} from '@/hooks/opencode/use-opencode-local';
import type {
  PromptPart,
  ProviderListResponse,
} from '@/hooks/opencode/use-opencode-sessions';
import {
  ascendingId,
  rejectQuestion,
  replyToPermission,
  replyToQuestion,
  useAbortOpenCodeSession,
  useForkSession,
  useOpenCodeAgents,
  useOpenCodeCommands,
  useOpenCodeProviders,
  useOpenCodeSession,
  useOpenCodeSessions,
} from '@/hooks/opencode/use-opencode-sessions';
import { useSessionSync } from '@/hooks/opencode/use-session-sync';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { getClient } from '@/lib/opencode-sdk';
// billingApi / invalidateAccountState / useQueryClient removed — billing is handled server-side by the router
import { playSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';
import {
  stripKortixSystemTags,
  extractSessionReport,
  extractKortixSystemMessages,
  type SessionReport,
  type KortixSystemMessage,
} from '@/lib/utils/kortix-system-tags';
import { SubSessionModal } from '@/components/session/sub-session-modal';
import { ChatMinimap } from '@/components/session/chat-minimap';
import { useMessageJumpStore } from '@/stores/message-jump-store';
import { toast as sonnerToast } from 'sonner';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  useMessageQueueStore,
  selectSessionItems,
  type QueuedMessage,
} from '@/stores/message-queue-store';
import { useMessageQueueDrain } from '@/hooks/opencode/use-message-queue-drain';
import { usePendingFilesStore } from '@/stores/pending-files-store';
import { useOpenCodePendingStore } from '@/stores/opencode-pending-store';
import { useOpenCodeCompactionStore } from '@/stores/opencode-compaction-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useOnboardingModeStore } from '@/stores/onboarding-mode-store';
import { useSyncStore } from '@/stores/opencode-sync-store';
import { useServerStore } from '@/stores/server-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import { useSelectedProjectStore } from '@/stores/selected-project-store';
import { useKortixProjects } from '@/hooks/kortix/use-kortix-projects';
import {
  appendProjectRefs,
  buildProjectRefsBlock,
  buildFileRefsBlock,
  buildAgentRefsBlock,
  type ProjectRefLike,
  type FileRefLike,
  type AgentRefLike,
} from '@/lib/project-preamble';
import { ProjectSelector } from '@/components/dashboard/project-selector';
// Shared UI primitives (framework-agnostic, reusable on mobile)
import {
  type AgentPart,
  type Command,
  collectTurnParts,
  type FilePart,
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
  hasDiffs,
  isAgentPart,
  isAttachment,
  isCompactionPart,
  isFilePart,
  isLastUserMessage,
  isPatchPart,
  isReasoningPart,
  isShellMode,
  isSnapshotPart,
  isTextPart,
  isToolPart,
  isToolPartHidden,
  type MessageWithParts,
  type Part,
  type PartWithMessage,
  type PatchPart,
  type PermissionRequest,
  type QuestionRequest,
  type ReasoningPart,
  type RetryInfo,
  type SnapshotPart,
  shouldShowToolPart,
  splitUserParts,
  type TextPart,
  type ToolPart,
  type Turn,
  type TurnCostInfo,
} from '@/ui';

// ============================================================================
// Reply-to context (select & reply feature)
// ============================================================================

/** Selected text the user wants to reference in their next message. */
export interface ReplyToContext {
  text: string;
}

// ============================================================================
// Sub-Session / Fork Breadcrumb
// ============================================================================

// SubSessionBar removed — subsessions now use SessionSiteHeader + chat input indicator

function forkDraftKey(sessionId: string) {
  return `opencode_fork_prompt:${sessionId}`;
}

function buildForkPrompt(parts: Part[], text?: string): PromptPart[] {
  const next: PromptPart[] = [];
  const value =
    text ??
    parts.find(
      (part): part is TextPart =>
        isTextPart(part) && !part.synthetic && !part.ignored,
    )?.text ??
    '';
  if (value) next.push({ type: 'text', text: value });
  for (const part of parts) {
    if (!isFilePart(part) || !part.url) continue;
    next.push({
      type: 'file',
      mime: part.mime || 'application/octet-stream',
      url: part.url,
      filename: part.filename,
    });
  }
  return next;
}

function stashForkPrompt(sessionId: string, prompt: PromptPart[]) {
  if (typeof window === 'undefined' || prompt.length === 0) return;
  sessionStorage.setItem(forkDraftKey(sessionId), JSON.stringify(prompt));
}

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
      typeof data?.modelID === 'string' && data.modelID
        ? data.modelID
        : 'selected model';
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

// ============================================================================
// System message indicator — subtle inline pill for kortix_system messages
// ============================================================================

function SystemMessageIndicator({
  messages,
}: {
  messages: KortixSystemMessage[];
}) {
  if (messages.length === 0) return null;

  // Combine all messages into a single line: "Autowork · iteration 3/50"
  const parts = messages.map((msg) =>
    msg.detail ? `${msg.label} · ${msg.detail}` : msg.label,
  );
  const text = parts.join('  ·  ');

  return (
    <div className="flex items-center gap-2 -my-1">
      <div className="flex-1 h-px bg-border/30" />
      <span className="text-[10px] text-muted-foreground/30 select-none whitespace-nowrap">
        {text}
      </span>
      <div className="flex-1 h-px bg-border/30" />
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
  const questions: Array<{ question: string; options?: { label: string }[] }> =
    Array.isArray(input.questions) ? input.questions : [];
  const answers: string[][] = Array.isArray(metadata.answers)
    ? metadata.answers
    : [];
  if (questions.length === 0 || answers.length === 0) return null;

  const answeredCount = answers.filter((a) => a.length > 0).length;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="flex items-center gap-1.5 w-full px-2.5 py-1.5 h-auto text-left rounded-none justify-start hover:bg-muted/40"
          >
            <MessageSquare className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium text-foreground">
              Questions
            </span>
            <span className="text-[11px] text-muted-foreground/70">
              {answeredCount} answered
            </span>
            <ChevronDown
              className={cn(
                'size-3 text-muted-foreground ml-auto transition-transform',
                expanded && 'rotate-180',
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/30">
            {questions.map((q, i) => {
              const answer = answers[i] || [];
              const answerText = answer.join(', ') || 'No answer';
              return (
                <div
                  key={i}
                  className="px-2.5 py-2 border-b border-border/30 last:border-b-0"
                >
                  <div className="[&_*]:!text-muted-foreground/70 [&_p]:!my-0 [&_p]:!leading-relaxed [&_p]:!text-[11px] [&_ul]:!my-0 [&_ol]:!my-0 [&_li]:!my-0 [&_code]:!text-[10px] [&_strong]:!text-muted-foreground/60">
                    <UnifiedMarkdown content={q.question} />
                  </div>
                  <div className="text-sm font-medium text-foreground mt-0.5">
                    {answerText}
                  </div>
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
  projectNames,
  onFileClick,
  onProjectClick,
}: {
  text: string;
  agentNames?: string[];
  projectNames?: string[];
  onFileClick?: (path: string) => void;
  onProjectClick?: (name: string) => void;
}) {
  // Strip every ref block (project/file/agent/session) before processing
  // inline @ mentions so the visible text never shows raw XML.
  const { cleanText, sessions, projects } = useMemo(() => {
    const a = parseProjectReferences(text);
    const b = parseFileMentionReferences(a.cleanText);
    const c = parseAgentMentionReferences(b.cleanText);
    const d = parseSessionReferences(c.cleanText);
    return {
      cleanText: d.cleanText,
      sessions: d.sessions,
      projects: a.projects,
    };
  }, [text]);

  const segments = useMemo(() => {
    type MentionType = 'file' | 'agent' | 'session' | 'project';
    if (!cleanText)
      return [{ text: cleanText, type: undefined as MentionType | undefined }];

    // Detect session @mentions first (titles can contain spaces)
    const sessionDetected: { start: number; end: number; type: MentionType }[] =
      [];
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
    // Known project names: parsed refs + anything the caller passes in.
    const projectSet = new Set<string>([
      ...projects.map((p) => p.name),
      ...(projectNames || []),
    ]);
    const mentionRegex = /@(\S+)/g;
    const detected: { start: number; end: number; type: MentionType }[] = [
      ...sessionDetected,
    ];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(cleanText)) !== null) {
      const mStart = match.index;
      // Skip if overlaps with a session mention
      if (sessionDetected.some((s) => mStart >= s.start && mStart < s.end))
        continue;
      const name = match[1];
      // Treat @ses_<id> tokens as session mentions
      const type: MentionType = name.startsWith('ses_')
        ? 'session'
        : projectSet.has(name)
          ? 'project'
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
      if (ref.start > lastIndex)
        result.push({ text: cleanText.slice(lastIndex, ref.start) });
      result.push({
        text: cleanText.slice(ref.start, ref.end),
        type: ref.type,
      });
      lastIndex = ref.end;
    }
    if (lastIndex < cleanText.length)
      result.push({ text: cleanText.slice(lastIndex) });
    return result;
  }, [cleanText, agentNames, projectNames, sessions, projects]);

  // Uniform monochrome mention style — Kortix brand is strictly neutral, so
  // every mention kind (file / agent / session / project) renders identically
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
                  serverId: useServerStore.getState().activeServerId,
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
                  serverId: useServerStore.getState().activeServerId,
                });
              }
            }}
          >
            {seg.text}
          </span>
        ) : seg.type === 'project' ? (
          <span
            key={i}
            className={mentionClass}
            onClick={(e) => {
              e.stopPropagation();
              const raw = seg.text.replace(/^@/, '');
              const ref = projects.find((p) => p.name === raw);
              if (onProjectClick) {
                onProjectClick(raw);
                return;
              }
              if (ref?.id) {
                openTabAndNavigate({
                  id: `project:${ref.id}`,
                  title: ref.name,
                  type: 'project',
                  href: `/projects/${encodeURIComponent(ref.id)}`,
                });
              }
            }}
          >
            {seg.text}
          </span>
        ) : (
          <span
            key={i}
            className={cn(
              (seg.type === 'file' || seg.type === 'agent') && mentionClassStatic,
            )}
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
  const projects: ParsedProjectRef[] = [];
  // Non-greedy [\s\S] so attribute values can contain slashes, quotes,
  // newlines, em-dashes, etc. — the broken `[^/]*` version stopped at the
  // first `/` inside `path="/workspace/..."`.
  let cleaned = text.replace(
    /<project_ref\b([\s\S]*?)\/>/g,
    (_, attrs: string) => {
      const pick = (key: string): string | undefined => {
        const m = attrs.match(new RegExp(`${key}="([^"]*?)"`));
        return m ? unescapeAttr(m[1]) : undefined;
      };
      const name = pick('name');
      if (name) {
        projects.push({
          id: pick('id'),
          name,
          path: pick('path'),
          description: pick('description'),
        });
      }
      return '';
    },
  );
  // Strip the instruction header (description uses [^)]* which is safe
  // because the header never contains a literal `)` before its closing one).
  cleaned = cleaned
    .replace(/\n*Referenced projects \([^)]*\):\n?/g, '')
    .trim();
  return { cleanText: cleaned, projects };
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
  let cleaned = text.replace(
    /<file_ref\b([\s\S]*?)\/>/g,
    (_, attrs: string) => {
      const pick = (key: string): string | undefined => {
        const m = attrs.match(new RegExp(`${key}="([^"]*?)"`));
        return m ? unescapeAttr(m[1]) : undefined;
      };
      const path = pick('path');
      const name = pick('name') ?? path;
      if (path) files.push({ path, name: name || path });
      return '';
    },
  );
  cleaned = cleaned
    .replace(/\n*Referenced files \([^)]*\):\n?/g, '')
    .trim();
  return { cleanText: cleaned, files };
}

function parseAgentMentionReferences(text: string): {
  cleanText: string;
  agents: ParsedAgentMentionRef[];
} {
  const agents: ParsedAgentMentionRef[] = [];
  let cleaned = text.replace(
    /<agent_ref\b([\s\S]*?)\/>/g,
    (_, attrs: string) => {
      const pick = (key: string): string | undefined => {
        const m = attrs.match(new RegExp(`${key}="([^"]*?)"`));
        return m ? unescapeAttr(m[1]) : undefined;
      };
      const name = pick('name');
      if (name) agents.push({ name });
      return '';
    },
  );
  cleaned = cleaned
    .replace(/\n*Referenced agents \([^)]*\):\n?/g, '')
    .trim();
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
  const cleanText = text
    .replace(/<reply_context>[\s\S]*?<\/reply_context>\s*/, '')
    .trim();
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

const DCP_TAG_REGEX =
  /<dcp-notification\s+([^>]*)>([\s\S]*?)<\/dcp-notification>/g;
const DCP_ITEM_REGEX =
  /<dcp-item\s+tool="([^"]*?)"\s+description="([^"]*?)"\s*\/>/g;
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
        label: tag
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()),
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
    ? Math.round(parseFloat(tokenStr.slice(0, -1)) * 1000)
    : parseInt(tokenStr, 10);

  const pruningMatch = text.match(DCP_LEGACY_PRUNING_REGEX);
  let batchSaved = 0;
  let extractedTokens = 0;
  let reason: string | undefined;
  if (pruningMatch) {
    const batchStr = pruningMatch[1];
    batchSaved = batchStr.endsWith('K')
      ? Math.round(parseFloat(batchStr.slice(0, -1)) * 1000)
      : parseInt(batchStr, 10);
    if (pruningMatch[2]) {
      const extStr = pruningMatch[2];
      extractedTokens = extStr.endsWith('K')
        ? Math.round(parseFloat(extStr.slice(0, -1)) * 1000)
        : parseInt(extStr, 10);
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
      const type = (parseAttr(attrs, 'type') || 'prune') as
        | 'prune'
        | 'compress';
      const tokensSaved = parseInt(parseAttr(attrs, 'tokens-saved') || '0', 10);
      const batchSaved = parseInt(parseAttr(attrs, 'batch-saved') || '0', 10);
      const prunedCount = parseInt(parseAttr(attrs, 'pruned-count') || '0', 10);
      const extractedTokens = parseInt(
        parseAttr(attrs, 'extracted-tokens') || '0',
        10,
      );
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
      const distilled = distilledMatch
        ? unescapeXml(distilledMatch[1])
        : undefined;

      // Compress-specific
      const messagesCount =
        parseInt(parseAttr(attrs, 'messages-count') || '0', 10) || undefined;
      const toolsCount =
        parseInt(parseAttr(attrs, 'tools-count') || '0', 10) || undefined;
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

function DCPNotificationCard({
  notification,
}: {
  notification: DCPNotification;
}) {
  const [expanded, setExpanded] = useState(false);
  const isPrune = notification.type === 'prune';
  const hasItems = notification.items.length > 0;
  const hasDetails = hasItems || notification.distilled || notification.summary;

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 overflow-hidden">
      {/* Header */}
      <Button
        onClick={() => hasDetails && setExpanded(!expanded)}
        variant="ghost"
        className={cn(
          'flex items-center gap-2 w-full px-3 py-2 h-auto border-b border-border/40 bg-muted/30 rounded-none justify-start',
          !hasDetails && 'pointer-events-none',
        )}
      >
        <Scissors className="size-3.5 text-muted-foreground/70 flex-shrink-0" />
        <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
          {isPrune ? 'Context Pruned' : 'Context Compressed'}
        </span>

        {/* Stats pills */}
        <div className="flex items-center gap-1.5 ml-auto">
          {notification.reason && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground/70">
              {DCP_REASON_LABELS[notification.reason] || notification.reason}
            </span>
          )}
          {isPrune && notification.prunedCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500 font-medium">
              {notification.prunedCount} pruned
            </span>
          )}
          {!isPrune &&
            notification.messagesCount &&
            notification.messagesCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-500 font-medium">
                {notification.messagesCount} msgs
              </span>
            )}
          {notification.batchSaved > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 font-medium">
              -{formatDCPTokens(notification.batchSaved)} tokens
            </span>
          )}
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
            {formatDCPTokens(notification.tokensSaved)} saved
          </span>
          {hasDetails && (
            <ChevronDown
              className={cn(
                'size-3 text-muted-foreground/50 transition-transform',
                expanded && 'rotate-180',
              )}
            />
          )}
        </div>
      </Button>

      {/* Expandable details */}
      {expanded && hasDetails && (
        <div className="px-3 py-2 space-y-2">
          {/* Pruned items list */}
          {hasItems && (
            <div className="space-y-0.5">
              {notification.items.map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-[11px] text-muted-foreground/80"
                >
                  <span className="text-muted-foreground/40">&rarr;</span>
                  <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-muted/50 text-muted-foreground/70">
                    {item.tool}
                  </span>
                  {item.description && (
                    <span className="truncate max-w-[300px]">
                      {item.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Compress topic */}
          {notification.topic && (
            <div className="text-[11px] text-muted-foreground/80">
              <span className="text-muted-foreground/50">Topic:</span>{' '}
              <span>{notification.topic}</span>
            </div>
          )}

          {/* Distilled content */}
          {notification.distilled && (
            <div className="mt-1.5 border-t border-border/30 pt-1.5">
              <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1">
                Distilled
              </div>
              <div className="text-[11px] text-muted-foreground/80 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                {notification.distilled}
              </div>
            </div>
          )}

          {/* Compress summary */}
          {notification.summary && (
            <div className="mt-1.5 border-t border-border/30 pt-1.5">
              <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1">
                Summary
              </div>
              <div className="text-[11px] text-muted-foreground/80 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                {notification.summary}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemNotificationCard({
  notification,
}: {
  notification: SystemNotification;
}) {
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

  const isError =
    notification.tag.includes('failed') || notification.tag.includes('blocker');
  const isWarning = notification.tag.includes('stopped');

  const iconColor = isError
    ? 'text-destructive/50'
    : isWarning
      ? 'text-amber-500/50'
      : 'text-muted-foreground/50';

  const trigger = (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg',
        'bg-muted/20 border border-border/40',
        'text-xs select-none max-w-full',
        hasExpandable && 'cursor-pointer hover:bg-muted/40 transition-colors',
      )}
    >
      <Terminal className={cn('size-3.5 flex-shrink-0', iconColor)} />
      <span className="text-muted-foreground/70 truncate">
        {notification.label}
        {inlineDetail && (
          <span className="text-muted-foreground/40 ml-1.5 font-mono">
            {inlineDetail}
          </span>
        )}
      </span>
      {hasExpandable && (
        <ChevronRight
          className={cn(
            'size-3 text-muted-foreground/30 transition-transform flex-shrink-0 ml-auto',
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
        <div className="px-3 py-2 text-xs space-y-1 border border-t-0 border-border/40 rounded-b-lg bg-muted/10">
          {notification.fields.length > 0 && (
            <div className="space-y-0.5">
              {notification.fields.map(([key, value], i) => (
                <div key={i} className="flex gap-2 min-w-0">
                  <span className="text-muted-foreground/40 flex-shrink-0">
                    {key}:
                  </span>
                  <span className="text-muted-foreground/60 font-mono text-[11px] break-all">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          )}
          {notification.body && (
            <div className="text-muted-foreground/50 font-mono text-[11px] whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
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
    (p) =>
      isTextPart(p) &&
      !(p as TextPart).synthetic &&
      !(p as any).ignored,
  ) as TextPart[];
  if (textParts.length === 0) return false;
  const raw = textParts.map((p) => p.text || '').join('\n');
  const { cleanText, notifications } = parseSystemNotifications(
    stripKortixSystemTags(raw),
  );
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
      .filter(
        (p) =>
          isTextPart(p) &&
          !(p as TextPart).synthetic &&
          !(p as any).ignored,
      )
      .map((p) => (p as TextPart).text || '')
      .join('\n');
  }, [turn.userMessage.parts]);

  const { notifications } = useMemo(
    () => parseSystemNotifications(stripKortixSystemTags(rawText)),
    [rawText],
  );

  if (notifications.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {notifications.map((n, i) => (
        <SystemNotificationCard key={`${n.tag}-${i}`} notification={n} />
      ))}
    </div>
  );
}

// ============================================================================
// Edit Part Dialog — inline editing for text parts
// ============================================================================

function EditPartDialog({
  open,
  onOpenChange,
  initialText,
  onSave,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialText: string;
  onSave: (text: string) => void;
  loading?: boolean;
}) {
  const [text, setText] = useState(initialText);

  // Reset text when dialog opens with new content
  useEffect(() => {
    if (open) setText(initialText);
  }, [open, initialText]);

  const handleSave = () => {
    const trimmed = text.trim();
    if (trimmed && trimmed !== initialText) {
      onSave(trimmed);
    } else {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Edit fork prompt</DialogTitle>
          <DialogDescription>
            This creates a native fork at this message and opens the new session
            with your edited prompt restored in the composer.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 py-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-[120px] max-h-[50vh] h-full text-sm resize-y"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSave();
              }
            }}
          />
        </div>
        <DialogFooter className="flex-shrink-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={loading || !text.trim() || text.trim() === initialText}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin mr-1.5" />
            ) : null}
            Fork with edits
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmForkDialog({
  open,
  onOpenChange,
  onConfirm,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  loading?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fork session?</DialogTitle>
          <DialogDescription>
            This will create a new session from this point in the conversation.
            The fork opens separately and won&apos;t change this session.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={loading}>
            {loading ? (
              <Loader2 className="size-3.5 animate-spin mr-1.5" />
            ) : null}
            Fork session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Part Actions — edit & fork action for user message parts
// ============================================================================

function PartActions({
  part,
  isBusy,
  onEditFork,
  loading,
  className,
}: {
  part: Part;
  isBusy: boolean;
  onEditFork: (newText: string) => void;
  loading?: boolean;
  className?: string;
}) {
  const [editOpen, setEditOpen] = useState(false);

  // Only text parts are editable
  const isEditable = isTextPart(part) && !!(part as TextPart).text?.trim();
  const partText = isEditable ? (part as TextPart).text : '';

  if (!isEditable) return null;

  return (
    <>
      <div className={cn('flex items-center gap-0.5', className)}>
        {/* Edit & fork button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground/50"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Edit fork prompt
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Edit & fork dialog */}
      <EditPartDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initialText={partText}
        onSave={(newText) => {
          onEditFork(newText);
          setEditOpen(false);
        }}
        loading={loading}
      />
    </>
  );
}

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
  const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    const captures = fullTemplateMatch
      .slice(1)
      .map((value) => value?.trim() ?? '');
    const argumentsIndex = placeholderOrder.findIndex(
      (name) => name.toUpperCase() === 'ARGUMENTS',
    );
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
  const openFileInComputer = useKortixComputerStore(
    (s) => s.openFileInComputer,
  );
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
      (p) =>
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
  const { cleanText: textAfterProjects, projects: projectRefs } = useMemo(
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
  const {
    cleanText: text,
    notifications: systemNotifications,
  } = useMemo(
    () => parseSystemNotifications(textAfterSessions),
    [textAfterSessions],
  );
  // Silence unused-variable warnings — these parsed refs are currently only
  // consumed as stripping side-effects; inline @ highlighting still uses
  // server source parts + the existing projectRefs list.
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
    const headerMatch = rawText.match(
      /^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/,
    );
    if (!headerMatch) return undefined;
    const platform = headerMatch[1] as 'Telegram' | 'Slack';
    const context = headerMatch[2].trim();
    const userName = headerMatch[3].trim();
    const afterHeader = rawText.slice(headerMatch[0].length);
    const instrStart = afterHeader.search(
      /\n\s*(Chat ID:|── Telegram instructions|── Slack instructions)/,
    );
    const messageText =
      instrStart >= 0
        ? afterHeader.slice(0, instrStart).trim()
        : afterHeader.trim();
    return { platform, context, userName, messageText };
  }, [rawText]);

  // Detect trigger_event in user message
  const triggerEventInfo = useMemo(() => {
    if (!rawText) return undefined;
    const match = rawText.match(
      /<trigger_event>\s*([\s\S]*?)\s*<\/trigger_event>/,
    );
    if (!match) return undefined;
    try {
      const data = JSON.parse(match[1]);
      const promptText = rawText
        .replace(/<trigger_event>[\s\S]*?<\/trigger_event>/, '')
        .trim();
      return { data, prompt: promptText };
    } catch {
      return undefined;
    }
  }, [rawText]);

  // Extract DCP notifications from ignored text parts (DCP plugin sends ignored user messages)
  const ignoredTextParts = stickyParts
    .filter(isTextPart)
    .filter((p) => (p as any).ignored && (p as TextPart).text?.trim());
  const ignoredRawText = ignoredTextParts
    .map((p) => (p as TextPart).text)
    .join('\n');
  const dcpNotifications = useMemo(() => {
    if (!ignoredRawText) return [];
    return parseDCPNotifications(ignoredRawText).notifications;
  }, [ignoredRawText]);

  // Check if any text part was edited
  const isEdited = visibleTextParts.some((p) => (p as any).metadata?.edited);

  // Inline file references
  const inlineFiles = stickyParts.filter(isFilePart) as FilePart[];
  const filesWithSource = inlineFiles.filter(
    (f) =>
      f.source?.text?.start !== undefined && f.source?.text?.end !== undefined,
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
    type SegType = 'file' | 'agent' | 'session' | 'project';

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

    // Detect project @mentions (names can contain spaces).
    const projectDetected: { start: number; end: number; type: SegType }[] = [];
    for (const p of projectRefs) {
      const needle = `@${p.name}`;
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        projectDetected.push({
          start: idx,
          end: idx + needle.length,
          type: 'project',
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
        .filter(
          (a) => a.source?.start !== undefined && a.source?.end !== undefined,
        )
        .map((a) => ({
          start: a.source!.start,
          end: a.source!.end,
          type: 'agent' as SegType,
        })),
    ].filter(
      (r) =>
        !sessionDetected.some((s) => r.start >= s.start && r.start < s.end),
    );

    // Merge session + project + server refs
    const allRefs = [...sessionDetected, ...projectDetected, ...serverRefs];

    if (allRefs.length > 0) {
      allRefs.sort((a, b) => a.start - b.start || b.end - a.end);
      const result: { text: string; type?: SegType }[] = [];
      let lastIndex = 0;
      for (const ref of allRefs) {
        if (ref.start < lastIndex) continue;
        if (ref.start > lastIndex)
          result.push({ text: text.slice(lastIndex, ref.start) });
        result.push({ text: text.slice(ref.start, ref.end), type: ref.type });
        lastIndex = ref.end;
      }
      if (lastIndex < text.length) result.push({ text: text.slice(lastIndex) });
      return result;
    }

    // Fallback: detect @mentions from text using regex
    const agentSet = new Set(agentNames || []);
    const projectNameSet = new Set(projectRefs.map((p) => p.name));
    const mentionRegex = /@(\S+)/g;
    const detected: { start: number; end: number; type: SegType }[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
      const mStart = match.index;
      const token = match[1];
      // Treat @ses_<id> tokens as session mentions
      const type: SegType = token.startsWith('ses_')
        ? 'session'
        : projectNameSet.has(token)
          ? 'project'
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
      if (ref.start > lastIndex)
        result.push({ text: text.slice(lastIndex, ref.start) });
      result.push({ text: text.slice(ref.start, ref.end), type: ref.type });
      lastIndex = ref.end;
    }
    if (lastIndex < text.length) result.push({ text: text.slice(lastIndex) });
    return result;
  }, [text, filesWithSource, agentParts, agentNames, sessionRefs, projectRefs]);

  // If the message is purely notifications (no real user content), render only the cards
  const hasUserContent = !!(
    text ||
    replyContext ||
    uploadedFiles.length > 0 ||
    sessionRefs.length > 0 ||
    projectRefs.length > 0 ||
    systemNotifications.length > 0 ||
    attachments.length > 0
  );

  if (
    !hasUserContent &&
    (dcpNotifications.length > 0 || systemNotifications.length > 0)
  ) {
    return (
      <div className="flex flex-col gap-1.5 w-full">
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
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="inline-flex flex-col gap-1.5 px-4 py-2.5 rounded-2xl border border-border/60 bg-muted/40 max-w-[85%]">
          <div className="flex items-center gap-2">
            <svg
              className="size-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill={isTelegram ? '#29B6F6' : '#E91E63'}
            >
              {isTelegram ? (
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z" />
              ) : (
                <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
              )}
            </svg>
            <span
              className="text-xs font-medium"
              style={{ color: isTelegram ? '#29B6F6' : '#E91E63' }}
            >
              {channelMessageInfo.platform}
            </span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-sm font-medium text-foreground">
              {channelMessageInfo.userName}
            </span>
          </div>
          {channelMessageInfo.messageText && (
            <div className="text-sm text-foreground break-words">
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
        <div className="inline-flex flex-col gap-1.5 px-4 py-2.5 rounded-2xl border border-border/60 bg-muted/40">
          <div className="flex items-center gap-2">
            <Timer className="size-3.5 text-muted-foreground shrink-0" />
            <span className="font-mono text-sm text-foreground">
              {triggerEventInfo.data?.trigger || 'Scheduled Task'}
            </span>
            {triggerEventInfo.data?.data?.manual && (
              <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                Manual
              </span>
            )}
          </div>
          {triggerEventInfo.prompt && (
            <div
              className="text-xs text-muted-foreground pl-5.5 break-words max-w-[400px]"
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
        <div className="inline-flex flex-col gap-1.5 px-4 py-2.5 rounded-2xl border border-border/60 bg-muted/40">
          <div className="flex items-center gap-2">
            <Terminal className="size-3.5 text-muted-foreground shrink-0" />
            <span className="font-mono text-sm text-foreground">
              /{effectiveCommandInfo.name}
            </span>
          </div>
          {effectiveCommandInfo.args && (
            <div
              className="text-xs text-muted-foreground pl-5.5 break-words max-w-[400px]"
              style={{ paddingLeft: '1.375rem' }}
            >
              {effectiveCommandInfo.args}
            </div>
          )}
        </div>
        {/* DCP notifications from ignored parts */}
        {dcpNotifications.length > 0 && (
          <div className="flex flex-col gap-1.5 w-full mt-1">
            {dcpNotifications.map((n, i) => (
              <DCPNotificationCard key={i} notification={n} />
            ))}
          </div>
        )}
        {systemNotifications.length > 0 && (
          <div className="flex flex-col gap-1.5 w-full mt-1">
            {systemNotifications.map((n, i) => (
              <SystemNotificationCard
                key={`cmd-${n.tag}-${i}`}
                notification={n}
              />
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
          'flex flex-col max-w-[90%] rounded-3xl rounded-br-lg bg-card border overflow-hidden',
          canExpand && 'cursor-pointer hover:bg-card/80 transition-colors',
        )}
        onClick={() => canExpand && setExpanded(!expanded)}
      >
        {/* Attachment thumbnails (images/PDFs) */}
        {attachments.length > 0 && (
          <div className="flex gap-2 p-3 pb-0 flex-wrap">
            {attachments.map((file) => (
              <div
                key={file.id}
                className="rounded-lg overflow-hidden border border-border/50"
              >
                {file.mime?.startsWith('image/') && file.url ? (
                  <SandboxImage
                    src={file.url}
                    alt={file.filename ?? 'Attachment'}
                    className="max-h-32 max-w-48 object-cover"
                    preview
                  />
                ) : file.mime === 'application/pdf' ? (
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
                    <FileText className="size-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      {file.filename || 'PDF'}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
                    <ImageIcon className="size-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      {file.filename || 'File'}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Uploaded file references (from <file> XML tags) */}
        {uploadedFiles.length > 0 && (
          <div className="flex gap-2 p-3 pb-0 flex-wrap">
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
        {projectRefs.length > 0 && (
          <div className="flex gap-1.5 mx-3 mt-3 mb-0 flex-wrap">
            {projectRefs.map((p, i) => (
              <button
                key={`${p.id || p.name}-${i}`}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (p.id) {
                    openTabAndNavigate({
                      id: `project:${p.id}`,
                      title: p.name,
                      type: 'project',
                      href: `/projects/${encodeURIComponent(p.id)}`,
                    });
                  }
                }}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted/60 border border-border/60 hover:bg-muted hover:border-border transition-colors cursor-pointer"
                title={p.path}
              >
                <span className="text-[11px] font-medium text-foreground">
                  {p.name}
                </span>
                {p.path && (
                  <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[240px]">
                    {p.path}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Reply context banner */}
        {replyContext && (
          <div className="flex items-center gap-2 mx-3 mt-3 mb-0 px-3 py-1.5 rounded-xl bg-primary/5 border border-primary/10">
            <Reply className="size-3 text-primary/60 flex-shrink-0" />
            <span className="text-[11px] text-muted-foreground truncate">
              {replyContext.length > 150
                ? `${replyContext.slice(0, 150)}...`
                : replyContext}
            </span>
          </div>
        )}

        {/* Text content */}
        {text && (
          <div className="relative group px-4 py-3">
            <div
              ref={textRef}
              className={cn(
                'text-sm leading-relaxed whitespace-pre-wrap break-words min-w-0',
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
                            serverId: useServerStore.getState().activeServerId,
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
                            serverId: useServerStore.getState().activeServerId,
                          });
                        }
                      }}
                    >
                      {seg.text}
                    </span>
                  ) : seg.type === 'project' ? (
                    <span
                      key={i}
                      className={mentionClass}
                      onClick={(e) => {
                        e.stopPropagation();
                        const raw = seg.text.replace(/^@/, '');
                        const ref = projectRefs.find((p) => p.name === raw);
                        if (ref?.id) {
                          openTabAndNavigate({
                            id: `project:${ref.id}`,
                            title: ref.name,
                            type: 'project',
                            href: `/projects/${encodeURIComponent(ref.id)}`,
                          });
                        }
                      }}
                    >
                      {seg.text}
                    </span>
                  ) : (
                    <span
                      key={i}
                      className={cn(
                        seg.type === 'agent' && 'font-medium text-foreground',
                      )}
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
              <div className="absolute inset-x-0 bottom-3 h-10 bg-gradient-to-t from-card to-transparent pointer-events-none" />
            )}

            {/* Expand/collapse indicator */}
            {canExpand && (
              <div className="absolute bottom-3 right-4 p-1 rounded-md bg-card/80 backdrop-blur-sm text-muted-foreground z-10">
                <ChevronDown
                  className={cn(
                    'size-3.5 transition-transform',
                    expanded && 'rotate-180',
                  )}
                />
              </div>
            )}
          </div>
        )}
      </div>
      {isEdited && (
        <span className="text-[10px] text-muted-foreground/50 pr-1">
          edited
        </span>
      )}

      {/* DCP notifications from ignored parts (rendered below user bubble if mixed) */}
      {dcpNotifications.length > 0 && (
        <div className="flex flex-col gap-1.5 w-full mt-1">
          {dcpNotifications.map((n, i) => (
            <DCPNotificationCard key={i} notification={n} />
          ))}
        </div>
      )}
      {systemNotifications.length > 0 && (
        <div className="flex flex-col gap-1.5 w-full mt-1">
          {systemNotifications.map((n, i) => (
            <SystemNotificationCard
              key={`mixed-${n.tag}-${i}`}
              notification={n}
            />
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

function ThrottledMarkdown({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
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
  const reasoningStreaming =
    isStreaming && !(typeof lastEnd === 'number' && lastEnd > 0);

  // Find the earliest start across all parts for the live timer
  const earliestStart = useMemo(() => {
    let earliest: number | undefined;
    for (const p of parts) {
      const s = (p as any).time?.start;
      if (typeof s === 'number' && (earliest === undefined || s < earliest))
        earliest = s;
    }
    return earliest;
  }, [parts]);

  useEffect(() => {
    if (!reasoningStreaming || typeof earliestStart !== 'number') {
      setStreamSeconds(0);
      return;
    }
    const update = () =>
      setStreamSeconds(
        Math.max(0, Math.round((Date.now() - earliestStart) / 1000)),
      );
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
        return firstLine.length > 80
          ? firstLine.slice(0, 77) + '...'
          : firstLine;
      }
    }
    return '';
  }, [parts]);

  const nonEmptyParts = useMemo(
    () => parts.filter((p) => p.text?.trim()),
    [parts],
  );

  if (nonEmptyParts.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1.5 py-0.5',
            'text-xs select-none cursor-pointer',
            'text-muted-foreground/70',
            'transition-colors max-w-full group/reasoning',
          )}
        >
          <Brain
            className={cn(
              'size-3.5 flex-shrink-0 text-muted-foreground/50',
              reasoningStreaming && 'animate-pulse-heartbeat',
            )}
          />

          <span className="min-w-0 flex-1 truncate">
            {preview || 'Thinking'}
          </span>
          {reasoningStreaming && (
            <Loader2 className="size-3 animate-spin flex-shrink-0 text-muted-foreground/40" />
          )}
          <ChevronRight
            className={cn(
              'size-3 transition-transform flex-shrink-0',
              'text-muted-foreground/30 opacity-0 group-hover/reasoning:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="ml-[18px] mt-0.5 mb-1.5 pl-3 border-l border-border/30">
          <div className="space-y-2 text-muted-foreground/50 [&_.kortix-markdown]:italic [&_.kortix-markdown_div]:!text-[12px] [&_.kortix-markdown_div]:!leading-[1.5] [&_.kortix-markdown_div]:!text-muted-foreground/50 [&_.kortix-markdown_li]:!text-[12px] [&_.kortix-markdown_li]:!leading-[1.5] [&_.kortix-markdown_li]:!text-muted-foreground/50 [&_.kortix-markdown_strong]:!text-muted-foreground/60 [&_.kortix-markdown_em]:!text-muted-foreground/60">
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
          (part.state as any)?.status === 'pending' ||
          (part.state as any)?.status === 'running',
      ),
    [busy, entries],
  );

  const totalDurationMs = useMemo(() => {
    let earliest = Infinity;
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
    !anyRunning && totalDurationMs >= 1000
      ? `${Math.round(totalDurationMs / 1000)}s`
      : '';

  const isContext = toolName === '__context__';

  const headerLabel = useMemo(() => {
    if (!isContext) {
      const t = contextToolTrigger(entries[0].part);
      return `${t.title} · ${entries.length}x`;
    }
    const s = contextToolSummary(entries.map((e) => e.part));
    const items: string[] = [];
    if (s.read > 0) items.push(`${s.read} read${s.read > 1 ? 's' : ''}`);
    if (s.search > 0) items.push(`${s.search} search${s.search > 1 ? 'es' : ''}`);
    if (s.list > 0) items.push(`${s.list} list${s.list > 1 ? 's' : ''}`);
    const summary = items.join(', ');
    const prefix = anyRunning ? 'Gathering context' : 'Gathered context';
    return summary ? `${prefix} · ${summary}` : prefix;
  }, [isContext, entries, anyRunning]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1.5 py-0.5',
            'text-xs select-none cursor-pointer',
            'text-muted-foreground/70',
            'transition-colors max-w-full group/grp',
          )}
        >
          <Search
            className={cn(
              'size-3.5 flex-shrink-0 text-muted-foreground/50',
              anyRunning && 'animate-pulse-heartbeat',
            )}
          />
          <span className="min-w-0 flex-1 truncate">{headerLabel}</span>
          {durationLabel && (
            <span className="text-[10px] font-mono tabular-nums flex-shrink-0 text-muted-foreground/40">
              {durationLabel}
            </span>
          )}
          {anyRunning && (
            <Loader2 className="size-3 animate-spin flex-shrink-0 text-muted-foreground/40" />
          )}
          <ChevronRight
            className={cn(
              'size-3 transition-transform flex-shrink-0',
              'text-muted-foreground/30 opacity-0 group-hover/grp:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="ml-[18px] mt-0.5 mb-1.5 pl-3 border-l border-border/30 space-y-0.5">
          {entries.map(({ part }) => {
            const t = contextToolTrigger(part);
            const running =
              (part.state as any)?.status === 'pending' ||
              (part.state as any)?.status === 'running';
            const s = (part.state as any)?.time?.start;
            const e = (part.state as any)?.time?.end;
            const dur =
              typeof s === 'number' && typeof e === 'number' && e > s
                ? e - s
                : 0;
            return (
              <div
                key={part.id}
                className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/60"
              >
                <span className="flex-shrink-0">{t.title}</span>
                {!running && t.subtitle && (
                  <span className="font-mono truncate min-w-0 opacity-70">
                    {t.subtitle}
                  </span>
                )}
                {!running && dur >= 1000 && (
                  <span className="ml-auto text-[10px] font-mono tabular-nums flex-shrink-0 text-muted-foreground/40">
                    {Math.round(dur / 1000)}s
                  </span>
                )}
                {running && (
                  <Loader2 className="size-2.5 animate-spin flex-shrink-0 text-muted-foreground/40" />
                )}
              </div>
            );
          })}
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
  /** Fork the session at a user message (copies messages before this point) */
  onFork: (userMessageId: string) => Promise<void>;
  /** Fork the session at a user message and prefill with edited text */
  onEditFork: (userMessageId: string, newText: string) => Promise<void>;
  /** Providers data for the Connect Provider dialog */
  providers?: ProviderListResponse;
  /** Map of user message IDs to command info for rendering command pills */
  commandMessages?: Map<string, { name: string; args?: string }>;
  /** Available commands for template prefix matching (page refresh detection) */
  commands?: Command[];
  /** Disable redirect-style tool navigation (used during onboarding) */
  disableToolNavigation?: boolean;
  /** Permission reply handler */
  onPermissionReply: (
    requestId: string,
    reply: 'once' | 'always' | 'reject',
  ) => Promise<void>;
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
  onFork,
  onEditFork,
  providers,
  commandMessages,
  commands,
  disableToolNavigation,
  onPermissionReply,
}: SessionTurnProps) {
  const [copied, setCopied] = useState(false);
  const [userCopied, setUserCopied] = useState(false);
  const [connectProviderOpen, setConnectProviderOpen] = useState(false);
  const [editForkLoading, setEditForkLoading] = useState(false);

  // Derived state from shared helpers
  const allParts = useMemo(() => collectTurnParts(turn), [turn]);
  // Check if there are visible steps that actually render inside the
  // collapsible steps section. Tool parts that are rendered elsewhere
  // (todowrite, task, question) don't count as "steps".
  const hasSteps = useMemo(() => {
    return allParts.some(({ part }) => {
      if (
        part.type === 'compaction' ||
        part.type === 'snapshot' ||
        part.type === 'patch'
      )
        return true;
      if (isToolPart(part)) {
        if (
          part.tool === 'todowrite' ||
          part.tool === 'task' ||
          part.tool === 'question'
        )
          return false;
        return shouldShowToolPart(part);
      }
      return false;
    });
  }, [allParts]);
  const hasReasoning = useMemo(
    () =>
      allParts.some(({ part }) => isReasoningPart(part) && !!part.text?.trim()),
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
    () => (!working ? getTurnCost(allParts) : undefined),
    [allParts, working],
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
        if (
          tool.tool === 'question' &&
          tool.state.status === 'error' &&
          'error' in tool.state
        ) {
          return (tool.state as { error: string }).error.replace(
            /^Error:\s*/,
            '',
          );
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
    const turnMessageIds = new Set(
      turn.assistantMessages.map((m) => m.info.id),
    );
    const matched = sessionQuestions.find(
      (q) => q.tool && turnMessageIds.has(q.tool.messageID),
    );
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
        const parsed = parseAnswersFromOutput(
          toolOutput,
          (tool.state as any)?.input,
        );
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
        const questionsList: { question: string }[] = Array.isArray(
          input?.questions,
        )
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

  // Extract kortix_system messages for inline rendering (autowork continuations, etc.)
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
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
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
      setRetrySecondsLeft(
        Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)),
      );
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
        {turnError && (
          <TurnErrorDisplay errorText={turnError} className="mt-2" />
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
  // Compaction mode — render as a distinct card, no user bubble / logo / steps
  // ============================================================================

  if (isCompaction && !working && response) {
    return (
      <div className="group/turn">
        <div className="rounded-lg border border-border/60 bg-card/50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 bg-muted/40">
            <Layers className="size-3.5 text-muted-foreground/70" />
            <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
              Compaction
            </span>
          </div>
          <div className="px-4 py-3 text-sm text-muted-foreground/90 [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_strong]:text-foreground/90">
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
  //   9. Action bar (copy, fork, revert)
  //
  // The response (last text part) is NEVER rendered twice:
  //   - While working: it renders INSIDE steps as a regular text part (hideResponsePart=false)
  //   - When done: it's HIDDEN from steps (hideResponsePart=true) and shown below as Response
  // ============================================================================

  return (
    <div className="space-y-3 group/turn">
      {/* ── Session report card — clickable, opens worker session modal ── */}
      {sessionReport && (
        <>
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSessionReportModalOpen(true)}
            onKeyDown={(e) =>
              e.key === 'Enter' && setSessionReportModalOpen(true)
            }
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-lg text-xs',
              'border select-none cursor-pointer transition-colors group/report',
              sessionReport.status === 'COMPLETE'
                ? 'bg-emerald-500/5 border-emerald-500/20 hover:bg-emerald-500/10'
                : 'bg-destructive/5 border-destructive/20 hover:bg-destructive/10',
            )}
          >
            {sessionReport.status === 'COMPLETE' ? (
              <CheckCircle className="size-3.5 text-emerald-500 flex-shrink-0" />
            ) : (
              <AlertTriangle className="size-3.5 text-destructive flex-shrink-0" />
            )}
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <span
                className={cn(
                  'font-medium',
                  sessionReport.status === 'COMPLETE'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-destructive',
                )}
              >
                Worker{' '}
                {sessionReport.status === 'COMPLETE' ? 'Complete' : 'Failed'}
              </span>
              {sessionReport.project && (
                <span className="text-muted-foreground/60">
                  · {sessionReport.project}
                </span>
              )}
              {sessionReport.prompt && (
                <span className="text-muted-foreground/40 truncate">
                  {sessionReport.prompt.slice(0, 60)}
                </span>
              )}
            </div>
            <ExternalLink className="size-3 flex-shrink-0 text-muted-foreground/30 group-hover/report:text-muted-foreground/60 transition-colors" />
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
            <div className="flex justify-end mt-1 opacity-0 group-hover/turn:opacity-100 transition-opacity duration-150">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleCopyUser}
                  >
                    {userCopied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {userCopied ? 'Copied!' : 'Copy'}
                </TooltipContent>
              </Tooltip>
              {(() => {
                const userTextPart = turn.userMessage.parts.find(
                  (p) =>
                    isTextPart(p) &&
                    !(p as TextPart).synthetic &&
                    !(p as any).ignored &&
                    !!stripSystemPtyText((p as TextPart).text || ''),
                );
                if (!userTextPart) return null;
                return (
                  <PartActions
                    part={userTextPart}
                    isBusy={isBusy}
                    onEditFork={(newText) =>
                      onEditFork(turn.userMessage.info.id, newText)
                    }
                    loading={editForkLoading}
                  />
                );
              })()}
              {/* Fork button — on user messages */}
              {!isBusy && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onFork(turn.userMessage.info.id)}
                    >
                      <GitFork className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Fork to new session</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      )}

      {/* Kortix logo header */}
      {(working || hasSteps || hasReasoning) && (
        <div className="flex items-center gap-2 mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/kortix-logomark-white.svg"
            alt="Kortix"
            className="dark:invert-0 invert flex-shrink-0 h-[14px] w-auto"
          />
        </div>
      )}

      {/* ── Assistant parts content ──
			  Renders ALL parts from all assistant messages,
			  EXCEPT: the response part (last text) is hidden when not working
			  (it renders separately below as the Response section). */}
      {(working || hasSteps || hasReasoning) &&
        turn.assistantMessages.length > 0 && (
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

              // Normalize tool name for grouping. Context tools
              // (read/glob/grep/list) all share one key so they merge
              // into a single "Gathered context" group.
              const CONTEXT_SET = new Set(['read', 'glob', 'grep', 'list']);
              const norm = (t: string) => {
                const n = t.replace(/^oc-/, '').replace(/-/g, '_');
                return CONTEXT_SET.has(n) ? '__context__' : n;
              };

              for (const { part, message } of allParts) {
                if (isReasoningPart(part)) {
                  if (part.text?.trim()) {
                    flushTools();
                    pendingReasoning.push(part);
                  }
                  continue;
                }
                flushReasoning();

                if (isToolPart(part)) {
                  const tp = part as ToolPart;
                  const hasPermission = !!getPermissionForTool(
                    permissions,
                    tp.callID,
                  );
                  const groupable =
                    shouldShowToolPart(tp) &&
                    tp.tool !== 'todowrite' &&
                    tp.tool !== 'question' &&
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

              const reasoningActive =
                working && permissions.length === 0 && questions.length === 0;

              return items.map((item) => {
                // Reasoning group
                if (item.type === 'reasoning-group') {
                  return (
                    <div key={item.key}>
                      <GroupedReasoningCard
                        parts={item.parts}
                        isStreaming={reasoningActive}
                      />
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
                  if (isToolPartHidden(item.part, item.message.info.id, hidden))
                    return null;
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
                if (
                  shouldUseInlineContent &&
                  isTextPart(part) &&
                  part.text?.trim()
                )
                  return null;

                // Text parts (intermediate + streaming response while working)
                if (isTextPart(part)) {
                  if (!part.text?.trim()) return null;
                  // Text response rendering for no-step turns is handled below in
                  // the dedicated response section to avoid duplicate output.
                  if (!hasSteps) return null;
                  return (
                    <div key={part.id} className="text-sm">
                      <ThrottledMarkdown
                        content={part.text}
                        isStreaming={working}
                      />
                    </div>
                  );
                }

                // Compaction indicator
                if (isCompactionPart(part)) {
                  return (
                    <div key={part.id} className="flex items-center gap-2 py-2.5">
                      <div className="flex-1 h-px bg-border" />
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted/80 border border-border/60">
                        <Layers className="size-3 text-muted-foreground" />
                        <span className="text-[10px] font-semibold text-muted-foreground tracking-wide">
                          Compaction
                        </span>
                      </div>
                      <div className="flex-1 h-px bg-border" />
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
                        <AnsweredQuestionCard
                          key={part.id}
                          part={answeredPart}
                          defaultExpanded
                        />
                      );
                    }
                    // Unanswered/dismissed questions: don't render in steps;
                    // dismissed ones show via the turnError banner.
                    return null;
                  }

                  const perm = getPermissionForTool(permissions, part.callID);

                  // Hide tool parts that have active permission
                  if (isToolPartHidden(part, message.info.id, hidden))
                    return null;

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
          <div className="flex items-center gap-2 mt-3 mb-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/kortix-logomark-white.svg"
              alt="Kortix"
              className="dark:invert-0 invert flex-shrink-0 h-[14px] w-auto"
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
        <div className="text-sm">
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
                const text = isStreaming
                  ? item.part.text!
                  : item.part.text!.trim();
                return (
                  <div key={item.id} className="text-sm">
                    {isStreaming ? (
                      <ThrottledMarkdown content={text} isStreaming />
                    ) : (
                      <SandboxUrlDetector content={text} isStreaming={false} />
                    )}
                  </div>
                );
              }
              return (
                <AnsweredQuestionCard
                  key={item.id}
                  part={item.part}
                  defaultExpanded
                />
              );
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
              <div className="rounded-2xl border border-border/60 bg-gradient-to-b from-muted/15 to-background overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-muted/25">
                  <Terminal className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs text-foreground">
                    /{commandForTurn.name}
                  </span>
                  {commandForTurn.args && (
                    <span className="text-[11px] text-muted-foreground truncate">
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
				    there are no steps (no-steps turns). When hasSteps is true,
				    answered questions render inline within the steps section above.
				    Skip while working — the steps section (guarded by `working || hasSteps`)
				    already renders them to avoid duplicates. */}
          {!hasSteps && !working && answeredQuestionParts.length > 0 && (
            <div className="space-y-2 mt-3">
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
              'flex items-center gap-2 text-xs transition-colors py-1',
              'text-muted-foreground',
            )}
          >
            <span className="relative flex size-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground/30" />
              <span className="relative inline-flex rounded-full size-3 bg-muted-foreground/50" />
            </span>
            {retryInfo ? (
              <span className="text-muted-foreground/70">Waiting to retry</span>
            ) : (
              <AnimatedThinkingText
                statusText={throttledStatus || undefined}
                className="text-xs"
              />
            )}
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground/70">{duration}</span>
          </div>
        </div>
      )}

      {/* ── Error (abort / failure banner) ── */}
      {turnError && <TurnErrorDisplay errorText={turnError} />}

      {/* Question prompt — now rendered inside the chat input card (questionSlot) */}

      {/* ── Action bar (copy + duration/cost only — fork & revert live on user messages) ── */}
      {!working && response && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover/turn:opacity-100 transition-opacity duration-150">
          {/* Duration & cost */}
          {duration && (
            <span className="text-[11px] text-muted-foreground/50 mr-1">
              {duration}
              {costInfo && (
                <>
                  {' '}
                  · {formatCost(costInfo.cost)} ·{' '}
                  {formatTokens(costInfo.tokens.input + costInfo.tokens.output)}
                  t
                </>
              )}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={handleCopy}>
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
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
  headerLeadingAction,
  hideHeader,
  readOnly,
  initialScrollTop,
}: SessionChatProps) {
  const onboardingActive = useOnboardingModeStore((s) => s.active);
  const onboardingSessionId = useOnboardingModeStore((s) => s.sessionId);
  const disableToolNavigation =
    onboardingActive && onboardingSessionId === sessionId;
  const activeTabId = useTabStore((s) => s.activeTabId);
  const isActiveSessionTab = activeTabId === sessionId;

  // ---- Context modal ----
  const [contextModalOpen, setContextModalOpen] = useState(false);

  // ---- Question prompt ref + action state (for unified send button) ----
  const questionPromptRef = useRef<QuestionPromptHandle>(null);
  const [questionAction, setQuestionAction] = useState<{
    label: string | null;
    canAct: boolean;
  }>({ label: null, canAct: true });
  const handleQuestionActionChange = useCallback(
    (action: QuestionAction, canAct: boolean) => {
      const label =
        action === 'next' ? 'Next' : action === 'submit' ? 'Submit' : null;
      setQuestionAction({ label, canAct });
    },
    [],
  );

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
  const { isSidePanelOpen, setIsSidePanelOpen, openFileInComputer } =
    useKortixComputerStore();
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const handleTogglePanel = useCallback(() => {
    setIsSidePanelOpen(!isSidePanelOpen);
  }, [isSidePanelOpen, setIsSidePanelOpen]);

  // ---- Hooks ----
  const { data: session, isLoading: sessionLoading } =
    useOpenCodeSession(sessionId);
  // useSessionSync is the SINGLE source of truth for messages (matches OpenCode SolidJS).
  // It fetches on first access, then SSE events keep it up to date.
  // No React Query fallback — prevents stale refetches from overwriting live data.
  const { messages: syncMessages, isLoading: syncMessagesLoading } =
    useSessionSync(sessionId);
  const messages = syncMessages.length > 0 ? syncMessages : undefined;
  const messagesLoading = syncMessagesLoading;
  const { data: agents } = useOpenCodeAgents();
  const { data: commands } = useOpenCodeCommands();
  const { data: providers } = useOpenCodeProviders();
  const { data: allSessions } = useOpenCodeSessions();
  const { data: config } = useOpenCodeConfig();
  const abortSession = useAbortOpenCodeSession();
  const forkSession = useForkSession();

  // ---- Unified model/agent/variant state (1:1 port of SolidJS local.tsx) ----
  const local = useOpenCodeLocal({ agents, providers, config, sessionId });

  // ---- Project selection (shared with dashboard via persisted store) ----
  // Drives the ProjectSelector on the empty-state session view and injects
  // a project preamble into the first message sent in this session.
  const selectedProjectId = useSelectedProjectStore((s) => s.projectId);
  const setSelectedProjectId = useSelectedProjectStore((s) => s.setProjectId);
  const { data: kortixProjects } = useKortixProjects();
  const selectedProject = useMemo(
    () => kortixProjects?.find((p) => p.id === selectedProjectId) ?? null,
    [kortixProjects, selectedProjectId],
  );
  useEffect(() => {
    if (selectedProjectId && kortixProjects && !selectedProject) {
      setSelectedProjectId(null);
    }
  }, [selectedProjectId, kortixProjects, selectedProject, setSelectedProjectId]);

  const pendingPromptHandled = useRef(false);

  // ---- Polling fallback & optimistic send ----
  const [pollingActive, setPollingActive] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(
    null,
  );
  const [pendingUserMessageId, setPendingUserMessageId] = useState<
    string | null
  >(null);
  const [confirmForkMessageId, setConfirmForkMessageId] = useState<
    string | null
  >(null);
  const [pendingCommand, setPendingCommand] = useState<{
    name: string;
    description?: string;
  } | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  // Map of user message IDs → command info, so UserMessageRow can render
  // a compact command pill instead of the raw expanded template text.
  const commandMessagesRef = useRef<
    Map<string, { name: string; args?: string }>
  >(new Map());
  // Stash the pending command info so we can associate it with the user message
  // even if the busy signal arrives before the message list updates.
  const pendingCommandStashRef = useRef<{ name: string; args?: string } | null>(
    null,
  );
  // Track whether we're retrying a failed send (keeps loader visible)
  const [isRetrying, setIsRetrying] = useState(false);
  // Track whether a pending prompt send is in flight (dashboard→session flow).
  // Keeps isBusy true until the server acknowledges with a busy status.
  const [pendingSendInFlight, setPendingSendInFlight] = useState(false);
  const [pendingSendMessageId, setPendingSendMessageId] = useState<
    string | null
  >(null);
  // Grace period: don't stop polling immediately on idle after a recent send
  const lastSendTimeRef = useRef<number>(0);
  // ---- Optimistic prompt (from dashboard/project page) ----
  // Uses session-specific sessionStorage keys so pushState navigation works
  // (no dependency on ?new=true URL param which requires router.push).
  const [optimisticPrompt, setOptimisticPrompt] = useState<string | null>(
    () => {
      if (typeof window !== 'undefined') {
        return sessionStorage.getItem(`opencode_pending_prompt:${sessionId}`);
      }
      return null;
    },
  );

  const addOptimisticUserMessage = useCallback(
    (messageId: string, text: string, partIds?: string[]) => {
      const parts = text.trim()
        ? [
            {
              id: partIds?.[0] ?? ascendingId('prt'),
              sessionID: sessionId,
              messageID: messageId,
              type: 'text',
              text,
            } as any,
          ]
        : [];
      const info = {
        id: messageId,
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
      } as any;

      useSyncStore.getState().optimisticAdd(sessionId, info, parts as any);
    },
    [sessionId],
  );

  const removeOptimisticUserMessage = useCallback(
    (messageId: string) => {
      useSyncStore.getState().optimisticRemove(sessionId, messageId);
    },
    [sessionId],
  );

  // Hydrate options from sessionStorage and send the pending prompt for new sessions.
  // The dashboard/project page stores the prompt in sessionStorage and navigates here.
  // We send the message from here (not the dashboard) so that SSE listeners and polling
  // are already active when the response starts streaming back.
  // Retries up to 3 times on failure (e.g. "Unable to connect" errors).
  // Uses a retry loop (up to 5 attempts, 50ms apart) when reading sessionStorage
  // to handle the race condition where the effect fires before the dashboard
  // has written the pending prompt.
  useEffect(() => {
    if (pendingPromptHandled.current) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const attemptSend = (attempt: number) => {
      if (cancelled) return;
      const pendingPrompt = sessionStorage.getItem(
        `opencode_pending_prompt:${sessionId}`,
      );
      console.log('[session-chat] pending prompt check', {
        sessionId,
        hasPending: !!pendingPrompt,
        attempt,
      });
      if (!pendingPrompt) {
        // Retry up to 5 times with 50ms delay to handle race condition
        if (attempt < 5) {
          retryTimer = setTimeout(() => attemptSend(attempt + 1), 50);
          return;
        }
        // Exhausted retries — no pending prompt
        return;
      }
      pendingPromptHandled.current = true;
      setPollingActive(true);
      setPendingSendInFlight(true);
      useSyncStore.getState().setStatus(sessionId, { type: 'busy' });
      sessionStorage.removeItem(`opencode_pending_prompt:${sessionId}`);
      sessionStorage.removeItem(`opencode_pending_send_failed:${sessionId}`);

      // Restore agent/model/variant selections from the dashboard
      const options: Record<string, unknown> = {};
      try {
        const raw = sessionStorage.getItem(
          `opencode_pending_options:${sessionId}`,
        );
        if (raw) {
          const pendingOptions = JSON.parse(raw);
          sessionStorage.removeItem(`opencode_pending_options:${sessionId}`);
          if (pendingOptions?.agent) {
            options.agent = pendingOptions.agent;
            local.agent.set(pendingOptions.agent as string);
          }
          if (pendingOptions?.model) {
            const parsedPendingModel = parseModelKey(pendingOptions.model);
            if (parsedPendingModel) {
              options.model = parsedPendingModel;
              local.model.set(parsedPendingModel);
            }
          }
          if (pendingOptions?.variant) {
            options.variant = pendingOptions.variant;
            local.model.variant.set(pendingOptions.variant as string);
          }
        }
      } catch {
        // ignore
      }

      // Send the message with retry. The useSendOpenCodeMessage hook already
      // retries 3 times internally for transient errors. We add one additional
      // outer retry (2 attempts total at this level) to cover cases where the
      // SDK client itself fails to initialize or the server takes longer to start.
      const sendOpts =
        Object.keys(options).length > 0 ? (options as any) : undefined;
      const messageID = ascendingId('msg');
      const textPartId = ascendingId('prt');
      setPendingSendMessageId(messageID);
      addOptimisticUserMessage(messageID, pendingPrompt, [textPartId]);
      lastSendTimeRef.current = Date.now();

      // Fire-and-forget via promptAsync. Don't send messageID — let the
      // server generate it with its own clock to avoid clock-skew issues.
      let client: ReturnType<typeof getClient>;
      try {
        client = getClient();
      } catch {
        // SDK client failed to initialize — restore sessionStorage so the
        // user can retry (e.g. by refreshing). Reset all pending state.
        sessionStorage.setItem(
          `opencode_pending_prompt:${sessionId}`,
          pendingPrompt,
        );
        pendingPromptHandled.current = false;
        setPollingActive(false);
        setPendingSendInFlight(false);
        useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
        removeOptimisticUserMessage(messageID);
        return;
      }
      const handlePromptError = () => {
        setIsRetrying(false);
        setPendingSendInFlight(false);
        setPendingSendMessageId(null);
        setOptimisticPrompt(null);
        setPollingActive(false);
        useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
        // Fetch real messages from the server. Some error paths
        // (e.g. missing API key) return the error directly in the
        // HTTP response without ever emitting a session.error SSE
        // event. Without this fetch, removing the optimistic message
        // leaves the UI blank because no SSE event will bring in the
        // server-persisted messages.
        client.session
          .messages({ sessionID: sessionId })
          .then((res) => {
            if (res.data) {
              useSyncStore.getState().hydrate(sessionId, res.data as any);
              useSyncStore.getState().clearOptimisticMessages(sessionId);
            } else {
              // No server data — just remove the optimistic message
              removeOptimisticUserMessage(messageID);
            }
          })
          .catch(() => {
            // Fetch failed — fall back to removing the optimistic message
            removeOptimisticUserMessage(messageID);
          });
      };
      // Consume any pending files stored by the dashboard (File objects
      // can't survive sessionStorage, so they're in a Zustand store).
      const pendingFiles = usePendingFilesStore
        .getState()
        .consumePendingFiles();

      console.log('[session-chat] sending promptAsync for pending prompt', {
        sessionId,
        pendingFileCount: pendingFiles.length,
      });

      // Upload local files and build the parts array (text + file refs)
      const sendPendingPrompt = async () => {
        const parts: Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename: string }
        > = [{ type: 'text', text: pendingPrompt }];

        const localFiles = pendingFiles.filter(
          (f): f is Extract<typeof f, { kind: 'local' }> => f.kind === 'local',
        );
        const remoteFiles = pendingFiles.filter(
          (f): f is Extract<typeof f, { kind: 'remote' }> =>
            f.kind === 'remote',
        );

        // Include remote files (from fork drafts etc.)
        for (const file of remoteFiles) {
          parts.push({
            type: 'file',
            mime: file.mime,
            url: file.url,
            filename: file.filename,
          });
        }

        // Upload local files. The server (/file/upload) guarantees
        // collision-free destinations — if two files share a name it
        // auto-suffixes and returns the actual written path.
        if (localFiles.length > 0) {
          const uploadResults = await Promise.all(
            localFiles.map(async (af) => {
              const safeName = af.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
              const uploadBlob = new File([af.file], safeName, {
                type: af.file.type,
              });
              const results = await uploadFile(
                uploadBlob,
                '/workspace/uploads',
              );
              if (!results || results.length === 0) {
                throw new Error(`Failed to upload file: ${af.file.name}`);
              }
              return {
                path: results[0].path,
                mime: af.file.type || 'application/octet-stream',
                filename: af.file.name,
              };
            }),
          );
          const uploadedFileRefs = uploadResults
            .map(
              (f) =>
                `<file path="${f.path}" mime="${f.mime}" filename="${f.filename}">\nThis file has been uploaded and is available at the path above.\n</file>`,
            )
            .join('\n');
          (parts[0] as { type: 'text'; text: string }).text +=
            `\n\n${uploadedFileRefs}`;
        }

        return parts;
      };

      void sendPendingPrompt()
        .then((parts) =>
          client.session.promptAsync({
            sessionID: sessionId,
            parts,
            ...(sendOpts?.agent && { agent: sendOpts.agent }),
            ...(sendOpts?.model && { model: sendOpts.model }),
            ...(sendOpts?.variant && { variant: sendOpts.variant }),
          } as any),
        )
        .then((res: any) => {
          console.log('[session-chat] promptAsync resolved', {
            sessionId,
            status: res?.response?.status,
            hasError: !!res?.error,
            res,
          });
          // The SDK resolves (not rejects) on HTTP errors, returning
          // { error: ... } instead of throwing. Handle this case so
          // the UI doesn't stay stuck on "busy" forever.
          if (res?.error) handlePromptError();
        })
        .catch((err: any) => {
          console.error('[session-chat] promptAsync rejected', {
            sessionId,
            err,
          });
          handlePromptError();
        });
    };

    attemptSend(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, addOptimisticUserMessage, removeOptimisticUserMessage]);

  // Clear optimistic prompt once real messages arrive
  useEffect(() => {
    if (optimisticPrompt && messages && messages.length > 0) {
      setOptimisticPrompt(null);
    }
  }, [optimisticPrompt, messages]);

  const agentNames = useMemo(
    () => local.agent.list.map((a) => a.name),
    [local.agent.list],
  );

  // ---- Check if any messages have tool calls ----
  const hasToolCalls = useMemo(() => {
    if (!messages) return false;
    return messages.some((msg) => msg.parts?.some((p) => p.type === 'tool'));
  }, [messages]);

  // ---- Restore model/agent from last user message ----
  // Seeds agent/model from the last user message ONLY if there's no per-session
  // selection yet. This handles opening a session for the first time. If the user
  // already changed the model in this session (persisted per-session in localStorage),
  // we don't overwrite it — the per-session selection takes priority via the
  // resolution chain in useOpenCodeLocal.
  const lastUserMessage = useMemo(
    () =>
      messages
        ? [...messages].reverse().find((m) => m.info.role === 'user')
        : undefined,
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
  // Use sync store as primary (matches OpenCode), fall back to status store
  const syncStatus = useSyncStore((s) => s.sessionStatus[sessionId]);
  const isOptimisticCompacting = useOpenCodeCompactionStore((s) =>
    Boolean(s.compactingBySession[sessionId]),
  );
  const sessionStatus = syncStatus;
  const isServerBusy =
    sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';

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
  const effectiveBusy =
    isServerBusy ||
    pendingSendInFlight ||
    isOptimisticCompacting;

  // Short visual fade (300ms) — matches the reference's 260ms delay-hide.
  // Goes true immediately, stays visible briefly after going idle so the
  // UI doesn't flicker between agentic steps. NOT a 2s debounce.
  const [isBusy, setIsBusy] = useState(effectiveBusy);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout>>();
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
      if (
        !cached.parentID ||
        !latestUserId ||
        cached.parentID !== latestUserId
      ) {
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
    const existingText =
      typeof existing?.text === 'string' ? existing.text : '';
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
  }, [
    messages,
    sessionId,
    shouldRecoveryPoll,
    streamCacheKey,
    hasPendingUserReply,
  ]);

  // ---- Message Queue ----
  // Mirrors OpenCode's `followup` queue (research/opencode/packages/app/src/
  // pages/session.tsx, lines 540-2018):
  //   - per-session items + paused + failed flags in the store
  //   - one reactive drain effect (use-message-queue-drain) — no setTimeout,
  //     no requestAnimationFrame, no double locks
  //   - failed items stay at the head and don't auto-retry
  //   - paused is set on session abort and cleared on enqueue / send-now
  const queuedMessages = useMessageQueueStore(selectSessionItems(sessionId));
  const queueRemove = useMessageQueueStore((s) => s.remove);
  const queueMoveUp = useMessageQueueStore((s) => s.moveUp);
  const queueMoveDown = useMessageQueueStore((s) => s.moveDown);
  const queueClearSession = useMessageQueueStore((s) => s.clearSession);
  const queueSetPaused = useMessageQueueStore((s) => s.setPaused);
  const queueSetFailed = useMessageQueueStore((s) => s.setFailed);
  const [queueExpanded, setQueueExpanded] = useState(false);

  const hasActiveQuestionForQueue = useOpenCodePendingStore((s) =>
    Object.values(s.questions).some((q) => q.sessionID === sessionId),
  );

  // Composite gate. The drain only fires when ALL of these are clear:
  //
  //   - isBusy: the debounced UI busy state (2s tail after server idles)
  //   - isServerBusy: server-reported status === 'busy' | 'retry'
  //   - hasIncompleteAssistant: latest assistant message hasn't completed
  //   - hasPendingUserReply: there's a user message with no assistant reply yet
  //   - pendingSendInFlight: a previous handleSend hasn't been server-acked
  //   - hasActiveQuestionForQueue: a structured question is awaiting answer
  //
  // While ANY of these are true, queued messages accumulate in the local
  // store and the queue UI shows them. When ALL clear (the assistant turn
  // is genuinely complete), the drain fires ONCE and sends every queued
  // item concurrently via Promise.allSettled — the OpenCode server's
  // runner (research/opencode/packages/opencode/src/effect/runner.ts:111)
  // serializes the prompt_async calls per-session so they execute in
  // arrival order, but we don't have to wait for the assistant response
  // between client-side sends.
  const canDrain =
    !isBusy &&
    !isServerBusy &&
    !hasIncompleteAssistant &&
    !hasPendingUserReply &&
    !pendingSendInFlight &&
    !hasActiveQuestionForQueue;

  // handleSend is defined later in the component, but we need a stable
  // reference for the drain hook. Use a ref so the hook always sees the
  // current closure without re-firing on every render.
  const handleSendRef = useRef<typeof handleSend>();

  useMessageQueueDrain({
    sessionId,
    canDrain,
    sendFn: useCallback(
      async (msgs: QueuedMessage[]) => {
        // Defensive filter: drop any items the user removed (or send-now'd)
        // between the drain snapshot and now. Without this, a send-now click
        // mid-drain would cause the same message to be sent twice.
        const liveIds = new Set(
          (useMessageQueueStore.getState().items[sessionId] ?? []).map(
            (m) => m.id,
          ),
        );
        const toSend = msgs.filter((m) => liveIds.has(m.id));
        if (toSend.length === 0) return;

        // Fire all queued messages CONCURRENTLY in one synchronous burst.
        // Each handleSend runs its sync prefix (build optimistic message →
        // addOptimisticUserMessage → setStatus busy) up to its first await
        // (file upload OR promptAsync). Because all N sync prefixes run
        // back-to-back in the same JS tick BEFORE any await yields, React
        // batches the N optimistic-add store mutations into a single
        // re-render — the user sees all N user messages appear at once,
        // not staggered.
        //
        // After the .map returns N pending promises, Promise.allSettled
        // waits for all of them. Each handleSend's `await promptAsync` is
        // an HTTP call to /session/.../prompt_async which the server
        // accepts (204) and queues internally via its per-session Runner
        // deferred chain (research/opencode/packages/opencode/src/effect/
        // runner.ts:111). The server processes them in arrival order.
        const results = await Promise.allSettled(
          toSend.map((msg) =>
            // Cast: AttachedFile and QueuedFile share the same shape but live
            // in different module hierarchies; runtime values are interchangeable.
            handleSendRef.current!(
              msg.text,
              msg.files as AttachedFile[] | undefined,
              undefined,
              {
                agent: msg.agent ?? undefined,
                model: msg.model ?? undefined,
                variant: msg.variant ?? undefined,
              },
            ),
          ),
        );

        // Per-item state reconciliation. Successful items are removed from
        // the queue; failed items stay put. We mark `failed` to the first
        // remaining failed item's id so the drain effect doesn't retry-loop
        // (the gate `failed === items[0].id` blocks the next cycle until
        // the user manually intervenes via send-now or remove).
        const store = useMessageQueueStore.getState();
        let anyFailed = false;
        results.forEach((result, idx) => {
          const msg = toSend[idx];
          if (result.status === 'fulfilled') {
            store.remove(sessionId, msg.id);
          } else {
            anyFailed = true;
            console.error('[message-queue] item send failed', {
              sessionId,
              messageId: msg.id,
              err: result.reason,
            });
          }
        });

        if (anyFailed) {
          const remaining =
            useMessageQueueStore.getState().items[sessionId] ?? [];
          if (remaining.length > 0) {
            store.setFailed(sessionId, remaining[0].id);
          }
        }
      },
      [sessionId],
    ),
  });

  // Send-now handler. Matches OpenCode (session.tsx:2016-2018, sendFollowup
  // with `manual: true`): just send the queued item now, regardless of pause.
  // Does NOT abort the current turn — the OpenCode server's runner will
  // serialize concurrent prompt_async calls via its deferred chain (see
  // research/opencode/packages/opencode/src/effect/runner.ts:111).
  const handleQueueSendNow = useCallback(
    (messageId: string) => {
      const msg = useMessageQueueStore
        .getState()
        .items[sessionId]?.find((m) => m.id === messageId);
      if (!msg) return;
      // Clearing pause + failed lets the drain effect re-pick this up if the
      // synchronous send below races. setFailed is also called to clear any
      // prior failure on this id.
      queueSetPaused(sessionId, false);
      queueSetFailed(sessionId, undefined);
      queueRemove(sessionId, messageId);
      void handleSendRef.current!(
        msg.text,
        msg.files as AttachedFile[] | undefined,
        undefined,
        {
          agent: msg.agent ?? undefined,
          model: msg.model ?? undefined,
          variant: msg.variant ?? undefined,
        },
      ).catch(() => {
        // handleSend already cleaned up the optimistic UI; nothing more to do.
      });
    },
    [sessionId, queueSetPaused, queueSetFailed, queueRemove],
  );

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
          const currentStatus =
            useSyncStore.getState().sessionStatus[sessionId];
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
          (m) =>
            m.info.role === 'assistant' &&
            (m.info as any).parentID === pendingSendMessageId,
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
  const hasActiveQuestion = useOpenCodePendingStore((s) =>
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
      (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current =
        node;
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
  const allPermissions = useOpenCodePendingStore((s) => s.permissions);
  const allQuestions = useOpenCodePendingStore((s) => s.questions);
  const addQuestion = useOpenCodePendingStore((s) => s.addQuestion);
  const pendingPermissions = useMemo(
    () =>
      Object.values(allPermissions).filter((p) => p.sessionID === sessionId),
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
  const [renderedQuestion, setRenderedQuestion] =
    useState<QuestionRequest | null>(null);
  const [questionPromptVisible, setQuestionPromptVisible] = useState(false);
  const questionPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
  const questionHydrationInFlightRef = useRef(false);
  const lastQuestionHydrationAtRef = useRef(0);
  const turns = useMemo(
    () => (messages ? groupMessagesIntoTurns(messages) : []),
    [messages],
  );
  const hasAnyMessages = turns.length > 0;
  const hasChatContent =
    hasAnyMessages || (!!optimisticPrompt && !hasAnyMessages);
  const WELCOME_FADE_MS = 900;
  const [welcomeFadeActive, setWelcomeFadeActive] = useState(false);
  const welcomeFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
  const hasRunningQuestionTool = useMemo(() => {
    if (!messages) return false;
    return messages.some((m) => {
      if (m.info.role !== 'assistant') return false;
      return m.parts.some((p) => {
        if (p.type !== 'tool') return false;
        const tool = p as ToolPart;
        if (tool.tool !== 'question') return false;
        return (
          tool.state.status === 'running' || tool.state.status === 'pending'
        );
      });
    });
  }, [messages]);

  // Self-heal missed question events: if we see a question tool part running
  // but no pending question request in the store, rehydrate question.list().
  // Keep polling while the tool is running because the first list() call can
  // race with backend request creation and return an empty list.
  useEffect(() => {
    if (!isActiveSessionTab || !hasRunningQuestionTool || pendingQuestions.length > 0) return;

    const client = getClient();
    let cancelled = false;

    const hydrateQuestions = () => {
      if (questionHydrationInFlightRef.current || cancelled) return;
      const now = Date.now();
      if (now - lastQuestionHydrationAtRef.current < 1500) return;

      questionHydrationInFlightRef.current = true;
      lastQuestionHydrationAtRef.current = now;

      void client.question
        .list()
        .then((res) => {
          if (!res.data || cancelled) return;
          (res.data as any[]).forEach((q) => {
            if (!q?.id || isQuestionSuppressed(q.id)) return;
            addQuestion(q);
          });
        })
        .finally(() => {
          questionHydrationInFlightRef.current = false;
        });
    };

    hydrateQuestions();
    const timer = setInterval(hydrateQuestions, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    isActiveSessionTab,
    hasRunningQuestionTool,
    pendingQuestions.length,
    addQuestion,
    isQuestionSuppressed,
  ]);

  // ---- Permission/question reply handlers ----
  const removePermission = useOpenCodePendingStore((s) => s.removePermission);
  const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);

  const handlePermissionReply = useCallback(
    async (requestId: string, reply: 'once' | 'always' | 'reject') => {
      try {
        await replyToPermission(requestId, reply);
        removePermission(requestId);
      } catch {
        // ignore
      }
    },
    [removePermission],
  );

  const handleQuestionReply = useCallback(
    async (requestId: string, answers: string[][]) => {
      // Snapshot the question BEFORE removing it so we can cache the
      // answer against the tool part's ID.
      const questionReq =
        useOpenCodePendingStore.getState().questions[requestId];

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
              input:
                ((match as ToolPart).state?.input as Record<string, unknown>) ??
                {},
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
          turn.assistantMessages.some(
            (msg) => (msg.info as any).summary === true,
          ) ||
          turn.assistantMessages.some((msg) =>
            msg.parts.some((p) => p.type === 'compaction'),
          ),
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

    const target = contentEl.querySelector<HTMLElement>(
      `[data-turn-id="${targetMessageId}"]`,
    );
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
    setIsRetrying(false);
    lastSendTimeRef.current = 0;
  }, [sessionId]);

  // ============================================================================
  // Billing: DISABLED — billing is handled server-side by the router
  // (POST /v1/router/chat/completions deducts credits per LLM call).
  // This frontend useEffect was causing double-billing once opencode.jsonc
  // got cost config and step-finish.cost became non-zero.
  // ============================================================================

  // ============================================================================
  // Fork handlers
  // ============================================================================

  const handleFork = useCallback(
    async (userMessageId: string) => {
      setConfirmForkMessageId(null);
      const msg = messages?.find((item) => item.info.id === userMessageId);
      const forkedSession = await forkSession.mutateAsync({
        sessionId,
        messageId: userMessageId,
        directory: session?.directory,
        workspace: session?.workspaceID,
      });
      if (msg) stashForkPrompt(forkedSession.id, buildForkPrompt(msg.parts));

      const title = forkedSession.title || 'Forked session';
      openTabAndNavigate({
        id: forkedSession.id,
        title,
        type: 'session',
        href: `/sessions/${forkedSession.id}`,
        serverId: useServerStore.getState().activeServerId,
      });
    },
    [
      sessionId,
      forkSession,
      messages,
      session?.directory,
      session?.workspaceID,
    ],
  );

  const handleEditFork = useCallback(
    async (userMessageId: string, newText: string) => {
      const msg = messages?.find((item) => item.info.id === userMessageId);
      const forkedSession = await forkSession.mutateAsync({
        sessionId,
        messageId: userMessageId,
        directory: session?.directory,
        workspace: session?.workspaceID,
      });
      if (msg)
        stashForkPrompt(forkedSession.id, buildForkPrompt(msg.parts, newText));

      const title = forkedSession.title || 'Forked session';
      openTabAndNavigate({
        id: forkedSession.id,
        title,
        type: 'session',
        href: `/sessions/${forkedSession.id}`,
        serverId: useServerStore.getState().activeServerId,
      });
    },
    [
      sessionId,
      forkSession,
      messages,
      session?.directory,
      session?.workspaceID,
    ],
  );

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
       * (matches OpenCode FollowupDraft semantics).
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

      // Structured @-mention refs — emitted as <project_ref /> / <file_ref />
      // / <agent_ref /> blocks appended to the outgoing text. Same shape as
      // the existing <session_ref /> handling, so the agent gets uniform
      // metadata and the frontend can strip them back out on render.
      const isFirstMessage = !messages || messages.length === 0;
      const projectMentionRefs: ProjectRefLike[] = (mentions ?? [])
        .filter((m) => m.kind === 'project' && m.label)
        .map((m) => ({
          id: m.value,
          name: m.label,
          path: m.path,
          description: m.description,
        }));
      const pickedProjectRef: ProjectRefLike | null =
        isFirstMessage && selectedProject
          ? {
              id: selectedProject.id,
              name: selectedProject.name,
              path: selectedProject.path,
              description: selectedProject.description,
            }
          : null;
      // De-dupe: if the picked project is also @-mentioned, keep only one.
      const mergedProjectRefs: ProjectRefLike[] = pickedProjectRef
        ? [
            pickedProjectRef,
            ...projectMentionRefs.filter(
              (p) => p.id !== pickedProjectRef.id && p.name !== pickedProjectRef.name,
            ),
          ]
        : projectMentionRefs;

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
      // (not duplicate) the optimistic parts. This matches OpenCode's
      // SolidJS approach where part IDs are sent with the prompt request.
      const textPartId = ascendingId('prt');
      const remoteFiles = (files ?? []).filter(
        (file): file is Extract<AttachedFile, { kind: 'remote' }> =>
          file.kind === 'remote',
      );
      const localFiles = (files ?? []).filter(
        (file): file is Extract<AttachedFile, { kind: 'local' }> =>
          file.kind === 'local',
      );
      // The server (/file/upload) assigns the final, collision-free path.
      // We pass the sanitized name for the upload and use it in the
      // optimistic text as a placeholder — the real path returned by the
      // server replaces it when the message is actually sent.
      const uploadPlans = localFiles.map((af) => {
        const safeName = af.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        return {
          file: af.file,
          filename: af.file.name,
          mime: af.file.type || 'application/octet-stream',
          safeName,
          optimisticPath: `/workspace/uploads/${safeName}`,
        };
      });

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
        if (sessionMentionsForOptimistic.some((m) => m.value === rawId))
          continue;
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
      if (uploadPlans.length > 0) {
        const optimisticFileRefs = uploadPlans
          .map(
            (f) =>
              `<file path="${f.optimisticPath}" mime="${f.mime}" filename="${f.filename}">\nThis file has been uploaded and is available at the path above.\n</file>`,
          )
          .join('\n');
        optimisticText = `${optimisticText}\n\n${optimisticFileRefs}`;
      }
      if (remoteFiles.length > 0) {
        const optimisticFileRefs = remoteFiles
          .map(
            (file) =>
              `<file path="${file.filename}" mime="${file.mime}" filename="${file.filename}">\nThis file will be restored from the forked prompt.\n</file>`,
          )
          .join('\n');
        optimisticText = `${optimisticText}\n\n${optimisticFileRefs}`;
      }
      if (allOptimisticSessionMentions.length > 0) {
        const refs = allOptimisticSessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        optimisticText = `${optimisticText}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }
      if (mergedProjectRefs.length > 0) {
        optimisticText = appendProjectRefs(optimisticText, mergedProjectRefs);
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
      // Matches OpenCode: sync.set("session_status", session.id, { type: "busy" })
      addOptimisticUserMessage(messageID, optimisticText, [textPartId]);
      useSyncStore.getState().setStatus(sessionId, { type: 'busy' });

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
      if (overrideAgent !== undefined) {
        if (overrideAgent) options.agent = overrideAgent;
      } else if (local.agent.current) {
        options.agent = local.agent.current.name;
      }
      if (overrideModel !== undefined) {
        if (overrideModel) options.model = overrideModel;
      } else if (local.model.currentKey) {
        options.model = local.model.currentKey;
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
        | typeof textPrompt
        | { type: 'file'; mime: string; url: string; filename: string }
      > = [textPrompt];
      parts.push(
        ...remoteFiles.map((file) => ({
          type: 'file' as const,
          mime: file.mime,
          url: file.url,
          filename: file.filename,
        })),
      );

      if (uploadPlans.length > 0) {
        const uploadResults = await Promise.all(
          uploadPlans.map(async (plan) => {
            const uploadBlob = new File([plan.file], plan.safeName, {
              type: plan.file.type,
            });
            const results = await uploadFile(uploadBlob, '/workspace/uploads');
            if (!results || results.length === 0) {
              throw new Error(`Failed to upload file: ${plan.filename}`);
            }
            return {
              path: results[0].path,
              mime: plan.mime,
              filename: plan.filename,
            };
          }),
        );
        const uploadedFileRefs = uploadResults
          .map(
            (f) =>
              `<file path="${f.path}" mime="${f.mime}" filename="${f.filename}">\nThis file has been uploaded and is available at the path above.\n</file>`,
          )
          .join('\n');
        textPrompt.text = `${textPrompt.text}\n\n${uploadedFileRefs}`;
      }

      // Append session reference hints for @session mentions.
      // Merge tracked mentions with any raw @ses_<id> tags typed directly.
      const trackedSessionMentions =
        mentions?.filter((m) => m.kind === 'session' && m.value) ?? [];

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

      const allSessionMentions = [
        ...trackedSessionMentions,
        ...rawSessionIdMentions,
      ];
      if (allSessionMentions.length > 0) {
        const refs = allSessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        textPrompt.text = `${textPrompt.text}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }
      if (mergedProjectRefs.length > 0) {
        const block = buildProjectRefsBlock(mergedProjectRefs);
        if (block) textPrompt.text = `${textPrompt.text}\n\n${block}`;
      }
      if (fileMentionRefs.length > 0) {
        const block = buildFileRefsBlock(fileMentionRefs);
        if (block) textPrompt.text = `${textPrompt.text}\n\n${block}`;
      }
      if (agentMentionRefs.length > 0) {
        const block = buildAgentRefsBlock(agentMentionRefs);
        if (block) textPrompt.text = `${textPrompt.text}\n\n${block}`;
      }

      // Send via session.promptAsync. The server returns 204 immediately and
      // streams the response over SSE — we await the ACK so callers (queue
      // drain, input box) can handle send failures, but the actual response
      // body still arrives via the sync store.
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
      const client = getClient();
      const handleSendError = () => {
        useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
        // Fetch real messages from the server. Some error paths
        // (e.g. missing API key) return the error directly in the
        // HTTP response without emitting a session.error SSE event.
        // Without this fetch, removing the optimistic message can
        // leave the UI blank.
        client.session
          .messages({ sessionID: sessionId })
          .then((res) => {
            if (res.data) {
              useSyncStore.getState().hydrate(sessionId, res.data as any);
              useSyncStore.getState().clearOptimisticMessages(sessionId);
            } else {
              removeOptimisticUserMessage(messageID);
            }
          })
          .catch(() => {
            removeOptimisticUserMessage(messageID);
          });
      };

      let res: any;
      try {
        res = await client.session.promptAsync({
          sessionID: sessionId,
          parts: mappedParts,
          ...(sendOpts?.agent ? { agent: sendOpts.agent } : {}),
          ...(sendOpts?.model ? { model: sendOpts.model } : {}),
          ...(sendOpts?.variant ? { variant: sendOpts.variant } : {}),
        } as any);
      } catch (err) {
        // Network / thrown SDK error — clean up and propagate so the queue
        // drain can mark the item as failed and the input can restore text.
        handleSendError();
        throw err;
      }

      // The SDK resolves (not rejects) on HTTP errors, returning
      // { error: ... } instead of throwing. Treat this as a failure so the
      // UI doesn't stay stuck on "busy" with the optimistic user bubble.
      if (res?.error) {
        handleSendError();
        const message =
          (typeof res.error?.data?.message === 'string' && res.error.data.message) ||
          (typeof res.error === 'string' && res.error) ||
          'Failed to send message';
        throw new Error(message);
      }

      return messageID;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionId,
      local.agent.current,
      local.model.currentKey,
      local.model.variant.current,
      addOptimisticUserMessage,
      removeOptimisticUserMessage,
      scrollToBottom,
      replyTo,
      messages,
      selectedProject,
    ],
  );

  // Wire the queue drain to the latest handleSend without triggering the
  // drain effect on every handleSend identity change.
  handleSendRef.current = handleSend;

  const handleStop = useCallback(() => {
    // Guard against rapid clicks — ignore if an abort is already in flight
    if (abortSession.isPending) {
      console.log(
        `[handleStop] Ignoring - abort already in flight for session ${sessionId}`,
      );
      return;
    }
    console.log(`[handleStop] Stopping session ${sessionId}`);
    // Optimistically mark the session idle so the UI updates immediately
    // (stop button hides, input re-enables) without waiting for the SSE
    // round-trip. Also clear the busy debounce timer to bypass the 2s delay.
    useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
    clearTimeout(busyTimerRef.current);
    setIsBusy(false);

    // Optimistically patch an abort error onto the last assistant message
    // so the "Interrupted" label appears instantly — no waiting for the SSE
    // session.error round-trip.
    const store = useSyncStore.getState();
    const msgs = store.messages[sessionId];
    if (msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant' && !(msgs[i] as any).error) {
          store.upsertMessage(sessionId, {
            ...msgs[i],
            error: {
              name: 'AbortError',
              data: { message: 'The operation was aborted.' },
            },
          } as any);
          break;
        }
      }
    }

    // Pause queue auto-drain on abort. Matches OpenCode (session.tsx:2011-2015,
    // `onAbort: setFollowup("paused", id, true)`). Enqueueing a new message or
    // clicking "send now" on a queued item will clear the pause.
    queueSetPaused(sessionId, true);
    abortSession.mutate(sessionId);
  }, [sessionId, abortSession, queueSetPaused]);

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

      if (e.defaultPrevented) return;

      // Only the main chat composer should arm triple-ESC stop. Modal/dialog ESC
      // handling and other focused controls must never advance this counter.
      const active = document.activeElement;
      const isChatTextareaFocused =
        active instanceof HTMLTextAreaElement &&
        active.dataset.sessionChatStopScope === 'true';

      if (!isChatTextareaFocused) return;

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
      const selectedModel = local.model.currentKey
        ? formatModelString(local.model.currentKey)
        : undefined;
      const handleCommandError = (err?: unknown) => {
        setPendingCommand(null);
        setPendingUserMessage(null);
        setPendingUserMessageId(null);
        setPollingActive(false);
        pendingCommandStashRef.current = null;
        useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
        setCommandError(formatCommandError(err));
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
          ...(local.agent.current && { agent: local.agent.current.name }),
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
      local.agent.current,
      local.model.currentKey,
      local.model.variant.current,
    ],
  );

  const handleFileSearch = useCallback(
    async (query: string): Promise<string[]> => {
      try {
        return await searchWorkspaceFiles(query);
      } catch {
        return [];
      }
    },
    [],
  );

  // Thread context for subsessions only (real parentID).
  const { data: parentSessionData } = useOpenCodeSession(
    session?.parentID || '',
  );
  const threadContext = useMemo(() => {
    if (!session?.parentID || !parentSessionData) return undefined;
    return {
      variant: 'thread' as const,
      parentTitle: parentSessionData.title || 'Parent session',
      onBackToParent: () => {
        openTabAndNavigate({
          id: parentSessionData.id,
          title: parentSessionData.title || 'Parent session',
          type: 'session',
          href: `/sessions/${parentSessionData.id}`,
          serverId: useServerStore.getState().activeServerId,
        });
      },
    };
  }, [session?.parentID, parentSessionData]);

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
  const isDataLoading =
    !session && sessionLoading && !hasMessages && !optimisticPrompt;
  const isNotFound = !session && !sessionLoading && !optimisticPrompt;
  const showOptimistic = !!optimisticPrompt && !hasMessages;
  const isTransitioningFromWelcome =
    !prevHasChatContentRef.current && hasChatContent;
  const shouldShowWelcomeOverlay =
    !hasChatContent || welcomeFadeActive || isTransitioningFromWelcome;

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Full-bleed welcome wallpaper — spans the entire session (behind header,
          messages, project selector, and chat input). Input renders as frosted
          glass so the wallpaper reads through uninterrupted. */}
      {shouldShowWelcomeOverlay && (
        <div
          className={cn(
            'absolute inset-0 z-0 pointer-events-none transition-opacity ease-out',
            hasChatContent ? 'opacity-0' : 'opacity-100',
          )}
          style={{ transitionDuration: `${WELCOME_FADE_MS}ms` }}
        >
          <SessionWelcome />
        </div>
      )}

      {/* Session header — always mounted */}
      {!hideHeader && (
        <SessionSiteHeader
          sessionId={sessionId}
          sessionTitle={session?.title || 'Untitled'}
          onToggleSidePanel={handleTogglePanel}
          isSidePanelOpen={isSidePanelOpen}
          canOpenSidePanel={hasToolCalls}
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

      {/* Content area — loading, not-found, or actual messages */}
      {isDataLoading ? (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <KortixLoader size="small" />
        </div>
      ) : isNotFound ? (
        <div className="flex-1 flex items-center justify-center min-h-0 text-sm text-muted-foreground">
          Session not found
        </div>
      ) : (
        <div ref={chatAreaRef} className="relative flex-1 min-h-0 z-10">
          <div
            ref={scrollContainerCallbackRef}
            className={cn(
              'relative flex-1 overflow-y-auto scrollbar-hide px-4 py-4 h-full [scroll-behavior:auto] z-10',
              shouldShowWelcomeOverlay ? 'bg-transparent' : 'bg-background',
            )}
            onMouseUp={handleChatMouseUp}
            onMouseDown={handleChatMouseDown}
            onScroll={handleChatScroll}
          >
            <div
              ref={contentRef}
              role="log"
              className="mx-auto max-w-3xl min-w-0 w-full px-3 sm:px-6"
            >
              <div className="flex flex-col min-w-0">
                {/* Optimistic user message */}
                {showOptimistic && (
                  <div data-turn-id="optimistic" className="mt-12 first:mt-0">
                    <div className="flex justify-end">
                      <div className="flex flex-col max-w-[90%] rounded-3xl rounded-br-lg bg-card border overflow-hidden">
                        {(() => {
                          const {
                            cleanText: afterReply,
                            replyContext: optReply,
                          } = parseReplyContext(optimisticPrompt || '');
                          const { cleanText: afterFiles, files } =
                            parseFileReferences(afterReply);
                          const { cleanText: afterProjects, projects: optProjects } =
                            parseProjectReferences(afterFiles);
                          const { cleanText: afterFileMentions } =
                            parseFileMentionReferences(afterProjects);
                          const { cleanText: afterAgentMentions } =
                            parseAgentMentionReferences(afterFileMentions);
                          const { cleanText } =
                            parseSessionReferences(afterAgentMentions);
                          return (
                            <>
                              {optReply && (
                                <div className="flex items-center gap-2 mx-3 mt-3 mb-0 px-3 py-1.5 rounded-xl bg-primary/5 border border-primary/10">
                                  <Reply className="size-3 text-primary/60 flex-shrink-0" />
                                  <span className="text-[11px] text-muted-foreground truncate">
                                    {optReply.length > 150
                                      ? `${optReply.slice(0, 150)}...`
                                      : optReply}
                                  </span>
                                </div>
                              )}
                              {files.length > 0 && (
                                <div className="flex gap-2 p-3 pb-0 flex-wrap">
                                  {files.map((f, i) => (
                                    <div
                                      key={i}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <GridFileCard
                                        filePath={f.path}
                                        fileName={
                                          f.path.split('/').pop() || f.path
                                        }
                                        onClick={() => openPreview(f.path)}
                                      />
                                    </div>
                                  ))}
                                </div>
                              )}
                              {optProjects.length > 0 && (
                                <div className="flex gap-1.5 mx-3 mt-3 mb-0 flex-wrap">
                                  {optProjects.map((p, i) => (
                                    <button
                                      key={`${p.id || p.name}-${i}`}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (p.id) {
                                          openTabAndNavigate({
                                            id: `project:${p.id}`,
                                            title: p.name,
                                            type: 'project',
                                            href: `/projects/${encodeURIComponent(p.id)}`,
                                          });
                                        }
                                      }}
                                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted/60 border border-border/60 hover:bg-muted hover:border-border transition-colors cursor-pointer"
                                      title={p.path}
                                    >
                                      <span className="text-[11px] font-medium text-foreground">
                                        {p.name}
                                      </span>
                                      {p.path && (
                                        <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[240px]">
                                          {p.path}
                                        </span>
                                      )}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {cleanText && (
                                <p className="text-sm leading-relaxed whitespace-pre-wrap px-4 py-3">
                                  <HighlightMentions
                                    text={cleanText}
                                    agentNames={agentNames}
                                    projectNames={optProjects.map((p) => p.name)}
                                    onFileClick={openFileInComputer}
                                  />
                                </p>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src="/kortix-logomark-white.svg"
                        alt="Kortix"
                        className="dark:invert-0 invert flex-shrink-0 h-[14px] w-auto"
                      />
                      {isRetrying && (
                        <span className="text-xs text-amber-500">
                          Retrying connection...
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {isOptimisticCompacting && !hasCompactionTurn && (
                  <div className="space-y-3 mt-12">
                    <div className="flex items-center gap-3 py-4 my-3">
                      <div className="flex-1 h-px bg-border" />
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/80 border border-border/60">
                        <Layers className="size-3.5 text-muted-foreground" />
                        <span className="text-[11px] font-semibold text-muted-foreground tracking-wide">
                          Compaction
                        </span>
                      </div>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                    <div className="flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src="/kortix-logomark-white.svg"
                        alt="Kortix"
                        className="dark:invert-0 invert flex-shrink-0 h-[14px] w-auto"
                      />
                      <div className="text-sm text-muted-foreground">
                        Compacting session...
                      </div>
                    </div>
                  </div>
                )}

                {/* Turn-based message rendering */}
                {turns.map((turn, turnIndex) => {
                  // Check if this turn is a compaction summary
                  const hasCompaction =
                    turn.assistantMessages.some(
                      (msg) => (msg.info as any).summary === true,
                    ) ||
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
                        <div className="flex items-center gap-3 py-4 my-3">
                          <div className="flex-1 h-px bg-border" />
                          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/80 border border-border/60">
                            <Layers className="size-3.5 text-muted-foreground" />
                            <span className="text-[11px] font-semibold text-muted-foreground tracking-wide">
                              Compaction
                            </span>
                          </div>
                          <div className="flex-1 h-px bg-border" />
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
                        onFork={async (userMessageId) => {
                          setConfirmForkMessageId(userMessageId);
                        }}
                        onEditFork={handleEditFork}
                        providers={providers}
                        commandMessages={commandMessagesRef.current}
                        commands={commands}
                        disableToolNavigation={disableToolNavigation}
                        onPermissionReply={handlePermissionReply}
                      />
                    </div>
                  );
                })}

                {/* Busy indicator when no turns yet but session is busy */}
                {commandError && (
                  <TurnErrorDisplay errorText={commandError} className="mt-2" />
                )}
                {!showOptimistic && isBusy && turns.length === 0 && (
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/kortix-logomark-white.svg"
                      alt="Kortix"
                      className="dark:invert-0 invert flex-shrink-0 h-[14px] w-auto"
                    />
                  </div>
                )}
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
              className="absolute z-50 animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
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
            scrollRef={scrollRef}
            contentRef={contentRef}
            messages={messages || []}
          />

          {/* Scroll to bottom FAB */}
          <div
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2 transition-colors duration-300 ease-out',
              showScrollButton
                ? 'opacity-100 translate-y-0 scale-100'
                : 'opacity-0 translate-y-4 scale-95 pointer-events-none',
            )}
          >
            <Button
              variant="outline"
              size="sm"
              className="rounded-full h-7 text-xs bg-background/90 border-border/60 shadow-lg"
              onClick={smoothScrollToAbsoluteBottom}
            >
              <ArrowDown className="size-3 mr-1" />
              Scroll to bottom
            </Button>
          </div>
        </div>
      )}

      {/* Project selector — only on the empty state, above the chat input.
          Same component the dashboard uses, so the picked project is shared
          via the selected-project store. The preamble is injected on first
          send inside handleSend. */}
      {!readOnly && !hasChatContent && (
        <div className="relative z-10">
          <ProjectSelector
            selectedProjectId={selectedProjectId}
            onSelect={setSelectedProjectId}
          />
        </div>
      )}

      {/* Input — hidden in read-only mode (sub-session modal) */}
      {!readOnly && (
        <SessionChatInput
          onSend={async (text, files, mentions) => {
            await handleSend(text, files, mentions);
          }}
          isBusy={isBusy}
          onStop={handleStop}
          escCount={escCount}
          agents={local.agent.list}
          selectedAgent={local.agent.current?.name ?? null}
          onAgentChange={(name) => local.agent.set(name ?? undefined)}
          commands={commands || []}
          onCommand={handleCommand}
          models={local.model.list}
          selectedModel={local.model.currentKey ?? null}
          onModelChange={(m) =>
            local.model.set(m ?? undefined, { recent: true })
          }
          variants={local.model.variant.list}
          selectedVariant={local.model.variant.current ?? null}
          onVariantChange={(v) => local.model.variant.set(v ?? undefined)}
          messages={messages}
          sessionId={sessionId}
          onFileSearch={handleFileSearch}
          providers={providers}
          threadContext={threadContext}
          onContextClick={() => setContextModalOpen(true)}
          replyTo={replyTo}
          onClearReply={handleClearReply}
          lockForQuestion={!!renderedQuestion}
          onCustomAnswer={(text) => {
            questionPromptRef.current?.submitCustomAnswer(text);
          }}
          questionButtonLabel={renderedQuestion ? questionAction.label : null}
          questionCanAct={questionAction.canAct}
          onQuestionAction={() => {
            questionPromptRef.current?.performAction();
          }}
          inputSlot={
            renderedQuestion || queuedMessages.length > 0 ? (
              <>
                {renderedQuestion && (
                  <div
                    className={cn(
                      'overflow-hidden transition-[max-height,opacity,transform] ease-in-out',
                      questionPromptVisible
                        ? 'max-h-[520px] opacity-100 translate-y-0 duration-300'
                        : 'max-h-0 opacity-0 -translate-y-1 duration-320 pointer-events-none',
                    )}
                  >
                    <QuestionPrompt
                      ref={questionPromptRef}
                      request={renderedQuestion}
                      onReply={handleQuestionReply}
                      onReject={handleQuestionReject}
                      onActionChange={handleQuestionActionChange}
                    />
                  </div>
                )}
                {queuedMessages.length > 0 && (
                  <div className="rounded-xl bg-muted/50 overflow-hidden">
                    {/* Compact header row */}
                    <Button
                      type="button"
                      onClick={() => setQueueExpanded((v) => !v)}
                      variant="ghost"
                      className="flex items-center gap-2 w-full px-3 py-1.5 h-auto rounded-none justify-start hover:bg-muted/80"
                    >
                      <ListPlus className="size-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-xs text-muted-foreground flex-1 text-left truncate">
                        {queuedMessages.length} message
                        {queuedMessages.length !== 1 ? 's' : ''} queued
                        {!queueExpanded && queuedMessages.length > 0 && (
                          <span className="text-foreground/80 font-medium">
                            {(() => {
                              const previewText = queuedMessages[0].text.trim();
                              if (previewText.length > 0) {
                                return (
                                  <>
                                    {' '}
                                    · {previewText.slice(0, 50)}
                                    {previewText.length > 50 ? '…' : ''}
                                  </>
                                );
                              }
                              const fileCount =
                                queuedMessages[0].files?.length ?? 0;
                              if (fileCount > 0) {
                                return (
                                  <>
                                    {' '}
                                    · {fileCount} file{fileCount > 1 ? 's' : ''}
                                  </>
                                );
                              }
                              return null;
                            })()}
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            queueClearSession(sessionId);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              queueClearSession(sessionId);
                            }
                          }}
                          className="inline-flex items-center justify-center size-5 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <X className="size-3" />
                        </span>
                        <ChevronUp
                          className={cn(
                            'size-3 text-muted-foreground/40 transition-transform',
                            !queueExpanded && 'rotate-180',
                          )}
                        />
                      </div>
                    </Button>

                    {/* Expanded list — show for any number of queued messages */}
                    {queueExpanded && queuedMessages.length > 0 && (
                      <div className="border-t border-border/30 max-h-[160px] overflow-y-auto scrollbar-hide">
                        <div className="flex flex-col px-1.5 py-1">
                          {queuedMessages.map((qm, idx) => (
                            <div
                              key={qm.id}
                              className="group/q flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-muted/60 transition-colors"
                            >
                              <span className="text-[10px] tabular-nums text-muted-foreground/40 shrink-0 w-3 text-center">
                                {idx + 1}
                              </span>
                              <p className="flex-1 text-xs text-muted-foreground truncate min-w-0">
                                {qm.text ||
                                  `${qm.files?.length ?? 0} file${(qm.files?.length ?? 0) === 1 ? '' : 's'}`}
                              </p>
                              <div className="flex items-center gap-0.5 opacity-0 group-hover/q:opacity-100 transition-opacity shrink-0">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      type="button"
                                      onClick={() => handleQueueSendNow(qm.id)}
                                      variant="ghost"
                                      size="icon-xs"
                                    >
                                      <Send className="size-2.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">
                                    <p className="text-xs">Send now</p>
                                  </TooltipContent>
                                </Tooltip>
                                {idx > 0 && (
                                  <Button
                                    type="button"
                                    onClick={() => queueMoveUp(sessionId, qm.id)}
                                    variant="ghost"
                                    size="icon-xs"
                                  >
                                    <ArrowUp className="size-2.5" />
                                  </Button>
                                )}
                                {idx < queuedMessages.length - 1 && (
                                  <Button
                                    type="button"
                                    onClick={() => queueMoveDown(sessionId, qm.id)}
                                    variant="ghost"
                                    size="icon-xs"
                                  >
                                    <ArrowDown className="size-2.5" />
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  onClick={() => queueRemove(sessionId, qm.id)}
                                  variant="ghost"
                                  size="icon-xs"
                                  className="hover:text-destructive hover:bg-destructive/10"
                                >
                                  <X className="size-2.5" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : undefined
          }
        />
      )}
      <ConfirmForkDialog
        open={!!confirmForkMessageId}
        onOpenChange={(open) => {
          if (!open) setConfirmForkMessageId(null);
        }}
        onConfirm={() => {
          if (!confirmForkMessageId) return;
          void handleFork(confirmForkMessageId);
        }}
        loading={forkSession.isPending}
      />
    </div>
  );
}
