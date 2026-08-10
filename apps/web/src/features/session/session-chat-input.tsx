'use client';

import { useTranslations } from 'next-intl';

import { searchWorkspaceFiles } from '@/features/files';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { isImageFile } from '@/lib/utils/file-utils';
import { normalizeAppPathname } from '@kortix/sdk/instance-routes';
import type {
  Agent,
  Command,
  MessageWithParts,
  ProviderListResponse,
  Session,
} from '@kortix/sdk/react';
import { useRuntimeSessions } from '@kortix/sdk/react';

import {
  ArrowUpLeftIcon as ArrowUpLeft,
  ArrowBendUpLeftIcon as Reply,
  TerminalWindowIcon as Terminal,
  XIcon as X,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { usePathname } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extractClipboardFiles } from './clipboard-files';
import {
  mergeFailedSubmissionFiles,
  mergeFailedSubmissionMentions,
  mergeFailedSubmissionText,
} from './composer-draft-recovery';
import { resolveComposerResetOnSend } from './composer-reset';
import { AttachmentPreview } from './composer/attachment-preview';
import { ComposerToolbar } from './composer/composer-toolbar';
import { MentionPopover } from './composer/mention-popover';
import { shouldQueueInsteadOfSend } from './message-queue-boundary';
import { QueuedMessages, type QueuedMessageView } from './composer/queued-messages';
import { SlashCommandPopover } from './composer/slash-command-popover';
import type { AttachedFile, MentionItem, TrackedMention } from './composer/types';
import {
  NO_MODEL_AVAILABLE_ACTION_MESSAGE,
  NO_MODEL_AVAILABLE_MESSAGE,
  isModelRequiredButUnavailable,
  resolveAvailableSelectedModel,
} from './model-availability';
import { ModelConnectionBar } from './model-connection-gate';
import { type ModelDefaultControls } from './model-selector';
import { useModelConnectionGate } from './use-model-connection-gate';

// Re-exported for backward compatibility — `AgentSelector` moved to
// `./composer/agent-selector`, but is a public export of this module (see
// e.g. `channels-view.tsx`, `schedule-view.tsx`).
export { AgentSelector } from './composer/agent-selector';
export type { AttachedFile, MentionItem, TrackedMention } from './composer/types';
export type { ProviderListResponse };

/** Stable empty list, so the memoized composer is not handed a fresh array. */
const EMPTY_QUEUE: QueuedMessageView[] = [];

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

// ============================================================================
// Flat model list helper
// ============================================================================
//
// Extracted to ./model-flatten — it's data, not UI, and this file is already
// far past the size where new logic belongs in it. Re-exported here so the
// many existing `from '@/features/session/session-chat-input'` importers keep
// working.
import type { FlatModel } from './model-flatten';

export { flattenModels, type FlatModel } from './model-flatten';

export interface SessionChatInputProps {
  onSend: (
    text: string,
    files?: AttachedFile[],
    mentions?: TrackedMention[],
  ) => void | Promise<void>;
  isBusy?: boolean;
  /**
   * Messages queued while `isBusy` was true — held client-side (mirrors
   * Claude Code/Codex) and flushed one at a time by the parent at the next
   * safe boundary instead of interleaving into the live turn. When present
   * alongside `onQueueMessage`, submitting while busy enqueues instead of
   * sending immediately.
   */
  queuedMessages?: QueuedMessageView[];
  /** Sends that failed for good. Rendered below the queue with a retry — they
   *  must never sit at the head holding up everything behind them. */
  failedQueuedMessages?: QueuedMessageView[];
  /** The queued message currently on the wire. Cannot be edited, moved or removed. */
  queueInFlightId?: string | null;
  /** The queue is held by a stop. Dims the list — never silent. */
  queuePaused?: boolean;
  /** The agent is mid-turn, so the per-row send must stop it first. */
  queueIsRunning?: boolean;
  /** Send this queued message now, stopping the running turn first if needed. */
  onSendQueuedMessageNow?: (id: string) => void;
  onQueueMessage?: (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onEditQueuedMessage?: (id: string, text: string) => void;
  onReorderQueuedMessage?: (id: string, toIndex: number) => void;
  /** Put a failed send back in the queue. */
  onRetryQueuedMessage?: (id: string) => void;
  onStop?: () => void;
  /**
   * Render the stop button in its disabled state even without an `onStop` — used
   * by the instant session shell while the computer is still booting, so the
   * busy input shows a (non-clickable) stop button instead of nothing at all.
   */
  stopDisabled?: boolean;
  /**
   * The send is in flight but hasn't navigated/settled yet — swap the send
   * button for a spinner (used by the project-home composer while the session
   * create POST round-trips). Distinct from `isBusy`, which means "the agent is
   * running" and shows a stop button instead.
   */
  isSending?: boolean;
  agents?: Agent[];
  selectedAgent?: string | null;
  onAgentChange?: (agentName: string | null | undefined) => void;
  /** Show the selected agent but prevent switching inside an immutable session. */
  agentSelectorLocked?: boolean;
  commands?: Command[];
  onCommand?: (command: Command, args?: string) => void;
  models?: FlatModel[];
  selectedModel?: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  /** Optional "set as default" controls for the model picker (account/per-agent). */
  modelDefaultControls?: ModelDefaultControls;
  variants?: string[];
  selectedVariant?: string | null;
  onVariantChange?: (variant: string | null | undefined) => void;
  messages?: MessageWithParts[];
  /** Session ID — used for message queue, todo chip, and mention filtering */
  sessionId?: string;
  /** Project ID — lets the reasoning-effort control read/write this
   *  project's per-model generation config (see reasoning-effort-selector.tsx). */
  projectId?: string;
  /** If true, disables the input (e.g. during session creation redirect) */
  disabled?: boolean;
  /**
   * Clear the composer optimistically on send (default true). Set false when the
   * send navigates the composer away (project-home → new session): the component
   * is about to unmount, so clearing first only flashes an empty box before the
   * route swaps — and would discard the user's text if the send is gated (e.g. a
   * paywall) instead of navigating. The instant session shell then carries the
   * message across as its optimistic turn, so the text reads as "moving" into the
   * thread rather than vanishing.
   */
  clearOnSend?: boolean;
  /** If true, a concrete model must be selected before a chat/command send. */
  modelRequired?: boolean;
  /** True while the provider/model catalog is still being fetched — suppresses
   *  the full-block "connect a model" gate so it doesn't flash for accounts
   *  that do have models but are mid-load (e.g. sandbox still warming up). */
  modelsLoading?: boolean;
  /** Auto-focus the textarea on mount (default: true on desktop) */
  autoFocus?: boolean;
  placeholder?: string;
  /** Imperative draft prefill used by parent composers for starter prompts or
   * failed first-turn recovery. Recovery merges instead of overwriting any
   * draft the user typed while the request was in flight. */
  prefill?: {
    text: string;
    id: number;
    files?: AttachedFile[];
    mode?: 'replace' | 'merge';
  } | null;

  /** Callback to search files via SDK for @ mentions */
  onFileSearch?: (query: string) => Promise<string[]>;
  /** Full provider list response (for connect/manage provider dialogs) */
  providers?: ProviderListResponse;

  /** Sub-session context — renders an inline indicator inside the input card */
  threadContext?: {
    parentTitle: string;
    onBackToParent: () => void;
  };

  /** Callback when the context usage indicator is clicked */
  onContextClick?: () => void;

  /** Slot rendered inside the input card, above the textarea (e.g. queue chip) */
  inputSlot?: React.ReactNode;

  /** Slot rendered inline in the bottom toolbar, just left of the voice button */
  toolbarSlot?: React.ReactNode;

  /** Extra classes for the input card — e.g. a radius override for the
   *  project-home hero composer (`rounded-xl`). The drag overlay follows. */
  cardClassName?: string;

  /** Reply context — shows a banner in the input indicating what's being replied to */
  replyTo?: { text: string } | null;
  /** Callback to clear the reply context */
  onClearReply?: () => void;
  /** When true, a structured question is active — send submits a custom answer instead of a chat message */
  lockForQuestion?: boolean;
  /** When true, a connector action is awaiting your approval — the run is paused,
   *  so the composer is locked until you approve/deny it above. */
  lockForApproval?: boolean;
  /** Called instead of onSend when lockForQuestion is true and the user submits text */
  onCustomAnswer?: (text: string) => void;
  /** Label for the send button when a question is active (e.g. "Next", "Submit"). Null = default arrow icon. */
  questionButtonLabel?: string | null;
  /** Whether the question action can be performed (controls send button disabled state during questions). */
  questionCanAct?: boolean;
  /** Called when the send button is clicked during a question and there's no text (i.e. the action is next/submit, not a custom answer). */
  onQuestionAction?: () => void;
  /** Number of ESC presses so far (0 = none, 1 = first, 2 = second). Triple-ESC to stop. */
  escCount?: number;
}

function SessionChatInputImpl({
  onSend,
  isBusy = false,
  queuedMessages,
  failedQueuedMessages,
  queueInFlightId = null,
  queuePaused,
  queueIsRunning,
  onSendQueuedMessageNow,
  onQueueMessage,
  onRemoveQueuedMessage,
  onEditQueuedMessage,
  onReorderQueuedMessage,
  onRetryQueuedMessage,
  onStop,
  stopDisabled = false,
  isSending = false,
  agents = [],
  selectedAgent = null,
  onAgentChange,
  agentSelectorLocked = false,
  commands = [],
  onCommand,
  models = [],
  selectedModel = null,
  onModelChange,
  modelDefaultControls,
  variants = [],
  selectedVariant = null,
  onVariantChange,
  messages,
  sessionId,
  projectId,
  disabled = false,
  clearOnSend = true,
  modelRequired = false,
  modelsLoading = false,
  autoFocus,
  placeholder = 'Ask anything...',
  prefill = null,

  onFileSearch,
  providers,
  threadContext,
  onContextClick,
  inputSlot,
  toolbarSlot,
  cardClassName,
  replyTo,
  onClearReply,
  lockForQuestion = false,
  lockForApproval = false,
  onCustomAnswer,
  questionButtonLabel = null,
  questionCanAct = true,
  onQuestionAction,
  escCount = 0,
}: SessionChatInputProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const placeholderVariants = useMemo(
    () => [
      placeholder,
      'Use / to run commands',
      'Reference files with @',
      'Ask about any file in this workspace',
      'Use Cmd+K to open command palette',
      'Press Tab to switch modes',
      'Use Up arrow to recall your last prompt',
      'Use Shift+Enter for a new line',
      'Ask to compact this session when context is full',
      'Ask for changed files and diffs',
      'Mention multiple files like @README.md @src/app.tsx',
      'Reference past sessions with @session-name',
    ],
    [placeholder],
  );
  const [text, setText] = useState('');
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [stagedCommand, setStagedCommand] = useState<Command | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const pathname = normalizeAppPathname(usePathname());
  const isOnboarding = pathname?.startsWith('/onboarding');
  const dragDepthRef = useRef(0);
  const primaryAgents = useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent'),
    [agents],
  );

  // File search: use provided callback or fall back to the SDK directly
  const fileSearchFn = useMemo(() => {
    if (onFileSearch) return onFileSearch;
    return async (query: string): Promise<string[]> => {
      try {
        return await searchWorkspaceFiles(query);
      } catch {
        return [];
      }
    };
  }, [onFileSearch]);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<{ query: string; triggerPos: number } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentions, setMentions] = useState<TrackedMention[]>([]);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileSearchSeq = useRef(0); // sequence counter to discard stale results
  // Cache of all file results seen during the current mention session.
  // This survives across query changes so that narrowing a query (e.g. "te" → "test")
  // never loses results even if the API returns empty for the longer query.
  const fileResultsCache = useRef<Set<string>>(new Set());

  const savedTextBeforeQuestionRef = useRef('');
  const prefillId = prefill?.id;
  const prefillText = prefill?.text ?? '';
  const prefillFiles = prefill?.files;
  const prefillMode = prefill?.mode;
  useEffect(() => {
    if (
      prefillId === undefined ||
      (!prefillText && !prefillFiles?.length && prefillMode !== 'replace')
    ) {
      return;
    }
    setText((current) =>
      prefillMode === 'merge' ? mergeFailedSubmissionText(current, prefillText) : prefillText,
    );
    if (prefillFiles?.length) {
      setAttachedFiles((current) =>
        prefillMode === 'merge'
          ? mergeFailedSubmissionFiles(current, prefillFiles)
          : [...prefillFiles],
      );
    }
    setStagedCommand(null);
    setSlashFilter(null);
    setMentionQuery(null);
    setMentions([]);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(prefillText.length, prefillText.length);
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      if (highlightRef.current) {
        highlightRef.current.style.height = ta.style.height;
      }
    });
  }, [prefillId, prefillText, prefillFiles, prefillMode]);

  useEffect(() => {
    if (lockForQuestion) {
      // Question appeared — save current draft and clear input
      savedTextBeforeQuestionRef.current = text;
      setText('');
    } else if (savedTextBeforeQuestionRef.current) {
      // Question dismissed — restore the saved draft
      setText(savedTextBeforeQuestionRef.current);
      savedTextBeforeQuestionRef.current = '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to lockForQuestion changes
  }, [lockForQuestion]);

  // ChatGPT-like behavior: if the user starts typing while the textarea is not
  // focused, redirect the keystroke into this textarea and focus it.
  useEffect(() => {
    const isTextEditingElement = (el: Element | null) => {
      if (!el) return false;
      const htmlEl = el as HTMLElement;
      if (htmlEl.isContentEditable) return true;
      const tag = htmlEl.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typeof e.key !== 'string') return;
      if (e.key.length !== 1) return; // printable characters only

      const ta = textareaRef.current;
      if (!ta || ta.offsetParent === null) return;
      if (document.activeElement === ta) return;
      if (isTextEditingElement(document.activeElement)) return;

      e.preventDefault();
      ta.focus();

      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      ta.setRangeText(e.key, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [disabled]);

  // Sessions for @ mention search
  const { data: allSessions } = useRuntimeSessions();

  useEffect(() => {
    if (text.trim().length > 0) return;

    const interval = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % placeholderVariants.length);
    }, 6000);

    return () => {
      clearInterval(interval);
    };
  }, [text, placeholderVariants.length]);

  // Listen for 'focus-session-textarea' events (dispatched when a session tab
  // is activated from the sidebar or dashboard). Only the visible textarea
  // (inside the active, non-hidden tab) will respond. Retries briefly in case
  // the event fires before React has finished rendering the new tab.
  useEffect(() => {
    const handler = () => {
      const tryFocus = (retries: number) => {
        const el = textareaRef.current;
        if (el && el.offsetParent !== null) {
          el.focus();
          return;
        }
        if (retries > 0) {
          requestAnimationFrame(() => tryFocus(retries - 1));
        }
      };
      tryFocus(10);
    };
    window.addEventListener('focus-session-textarea', handler);
    return () => window.removeEventListener('focus-session-textarea', handler);
  }, []);

  // Default autoFocus: true on desktop, false on mobile
  const shouldAutoFocus = autoFocus ?? (typeof window !== 'undefined' && window.innerWidth >= 640);

  // Focus the textarea whenever it becomes visible (handles mount, tab switch,
  // and new-session creation where the component may mount inside a hidden div
  // that is revealed after a Zustand state update).
  useEffect(() => {
    if (!shouldAutoFocus) return;
    const el = textareaRef.current;
    if (!el) return;

    // If already visible, focus immediately
    if (el.offsetParent !== null) {
      el.focus();
      return;
    }

    // Otherwise observe visibility — the parent div toggles `hidden` via CSS
    // class, so IntersectionObserver will fire when it becomes visible.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          el.focus();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [shouldAutoFocus]);

  const appendAttachedFiles = useCallback((files: Iterable<File>) => {
    const newFiles: AttachedFile[] = [];
    for (const file of files) {
      const localUrl = URL.createObjectURL(file);
      newFiles.push({ kind: 'local', file, localUrl, isImage: isImageFile(file) });
    }
    if (newFiles.length === 0) return;
    setAttachedFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled || lockForQuestion) {
      e.target.value = '';
      return;
    }
    const files = e.target.files;
    if (!files) return;
    appendAttachedFiles(Array.from(files));
    e.target.value = '';
  };

  const dragHasFiles = useCallback((e: React.DragEvent<HTMLElement>) => {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }, []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (disabled || lockForQuestion || !dragHasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setIsDragOver(true);
    },
    [disabled, lockForQuestion, dragHasFiles],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (disabled || lockForQuestion || !dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    [disabled, lockForQuestion, dragHasFiles],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragOver(false);
      }
    },
    [dragHasFiles],
  );

  const handleDropFiles = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (disabled || lockForQuestion || !dragHasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      const dropped = e.dataTransfer.files;
      if (!dropped || dropped.length === 0) return;
      appendAttachedFiles(Array.from(dropped));
    },
    [appendAttachedFiles, disabled, lockForQuestion, dragHasFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled || lockForQuestion) return;
      const files = extractClipboardFiles(e.clipboardData);
      // No files on the clipboard — let the browser handle the text paste.
      if (files.length === 0) return;
      e.preventDefault();
      appendAttachedFiles(files);
    },
    [appendAttachedFiles, disabled, lockForQuestion],
  );

  const removeAttachedFile = (index: number) => {
    setAttachedFiles((prev) => {
      const removed = prev[index];
      if (removed?.kind === 'local') URL.revokeObjectURL(removed.localUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  const filteredCommands = useMemo(() => {
    if (slashFilter === null) return [];
    const q = slashFilter.toLowerCase();
    return commands.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q),
    );
  }, [commands, slashFilter]);

  // Debounced file search for @ mentions
  // Uses a persistent cache (fileResultsCache) so that narrowing a query never
  // loses results — even if the API returns empty for longer queries.
  useEffect(() => {
    clearTimeout(fileSearchTimer.current);
    if (!mentionQuery) {
      setFileResults([]);
      setFileSearchLoading(false);
      fileResultsCache.current.clear();
      return;
    }
    // Immediately apply cached results that match the new query so the popover
    // never flickers empty while waiting for the debounced API call.
    const q = mentionQuery.query.toLowerCase();
    if (fileResultsCache.current.size > 0) {
      const cachedMatches = Array.from(fileResultsCache.current).filter(
        (f) => q.length === 0 || f.toLowerCase().includes(q),
      );
      if (cachedMatches.length > 0) {
        setFileResults(cachedMatches.slice(0, 20));
      }
    }
    setFileSearchLoading(true);
    const seq = ++fileSearchSeq.current;
    const currentQuery = mentionQuery.query;
    fileSearchTimer.current = setTimeout(async () => {
      try {
        const results = await fileSearchFn(currentQuery);
        // Add new results to the persistent cache
        for (const r of results) {
          fileResultsCache.current.add(r);
        }
        // Only apply if this is still the latest request
        if (seq === fileSearchSeq.current) {
          // Merge: API results + cached results that still match the query
          const ql = currentQuery.toLowerCase();
          const cachedMatches = Array.from(fileResultsCache.current).filter(
            (f) => ql.length === 0 || f.toLowerCase().includes(ql),
          );
          const merged = new Set([...results, ...cachedMatches]);
          setFileResults(Array.from(merged).slice(0, 20));
          setFileSearchLoading(false);
        }
      } catch {
        if (seq === fileSearchSeq.current) {
          // On error, fall back to cached results that match
          const ql = currentQuery.toLowerCase();
          const cachedMatches = Array.from(fileResultsCache.current).filter(
            (f) => ql.length === 0 || f.toLowerCase().includes(ql),
          );
          setFileResults(cachedMatches.slice(0, 20));
          setFileSearchLoading(false);
        }
      }
    }, 150);
    return () => clearTimeout(fileSearchTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery?.query, fileSearchFn]);

  // Build mention popover items: agents (sync) + sessions (sync) + files (async)
  // File results are also filtered client-side against the current query so that
  // previously fetched results remain visible even if a longer query yields fewer
  // server-side results (e.g. SDK returns files for "te" but not for "test").
  const mentionItems = useMemo((): MentionItem[] => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    const agentItems: MentionItem[] = agents
      .filter((a) => (a.name || '').toLowerCase().includes(q))
      .map((a) => ({ kind: 'agent' as const, label: a.name || '', value: a.name || '' }));

    // Session items: filter by title, session ID, or changed file paths, exclude current/child/archived
    const sessionItems: MentionItem[] = (allSessions ?? [])
      .filter((s: Session) => {
        if (s.parentID || s.time.archived) return false;
        if (s.id === sessionId) return false;
        const title = (s.title || '').toLowerCase();
        if (title.includes(q)) return true;
        // Also match by session ID (e.g. @ses_2ec118d4...)
        if (s.id.toLowerCase().includes(q)) return true;
        // Also match against file paths in summary diffs
        const diffs = s.summary?.diffs;
        if (Array.isArray(diffs)) {
          return diffs.some((d: any) => (d.file || '').toLowerCase().includes(q));
        }
        return false;
      })
      .slice(0, 5)
      .map((s: Session) => {
        const ago = formatRelativeTime(s.time.updated);
        const files = s.summary?.files;
        const desc = files ? `${ago} - ${files} file${files === 1 ? '' : 's'} changed` : ago;
        return { kind: 'session' as const, label: s.title || s.id, value: s.id, description: desc };
      });

    const filteredFiles =
      q.length > 0 ? fileResults.filter((f) => f.toLowerCase().includes(q)) : fileResults;
    const fileItems: MentionItem[] = filteredFiles.map((f) => ({
      kind: 'file' as const,
      label: f,
      value: f,
    }));
    return [...agentItems, ...sessionItems, ...fileItems];
  }, [mentionQuery, agents, allSessions, sessionId, fileResults]);

  // Clamp mention index when items change to prevent out-of-bounds selection
  useEffect(() => {
    if (mentionItems.length > 0) {
      setMentionIndex((i) => Math.min(i, mentionItems.length - 1));
    }
  }, [mentionItems.length]);

  // Drives the "connect a model" bar under the input. Two distinct dead-end
  // states both surface it — either way the composer cannot send and needs to
  // say why:
  //  1. Nothing SELECTED (`!selectedModel`, i.e. `modelUnavailable`) — the
  //     send button is hard-disabled with only a tooltip explaining it.
  //  2. Nothing USABLE (`!hasSelectableModels`) — entitlement check: NOT
  //     `models.length === 0`, because the gateway bakes its whole catalog
  //     into every project regardless of plan or connected keys; this accounts
  //     for free-tier gating and which providers are actually connected.
  // Both are only consulted after every input settles (`modelsLoading` for the
  // provider catalog, `entitlementsPending` for account/secrets/project), so
  // the bar renders exactly once with the final answer instead of flashing in
  // on half-loaded data and vanishing when the account state arrives.
  const { hasSelectableModels, isSelectableModel, entitlementsPending } =
    useModelConnectionGate(models);
  const availableSelectedModel = entitlementsPending
    ? selectedModel
    : resolveAvailableSelectedModel(selectedModel, isSelectableModel);
  const modelUnavailable = isModelRequiredButUnavailable({
    modelRequired,
    selectedModel: availableSelectedModel,
    lockForQuestion,
  });
  const noModelsConnected =
    modelRequired &&
    !lockForQuestion &&
    !modelsLoading &&
    !entitlementsPending &&
    (!availableSelectedModel || !hasSelectableModels);
  const canSubmit = text.trim().length > 0 || attachedFiles.length > 0;
  const submitDisabled = disabled || modelUnavailable || lockForApproval;

  const handleSubmit = useCallback(async () => {
    if (modelUnavailable) {
      toast.error(NO_MODEL_AVAILABLE_MESSAGE, {
        description: NO_MODEL_AVAILABLE_ACTION_MESSAGE,
      });
      return;
    }

    // The run is paused on a connector approval — resolve it above first.
    if (lockForApproval) {
      toast.error('Approve or deny the pending action to continue.');
      return;
    }

    // If a command is staged, execute it with the current text as args
    if (stagedCommand) {
      const args = text.trim();
      onCommand?.(stagedCommand, args || undefined);
      if (clearOnSend) {
        setText('');
        setStagedCommand(null);
        setAttachedFiles((prev) => {
          for (const file of prev) {
            if (file.kind === 'local') URL.revokeObjectURL(file.localUrl);
          }
          return [];
        });
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      }
      return;
    }

    // If a question is active, route through question logic
    if (lockForQuestion) {
      const trimmed = text.trim();
      if (trimmed && onCustomAnswer) {
        // User typed a custom answer — submit it
        onCustomAnswer(trimmed);
        setText('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        return;
      }
      // No text — perform the question action (next/submit)
      if (onQuestionAction) {
        onQuestionAction();
        return;
      }
      return;
    }

    const trimmed = text.trim();
    if ((!trimmed && attachedFiles.length === 0) || submitDisabled) return;

    // Snapshot files and mentions before clearing
    const filesToSend = attachedFiles.length > 0 ? [...attachedFiles] : undefined;
    const mentionsToSend = mentions.length > 0 ? [...mentions] : undefined;

    // Optimistically clear input — UNLESS this send navigates the composer away
    // (project-home → new session, `clearOnSend={false}`). There, clearing first
    // only flashes an empty box before the route swaps, discards the text on a
    // gated send, and would revoke the local file URLs the instant shell still
    // needs to preview. The text/files ride across via the start-stash instead.
    // (Decision + which URLs to revoke extracted to `resolveComposerResetOnSend`.)
    const reset = resolveComposerResetOnSend(clearOnSend, attachedFiles);
    if (reset.clear) {
      setText('');
      setSlashFilter(null);
      setMentionQuery(null);
      setMentions([]);
      setAttachedFiles([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }

    // Hold the message client-side instead of sending it straight through —
    // mirrors Claude Code/Codex's "queued while busy" behaviour. The parent
    // releases it when the turn genuinely ends.
    //
    // The condition is NOT just `isBusy`. That flag is false during the drain's
    // settle window and in the gap between claiming a message and the server
    // reporting the session busy — submitting in either window would send this
    // message ahead of ones already waiting, or put two prompts on the wire at
    // once. Anything queued or in flight means this one waits too.
    if (
      onQueueMessage &&
      shouldQueueInsteadOfSend({
        isBusy,
        pendingCount: queuedMessages?.length ?? 0,
        hasInFlight: queueInFlightId != null,
      })
    ) {
      onQueueMessage(trimmed, filesToSend, mentionsToSend);
      return;
    }

    // Send directly. The OpenCode server serializes concurrent prompt_async
    // calls per-session, so sending while the agent is busy is safe even
    // without queuing — this path is only reached when no queue is wired up.
    try {
      await onSend(trimmed, filesToSend, mentionsToSend);
      for (const url of reset.urlsToRevoke) URL.revokeObjectURL(url);
    } catch {
      // Restore the entire submitted draft, not just its text. Object URLs stay
      // alive until success, so local files remain retryable. Merge with any
      // text/files/mentions added while the request was in flight instead of
      // overwriting newer work.
      if (clearOnSend) {
        setText((current) => mergeFailedSubmissionText(current, trimmed));
        setAttachedFiles((current) => mergeFailedSubmissionFiles(current, filesToSend ?? []));
        setMentions((current) => mergeFailedSubmissionMentions(current, mentionsToSend ?? []));
      }
    }
  }, [
    text,
    submitDisabled,
    modelUnavailable,
    clearOnSend,
    onSend,
    isBusy,
    onQueueMessage,
    queuedMessages,
    queueInFlightId,
    queuePaused,
      queueIsRunning,
    onSendQueuedMessageNow,
    onCommand,
    stagedCommand,
    attachedFiles,
    mentions,
    lockForQuestion,
    lockForApproval,
    onCustomAnswer,
    onQuestionAction,
  ]);

  const handleSelectCommand = (cmd: Command) => {
    // Stage the command — show an args input instead of executing immediately
    setStagedCommand(cmd);
    setText('');
    setSlashFilter(null);
    setSlashIndex(0);
    // Focus textarea for args input
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleSelectMention = (item: MentionItem) => {
    if (!mentionQuery) return;
    const before = text.slice(0, mentionQuery.triggerPos);
    const after = text.slice(mentionQuery.triggerPos + 1 + mentionQuery.query.length); // +1 for '@'
    const inserted = `@${item.label} `;
    const newText = before + inserted + after;
    setText(newText);
    setMentions((prev) => [
      ...prev,
      {
        kind: item.kind,
        label: item.label,
        ...(item.kind === 'session' ? { value: item.value } : {}),
      },
    ]);
    setMentionQuery(null);
    setMentionIndex(0);
    setFileResults([]);
    fileResultsCache.current.clear();
    // Refocus and position cursor after inserted mention
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const cursorPos = before.length + inserted.length;
        ta.selectionStart = cursorPos;
        ta.selectionEnd = cursorPos;
        ta.style.height = 'auto';
        const newHeight = Math.min(ta.scrollHeight, 200) + 'px';
        ta.style.height = newHeight;
        if (highlightRef.current) {
          highlightRef.current.style.height = newHeight;
        }
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Staged command: Escape cancels, Enter submits (handled by normal submit flow)
    if (stagedCommand && e.key === 'Escape') {
      e.preventDefault();
      setStagedCommand(null);
      setText('');
      return;
    }

    // @ mention popover keyboard navigation
    if (mentionQuery !== null && (mentionItems.length > 0 || fileSearchLoading)) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (mentionItems.length > 0) setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (mentionItems.length > 0)
          setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (mentionItems.length > 0) {
          e.preventDefault();
          handleSelectMention(mentionItems[mentionIndex]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (slashFilter !== null && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelectCommand(filteredCommands[slashIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashFilter(null);
        return;
      }
    }

    // Tab cycles through agents when no popover is open
    if (e.key === 'Tab' && primaryAgents.length > 1 && onAgentChange && !agentSelectorLocked) {
      e.preventDefault();
      const currentIdx = primaryAgents.findIndex((a) => a.name === selectedAgent);
      const nextIdx = (currentIdx + 1) % primaryAgents.length;
      onAgentChange(primaryAgents[nextIdx].name);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    // Slash command detection (disabled while a command is staged)
    if (!stagedCommand) {
      const match = val.match(/^\/(\S*)$/);
      if (match) {
        setSlashFilter(match[1]);
        setSlashIndex(0);
      } else {
        setSlashFilter(null);
      }
    }

    // @ mention detection: walk backwards from cursor to find @
    const cursorPos = e.target.selectionStart ?? val.length;
    let mentionDetected = false;
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = val[i];
      if (ch === ' ' || ch === '\n') break; // stop at whitespace
      if (ch === '@') {
        // Must be at start of input or preceded by whitespace (not email-like)
        const charBefore = i > 0 ? val[i - 1] : ' ';
        if (charBefore === ' ' || charBefore === '\n' || i === 0) {
          const query = val.slice(i + 1, cursorPos);
          // Don't re-trigger popover for already-tracked mentions
          const isAlreadyTracked = mentions.some((m) => m.label === query);
          if (!isAlreadyTracked) {
            setMentionQuery({ query, triggerPos: i });
            setMentionIndex(0);
            mentionDetected = true;
          }
        }
        break;
      }
    }
    if (!mentionDetected) {
      setMentionQuery(null);
    }

    // Prune tracked mentions whose @label text was deleted
    setMentions((prev) => prev.filter((m) => val.includes(`@${m.label}`)));

    const ta = e.target;
    ta.style.height = 'auto';
    const newHeight = Math.min(ta.scrollHeight, 200) + 'px';
    ta.style.height = newHeight;
    // Sync overlay height
    if (highlightRef.current) {
      highlightRef.current.style.height = newHeight;
    }
  };

  const handleTranscription = useCallback((transcribedText: string) => {
    setText((prev) => (prev ? `${prev} ${transcribedText}` : transcribedText));
  }, []);

  // Build highlighted segments for the overlay behind the textarea
  const highlightSegments = useMemo(() => {
    if (mentions.length === 0 || !text) return null;
    type SegKind = 'file' | 'agent' | 'session';
    // Collect all mention ranges sorted by position
    const ranges: { start: number; end: number; kind: SegKind }[] = [];
    for (const m of mentions) {
      const needle = `@${m.label}`;
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        ranges.push({ start: idx, end: idx + needle.length, kind: m.kind });
      }
    }
    if (ranges.length === 0) return null;
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);

    const segs: { text: string; kind?: SegKind }[] = [];
    let last = 0;
    for (const r of ranges) {
      if (r.start < last) continue;
      if (r.start > last) segs.push({ text: text.slice(last, r.start) });
      segs.push({ text: text.slice(r.start, r.end), kind: r.kind });
      last = r.end;
    }
    if (last < text.length) segs.push({ text: text.slice(last) });
    return segs;
  }, [text, mentions]);

  return (
    <div className="relative z-10 mx-auto w-full max-w-[52rem] shrink-0 px-2 pb-3 sm:px-4">
      {/* Todo panel removed — now inline inside the card as TodoChip */}
      <div
        ref={cardRef}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropFiles}
        className={cn(
          'bg-card border-border relative z-10 w-full overflow-visible rounded-xl border shadow transition-colors',
          cardClassName,
          isDragOver && 'border-primary',
        )}
      >
        <div className="relative flex w-full flex-col gap-2 overflow-visible">
          {isDragOver && (
            <div
              className={cn(
                'border-primary/70 bg-primary/5 pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[24px] border-2 border-dashed',
                cardClassName,
              )}
            >
              <span className="bg-background/90 text-foreground rounded-md px-3 py-1 text-xs font-medium">
                {tHardcodedUi.raw(
                  'componentsSessionSessionChatInput.line2038JsxTextDropFilesToAttach',
                )}
              </span>
            </div>
          )}
          {/* Slash command popover (portalled to body to escape overflow-hidden ancestors) */}
          {slashFilter !== null && filteredCommands.length > 0 && (
            <SlashCommandPopover
              commands={commands}
              filter={slashFilter}
              selectedIndex={slashIndex}
              onSelect={handleSelectCommand}
              anchorRef={cardRef}
            />
          )}

          {/* @ Mention popover (portalled to body to escape overflow-hidden ancestors) */}
          {mentionQuery !== null && (mentionItems.length > 0 || fileSearchLoading) && (
            <MentionPopover
              items={mentionItems}
              selectedIndex={mentionIndex}
              onSelect={handleSelectMention}
              loading={fileSearchLoading}
              anchorRef={cardRef}
            />
          )}

          {/* Inline chips: thread context, todos, queue — unified spacing */}
          {(threadContext || sessionId || inputSlot || replyTo || queuedMessages?.length) && (
            <div className="mx-3 mt-2.5 flex flex-col gap-1.5 empty:hidden">
              <QueuedMessages
                messages={queuedMessages ?? EMPTY_QUEUE}
                failed={failedQueuedMessages}
                inFlightId={queueInFlightId}
                paused={queuePaused}
                isRunning={queueIsRunning}
                onSendNow={onSendQueuedMessageNow}
                onRemove={onRemoveQueuedMessage}
                onEdit={onEditQueuedMessage}
                onReorder={onReorderQueuedMessage}
                onRetry={onRetryQueuedMessage}
              />
              {replyTo && (
                <div className="bg-primary/5 border-primary/10 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
                  <Reply className="text-primary/60 size-3 shrink-0" />
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {replyTo.text.length > 120 ? `${replyTo.text.slice(0, 120)}…` : replyTo.text}
                  </span>
                  {onClearReply && (
                    <button
                      type="button"
                      onClick={onClearReply}
                      className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                      aria-label={tHardcodedUi.raw(
                        'componentsSessionSessionChatInput.line2078JsxAttrAriaLabelClearReply',
                      )}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              )}
              {threadContext && (
                <button
                  onClick={threadContext.onBackToParent}
                  className={cn(
                    'text-muted-foreground hover:text-foreground hover:bg-muted/80 flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  )}
                >
                  <ArrowUpLeft className="text-muted-foreground size-3.5 shrink-0 transition-transform group-hover:-translate-x-0.5 group-hover:-translate-y-0.5" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {'Sub-session of'}{' '}
                    <span className="text-foreground/80 font-medium">
                      {threadContext.parentTitle}
                    </span>
                  </span>
                </button>
              )}
              {inputSlot}
            </div>
          )}

          {/* Attached files preview */}
          <AttachmentPreview files={attachedFiles} onRemove={removeAttachedFile} />

          {/* Staged command badge */}
          {stagedCommand && (
            <div className="flex min-w-0 items-center gap-2 px-4 pt-3 pb-0">
              <div className="bg-muted/60 border-border/50 flex max-w-full shrink-0 items-center gap-1.5 rounded-2xl border px-2.5 py-1">
                <Terminal className="text-muted-foreground size-3" />
                <span className="text-foreground max-w-[220px] truncate font-mono text-xs font-medium whitespace-nowrap sm:max-w-[320px]">
                  /{stagedCommand.name}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setStagedCommand(null);
                    setText('');
                  }}
                  className="text-muted-foreground hover:text-foreground ml-0.5 transition-colors"
                  aria-label={tHardcodedUi.raw(
                    'componentsSessionSessionChatInput.line2118JsxAttrAriaLabelCancelCommand',
                  )}
                >
                  <X className="size-3" />
                </button>
              </div>
              {stagedCommand.description && (
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {stagedCommand.description}
                </span>
              )}
            </div>
          )}

          <div className="flex max-h-[320px] translate-y-0 flex-col gap-1 px-3.5 opacity-100">
            <div className="relative w-full">
              {/* Submitting while the agent is busy queues the message instead
                  of sending it — see `handleSubmit`'s `onQueueMessage` branch.
                  The queue renders above, with its own controls; there is no
                  separate "add to queue" affordance because Enter already is
                  one. (This comment used to claim the opposite.) */}
              {text.trim().length === 0 && !stagedCommand && (
                <div
                  aria-hidden
                  className="text-muted-foreground pointer-events-none absolute top-4 left-0.5 h-6 w-[calc(100%-0.5rem)] overflow-hidden text-base sm:text-sm"
                >
                  {lockForApproval ? (
                    <div className="absolute inset-0 text-amber-600 dark:text-amber-400">
                      Approve or deny the action above to continue…
                    </div>
                  ) : lockForQuestion ? (
                    <div className="absolute inset-0">
                      {questionButtonLabel ? 'Or type your own answer...' : 'Type your answer...'}
                    </div>
                  ) : (
                    <AnimatePresence mode="wait" initial={false}>
                      <m.div
                        key={`${placeholderIndex}:${placeholderVariants[placeholderIndex]}`}
                        className="absolute inset-0"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] },
                        }}
                        exit={{
                          opacity: 0,
                          y: -8,
                          transition: { duration: 0.48, ease: [0.2, 0, 0.1, 1] },
                        }}
                      >
                        {placeholderVariants[placeholderIndex]}
                      </m.div>
                    </AnimatePresence>
                  )}
                </div>
              )}
              {text.trim().length === 0 && stagedCommand && (
                <div
                  aria-hidden
                  className="text-muted-foreground/50 pointer-events-none absolute top-4 left-0.5 text-base sm:text-sm"
                >
                  {tHardcodedUi.raw(
                    'componentsSessionSessionChatInput.line2185JsxTextEnterDetailsAndPressEnterOrPressEsc',
                  )}
                </div>
              )}
              {/* Highlight overlay — mirrors textarea text with colored mention spans */}
              {highlightSegments && (
                <div
                  ref={highlightRef}
                  aria-hidden
                  className="text-foreground pointer-events-none absolute inset-0 px-0.5 pt-4 pb-6 text-base leading-normal wrap-break-word whitespace-pre-wrap sm:text-sm"
                >
                  {highlightSegments.map((seg, i) => (
                    <span
                      key={i}
                      className={cn(
                        (seg.kind === 'file' || seg.kind === 'agent' || seg.kind === 'session') &&
                          'border-foreground/40 text-foreground/80 border-b font-medium',
                      )}
                    >
                      {seg.text}
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onScroll={() => {
                  if (highlightRef.current && textareaRef.current) {
                    highlightRef.current.scrollTop = textareaRef.current.scrollTop;
                  }
                }}
                placeholder=""
                aria-label="Message input"
                rows={1}
                disabled={disabled || lockForApproval}
                className={cn(
                  'placeholder:text-muted-foreground relative max-h-[200px] min-h-[72px] w-full resize-none overflow-y-auto rounded-[24px] border-none bg-transparent px-0.5 pt-4 pb-6 text-base shadow-none outline-none focus-visible:ring-0 disabled:opacity-50 sm:text-sm',
                  highlightSegments && 'caret-foreground text-transparent',
                )}
                autoFocus={shouldAutoFocus}
              />
            </div>
          </div>

          {/* Bottom toolbar — hidden file input stays here since it needs
              `appendAttachedFiles`/`disabled`/`lockForQuestion` from this
              component's state; the visible attach button lives in
              ComposerToolbar and just triggers this ref. */}
          <input
            ref={fileInputRef}
            type="file"
            accept={tHardcodedUi.raw(
              'componentsSessionSessionChatInput.line2237JsxAttrAcceptImagePdfTxtMdJsonCsvXmlYaml',
            )}
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <ComposerToolbar
            onAttachClick={() => fileInputRef.current?.click()}
            modelsLoading={modelsLoading}
            agents={primaryAgents}
            selectedAgent={selectedAgent}
            onAgentChange={onAgentChange}
            agentSelectorLocked={agentSelectorLocked}
            models={models}
            selectedModel={availableSelectedModel}
            onModelChange={onModelChange}
            modelDefaultControls={modelDefaultControls}
            providers={providers}
            modelRequired={modelRequired}
            variants={variants}
            selectedVariant={selectedVariant}
            onVariantChange={onVariantChange}
            projectId={projectId}
            messages={messages}
            onContextClick={onContextClick}
            toolbarSlot={toolbarSlot}
            onTranscription={handleTranscription}
            voiceDisabled={submitDisabled || isBusy}
            isSending={isSending}
            isBusy={isBusy}
            onStop={onStop}
            stopDisabled={stopDisabled}
            escCount={escCount}
            lockForQuestion={lockForQuestion}
            questionButtonLabel={questionButtonLabel}
            questionCanAct={questionCanAct}
            hasText={text.trim().length > 0}
            canSubmit={canSubmit}
            submitDisabled={submitDisabled}
            disabled={disabled}
            modelUnavailable={modelUnavailable}
            onSubmit={handleSubmit}
          />
        </div>
      </div>
      <ModelConnectionBar show={noModelsConnected} />
    </div>
  );
}

/**
 * Memoized so the input subtree doesn't re-render on every streaming token.
 * `SessionChat` passes hooked-up (`useCallback`/`useMemo`) props for exactly
 * this reason — see the "Stable props for <SessionChatInput>" block in
 * session-chat.tsx. If a new inline arrow/object/array literal prop is added
 * to a `<SessionChatInput>` call site, this memo silently stops helping.
 */
export const SessionChatInput = memo(SessionChatInputImpl);
