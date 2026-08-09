'use client';

/**
 * The composer shell — Task 12 of the composer rebuild.
 *
 * Everything Tasks 1-11 built (the ProseMirror editor, the `@`/`/` menus,
 * the toolbar, the attachment tiles, `useComposerFocus`) gets assembled here
 * into the exact drop-in replacement for `SessionChatInputImpl`
 * (`../session-chat-input.tsx`). The one rule that matters more than any
 * other: **this component holds no `text` state and no `setText`.** Text
 * lives inside the TipTap editor; every read is imperative, via
 * `editorRef.current.getContent()`, taken only at the moments that need it
 * (submit, staged-command args, failed-send recovery). `ComposerToolbar`
 * only receives values that change on their own boundaries — `isEmpty` flips
 * once per empty↔non-empty transition, not once per keystroke — which is the
 * entire reason `ModelSelector`/`AgentSelector`/`TokenProgress`/
 * `VoiceRecorder`/`ReasoningEffortSelector` stop re-rendering on every
 * character typed.
 *
 * `session-chat-input.tsx` is NOT modified by this task — it stays live
 * until Task 13 swaps its call sites over to `Composer`. Do not import from
 * it except for the `SessionChatInputProps` type (this component must
 * accept the exact same prop surface) and the small set of pure functions
 * (`resolveComposerResetOnSend`, `mergeFailedSubmission*`,
 * `shouldQueueInsteadOfSend`) that already live at the `features/session`
 * root and were never session-chat-input-specific.
 */

import type { RefObject } from 'react';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { isImageFile } from '@/lib/utils/file-utils';
import type {
  Agent,
  Command,
  MessageWithParts,
  ProviderListResponse,
  Session,
} from '@kortix/sdk/react';
import { useRuntimeSessions } from '@kortix/sdk/react';
import type { JSONContent } from '@tiptap/core';

import {
  ArrowUpLeftIcon as ArrowUpLeft,
  ArrowBendUpLeftIcon as Reply,
  TerminalWindowIcon as Terminal,
  XIcon as X,
} from '@phosphor-icons/react';

import { extractClipboardFiles } from '../clipboard-files';
import { mergeFailedSubmissionFiles } from '../composer-draft-recovery';
import { resolveComposerResetOnSend } from '../composer-reset';
import { shouldQueueInsteadOfSend } from '../message-queue-boundary';
import type { FlatModel } from '../model-flatten';
import {
  NO_MODEL_AVAILABLE_ACTION_MESSAGE,
  NO_MODEL_AVAILABLE_MESSAGE,
  isModelRequiredButUnavailable,
  resolveAvailableSelectedModel,
} from '../model-availability';
import { ModelConnectionBar } from '../model-connection-gate';
import { type ModelDefaultControls } from '../model-selector';
import { useModelConnectionGate } from '../use-model-connection-gate';

import { AttachmentTiles } from './attachment-tiles';
import { ComposerToolbar } from './composer-toolbar';
import {
  appendTranscribedText,
  planFailedSendRecovery,
  planPrefillMerge,
  resolveEditorPlaceholder,
  shouldApplyPrefill,
  textToDocument,
} from './composer-logic';
import type { ComposerEditorHandle } from './editor/composer-editor';
import { useComposerFocus } from './hooks/use-composer-focus';
import type { SlashAction } from './menus/slash-actions';
import { QueuedMessages, type QueuedMessageView } from './queued-messages';
import type { AttachedFile, TrackedMention } from './types';

/**
 * The public prop surface — Task 13: moved here verbatim from
 * `../session-chat-input.tsx` (which used to define `SessionChatInputImpl`
 * against it) now that this component IS the live implementation and that
 * file is a pure re-export barrel. One field dropped in the move:
 * `onFileSearch`. It was accepted and silently ignored by this component
 * since Task 12 (`composer/hooks/use-file-search.ts` is a closed surface
 * that always calls `searchWorkspaceFiles` directly, with no override
 * parameter) — wiring it would have bypassed that hook's server-keyed
 * cache and reintroduced the per-composer staleness Task 2 removed. Its one
 * real caller, `session-chat.tsx`'s `handleFileSearch`, was already
 * byte-identical to the built-in fallback, so removing the prop is a no-op
 * for every existing caller — see `session-chat.tsx`'s own diff in this
 * task for the matching removal.
 */
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
  onQueueMessage?: (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onEditQueuedMessage?: (id: string, text: string) => void;
  onReorderQueuedMessage?: (id: string, toIndex: number) => void;
  /** Stop the running turn and send this queued message immediately. */
  onSendQueuedMessageNow?: (id: string) => void;
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

/** Stable empty list — mirrors `session-chat-input.tsx`'s `EMPTY_QUEUE`, same
 *  reasoning (never hand a fresh array to a memoized child). */
const EMPTY_QUEUE: QueuedMessageView[] = [];

/** Stands in for `getDocument()` when the lazy editor handle isn't there yet.
 *  Paired with `currentIsEmpty: true`, so `planPrefillMerge` takes its
 *  "current is empty → use the prefill verbatim" branch, matching what the old
 *  `setText(current => …)` did with an empty `current`. */
const EMPTY_DOCUMENT = textToDocument('');

/**
 * Fix round 1, Important: `/` while a command is staged used to be
 * impossible — `session-chat-input.tsx:1001`'s `handleInput` gated slash
 * detection on `!stagedCommand` entirely, at the regex level, before any
 * popover could open. `ComposerEditor`'s `/` trigger has no such gate (it
 * reacts to the live document, not a "staged" concept the shell tracks
 * separately), so typing `/` while filling in a staged command's args used
 * to open the `/` palette, and selecting a COMMAND row from it would
 * re-stage — silently discarding the args being typed. Passing this empty
 * list while staged empties the Commands/Skills/MCP sections, which is the
 * part that could re-stage.
 *
 * Task 13 closes the rest of it: round 1's fix left the `/` menu's Actions
 * section (switch-model, switch-agent, ...) still populated while staged,
 * because `SLASH_ACTIONS` was a fixed default `composer-editor.tsx` never
 * overrode. Selecting an action never re-staged a command, so it wasn't the
 * data-loss bug — but the menu still visibly opened over a staged command's
 * argument field, which reads as broken. `EMPTY_ACTIONS`, passed alongside
 * `EMPTY_COMMANDS` below, empties that section too, so the `/` palette is
 * genuinely fully suppressed while a command is staged.
 */
const EMPTY_COMMANDS: Command[] = [];
const EMPTY_ACTIONS: SlashAction[] = [];

/**
 * `ComposerEditor` (`./editor/composer-editor.tsx`) wraps `@tiptap/react` +
 * `prosemirror-*` — real weight that must not land in the first paint (T15
 * measures this). `React.lazy` + `Suspense` (`next/dynamic` is `React.lazy`
 * + `Suspense` internally — see `node_modules/next/dist/shared/lib/
 * lazy-dynamic/loadable.js` — so this is equivalent, just without a wrapper
 * this file doesn't need) gets `ComposerEditor`'s `import()` code-split into
 * its own chunk. Defined at module scope, not inside `ComposerImpl`: calling
 * `lazy()` fresh every render would hand React a new component type each
 * time, forcing an unmount/remount of the editor (and losing its content)
 * on every render.
 */
const ComposerEditorLazy = lazy(() =>
  import('./editor/composer-editor').then((mod) => ({ default: mod.ComposerEditor })),
);

/** Reserves the loaded editor's own min-height so the Suspense fallback
 *  doesn't shift layout once the real chunk resolves. */
function ComposerEditorFallback() {
  return <div className="min-h-[3rem]" aria-hidden />;
}

/**
 * Fix round 1, Minor: `ComposerEditorHandle.setContent`/`setDocument` always
 * end with `editor.commands.focus('end')` (composer-editor.tsx) — every call
 * moves focus AND the caret into the editor, with no way to opt out. That's
 * correct for prefill (the old code focused the textarea there too) and for
 * `onTypeAhead` (the editor IS the intended focus target). It is a
 * regression for failed-send recovery and the question-unlock restore: the
 * old code's equivalents (`setText(current => merge(...))`, `setText(saved)`)
 * never moved focus, so a user reading something else in the transcript when
 * a send failed, or when a question resolved, kept their attention where
 * they'd put it. This snapshots whatever had focus before the call and
 * restores it afterward whenever the editor itself wasn't already the focus
 * target — the only way to counteract a forced-focus primitive from outside
 * it.
 *
 * The mention-preserving counterpart to `handle.setContent` — Task 13. Used
 * by the failed-send recovery merge, the transcription append, and the
 * question-unlock restore, all of which snapshot/restore the full
 * ProseMirror document (`getDocument`/`setDocument`) instead of plain text,
 * specifically so any mention ATOM nodes present survive the round trip. See
 * `ComposerEditorHandle.getDocument`'s own doc comment (composer-editor.tsx)
 * for why `setContent` cannot do this.
 *
 * Previously a generic `withoutStealingFocus(handle, apply)` wrapper sat
 * between this and `handle.setDocument`, parameterized over which handle
 * method to apply and threading a `'replace' | 'merge'` mode through to it.
 * Every call site always passed `'replace'` (the merge itself is computed up
 * front, as a document, by `composer-logic.ts`), leaving `withoutStealingFocus`
 * with exactly one instantiation. Inlined here now that there is only one.
 */
function setDocumentWithoutStealingFocus(
  handle: ComposerEditorHandle | null,
  doc: JSONContent,
): void {
  if (!handle) return;
  const el = handle.getElement();
  const wasFocused = !!el && (document.activeElement === el || el.contains(document.activeElement));
  const previouslyFocused = wasFocused ? null : (document.activeElement as HTMLElement | null);
  handle.setDocument(doc);
  if (!wasFocused) {
    previouslyFocused?.focus?.();
  }
}

function ComposerImpl({
  onSend,
  isBusy = false,
  queuedMessages,
  failedQueuedMessages,
  queueInFlightId = null,
  onQueueMessage,
  onRemoveQueuedMessage,
  onEditQueuedMessage,
  onReorderQueuedMessage,
  onSendQueuedMessageNow,
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

  // ── State the shell actually owns — no `text`, no `setText`. ────────────
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [stagedCommand, setStagedCommand] = useState<Command | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  // Flips ONLY on the empty<->non-empty boundary (`ComposerEditor`'s
  // `onEmptyChange`) — never once per keystroke. This is what lets
  // `canSubmit`/`hasText` below feed `ComposerToolbar` without re-rendering
  // it on every character.
  const [isEmpty, setIsEmpty] = useState(true);

  const cardRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  // The full ProseMirror document, not text — Task 13. `null` means "nothing
  // to restore" (either not currently locked, or the draft was empty when
  // it got saved). See the `lockForQuestion` effect below for why this has
  // to be a document snapshot, not a string.
  const savedDocBeforeQuestionRef = useRef<JSONContent | null>(null);

  // ── The editor: dynamically loaded, imperative handle only. ─────────────
  const editorRef = useRef<ComposerEditorHandle | null>(null);
  // Real DOM node of the contenteditable (`editor.view.dom`), tracked as
  // state (not a plain ref) so that everything below that needs it —
  // `useComposerFocus`, the Tab-cycle/Escape listener, the paste
  // interceptor, the ARIA wiring — can react the moment it becomes
  // available. `useImperativeHandle`'s factory (composer-editor.tsx) only
  // reruns when TipTap's own `editor` instance changes identity, which
  // happens asynchronously after mount (`immediatelyRender: false`); a
  // plain ref populated once in a mount effect would too often still read
  // `null` the one time it's checked. A CALLBACK ref sidesteps that
  // entirely: React invokes it every time the forwarded handle's identity
  // changes (mount-time `null`-handle, then the real handle once TipTap's
  // editor exists), so this state is set at exactly the right moments.
  const [editorElement, setEditorElement] = useState<HTMLElement | null>(null);
  const setEditorRef = useCallback((handle: ComposerEditorHandle | null) => {
    editorRef.current = handle;
    setEditorElement(handle?.getElement() ?? null);
  }, []);

  const { data: allSessions } = useRuntimeSessions();

  const primaryAgents = useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent'),
    [agents],
  );

  /**
   * "The editor is inert." ONE definition, deliberately — Task 14.
   *
   * This condition previously appeared verbatim in two places: the
   * `useComposerFocus({ disabled })` call and the `ComposerEditorLazy`
   * `disabled` prop. They must agree, because the first decides whether a
   * keystroke typed anywhere on the page is redirected INTO the editor and
   * the second decides whether the editor accepts it — and they had already
   * drifted once (Task 13, MINOR 2: `useComposerFocus` was passed bare
   * `disabled`, so a stray character could land mid-draft in a composer
   * locked for a pending connector approval). Hoisting removes the only way
   * for that drift to recur.
   *
   * `lockForApproval` belongs here and `lockForQuestion` does not:
   * an approval lock means the run is paused waiting on the user, so the
   * composer is deliberately dead; a question lock still accepts a typed
   * custom answer.
   */
  const editorDisabled = disabled || lockForApproval;

  // ── Files: ported unchanged from session-chat-input.tsx:501-588. ────────
  const appendAttachedFiles = useCallback((files: Iterable<File>) => {
    const newFiles: AttachedFile[] = [];
    for (const file of files) {
      const localUrl = URL.createObjectURL(file);
      newFiles.push({ kind: 'local', file, localUrl, isImage: isImageFile(file) });
    }
    if (newFiles.length === 0) return;
    setAttachedFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled || lockForQuestion) {
        e.target.value = '';
        return;
      }
      const files = e.target.files;
      if (!files) return;
      appendAttachedFiles(Array.from(files));
      e.target.value = '';
    },
    [disabled, lockForQuestion, appendAttachedFiles],
  );

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

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

  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => {
      const removed = prev[index];
      if (removed?.kind === 'local') URL.revokeObjectURL(removed.localUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // ── Paste: ported from session-chat-input.tsx:570-580, moved to a native
  // listener in the CAPTURE phase on the editor's own DOM node. TipTap's
  // EditorView attaches its own `paste` handler directly on `view.dom`
  // (`editorElement`) once, at construction — by the time this effect runs
  // `editorElement` already exists, so this listener is always registered
  // AFTER TipTap's. Capture beats that ordering: capture-phase listeners on
  // an ANCESTOR of the real event target (the actual paste target is
  // whatever DOM node holds the caret, a descendant of `view.dom`) run
  // before any bubble-phase listener on that same ancestor, so this always
  // gets first look and can `preventDefault()` a file paste before
  // ProseMirror's own paste handling ever sees it — the same intent as the
  // old `e.preventDefault()` on the textarea's `onPaste`. ────────────────
  useEffect(() => {
    if (!editorElement) return;
    const onPasteCapture = (e: ClipboardEvent) => {
      if (disabled || lockForQuestion) return;
      const files = extractClipboardFiles(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      appendAttachedFiles(files);
    };
    editorElement.addEventListener('paste', onPasteCapture, true);
    return () => editorElement.removeEventListener('paste', onPasteCapture, true);
  }, [editorElement, disabled, lockForQuestion, appendAttachedFiles]);

  // ── Assigned item 3: Tab cycles agents, only when nothing else claimed
  // it. `mention-controller.ts` / `slash-controller.ts` already bind Tab to
  // "accept the highlighted row" WHEN a menu has rows open, via
  // ProseMirror's `handleKeyDown` plugin prop — which calls
  // `event.preventDefault()` itself before this listener (registered later,
  // same node, same bubble-phase ordering reasoning as the paste listener
  // above) ever runs. Checking `defaultPrevented` is what makes "only when
  // no suggestion menu is open" correct without this component needing any
  // channel into the menus' internal open/selected state — which
  // `composer-editor.tsx` does not expose, and modifying `composer/menus/`
  // or `composer/editor/` is out of scope for this task. This also composes
  // correctly with `ListItem`'s own Tab-to-indent keymap
  // (`@tiptap/extension-list`): inside a list item, Tab indents and is
  // marked handled, so agent-cycling steps aside there too. Escape here
  // cancels a staged command, ported from session-chat-input.tsx:924-929.
  const cycleAgent = useCallback((): boolean => {
    if (primaryAgents.length <= 1 || !onAgentChange || agentSelectorLocked) return false;
    const currentIdx = primaryAgents.findIndex((a) => a.name === selectedAgent);
    const nextIdx = (currentIdx + 1) % primaryAgents.length;
    onAgentChange(primaryAgents[nextIdx].name);
    return true;
  }, [primaryAgents, onAgentChange, agentSelectorLocked, selectedAgent]);

  useEffect(() => {
    if (!editorElement) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stagedCommand) {
        e.preventDefault();
        setStagedCommand(null);
        editorRef.current?.clear();
        return;
      }
      if (e.key === 'Tab' && !e.defaultPrevented) {
        if (cycleAgent()) e.preventDefault();
      }
    };
    editorElement.addEventListener('keydown', onKeyDown);
    return () => editorElement.removeEventListener('keydown', onKeyDown);
  }, [editorElement, stagedCommand, cycleAgent]);

  // ── Assigned item 4: make the suggestion menus' ARIA reachable. Both
  // menus (`menus/mention-menu.tsx`, `menus/slash-menu.tsx`) already render
  // `role="listbox"` + `aria-activedescendant` + a stable `aria-label`
  // ("Mention suggestions" / "Commands and actions"), portalled to
  // `document.body` — but the contenteditable itself carries neither
  // `aria-controls` nor `aria-activedescendant`, so a screen reader has no
  // way to associate the two. `composer/menus/` is closed for this task, so
  // this observes that already-shipped, stable contract from the outside
  // rather than adding a new prop-driven channel. Unverifiable without a
  // browser — see the task report.
  //
  // Fix round 1, Important — two defects in the original version of this
  // effect, both from the same root cause: the `MutationObserver` ran
  // unconditionally, for the full lifetime of EVERY mounted composer.
  // `session-chat.tsx:1506-1512` pre-mounts every open session tab at
  // once, so with N tabs open this was N permanent, document.body-wide,
  // `subtree: true` observers, each doing a full-document
  // `querySelectorAll('[role="listbox"]')` on every mutation batch
  // anywhere in the app — including every streamed-token update from every
  // OTHER tab. Work proportional to activity, exactly what this whole
  // project exists to remove, just relocated outside React where a
  // profiler won't show it. Second: all N observers would find the SAME
  // one open listbox (there can only be one open at a time) and each
  // would write `aria-controls`/`aria-activedescendant` onto ITS OWN
  // editor — so N-1 HIDDEN composers would advertise ownership of a menu
  // they do not own.
  //
  // The fix scopes observation to exactly the composer that could
  // plausibly have a menu open: a suggestion menu can only be triggered by
  // typing in a FOCUSED editor, so the body-wide observer now only runs
  // while `editorElement` itself has focus (`focusin`/`focusout` on the
  // element — both bubble, unlike `focus`/`blur`). `mention-menu.tsx` /
  // `slash-menu.tsx` rows use `onMouseDown={e => e.preventDefault()}`
  // specifically to keep the editor focused through a mouse-driven
  // selection, so this does not flicker on/off during normal menu use. An
  // explicit `document.activeElement` check on setup covers the case
  // where the effect (re)runs while the editor is already focused — e.g.
  // `editorElement` just became available (see its own doc comment) while
  // the user was already typing. Also fixes the missing-initial-sync gap
  // the review caught: starting observation now runs one reconcile pass
  // immediately, instead of waiting for the first future mutation. ───────
  useEffect(() => {
    if (!editorElement) return;

    const isSuggestionListbox = (el: Element): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.getAttribute('role') !== 'listbox') return false;
      const label = el.getAttribute('aria-label');
      return label === 'Mention suggestions' || label === 'Commands and actions';
    };

    let attached: HTMLElement | null = null;
    let attrObserver: MutationObserver | null = null;
    let bodyObserver: MutationObserver | null = null;

    const sync = () => {
      if (!attached) return;
      if (!attached.id) {
        const suffix = attached.getAttribute('aria-label') === 'Mention suggestions' ? 'mention' : 'slash';
        attached.id = `composer-suggestions-${suffix}`;
      }
      editorElement.setAttribute('aria-controls', attached.id);
      const activeId = attached.getAttribute('aria-activedescendant');
      if (activeId) editorElement.setAttribute('aria-activedescendant', activeId);
      else editorElement.removeAttribute('aria-activedescendant');
    };

    const detachListbox = () => {
      attrObserver?.disconnect();
      attrObserver = null;
      attached = null;
      editorElement.removeAttribute('aria-controls');
      editorElement.removeAttribute('aria-activedescendant');
    };

    const attachListbox = (el: HTMLElement) => {
      attached = el;
      attrObserver = new MutationObserver(sync);
      attrObserver.observe(el, { attributes: true, attributeFilter: ['aria-activedescendant'] });
      sync();
    };

    const findListbox = (): HTMLElement | null => {
      const candidates = document.body.querySelectorAll<HTMLElement>('[role="listbox"]');
      for (const el of candidates) {
        if (isSuggestionListbox(el)) return el;
      }
      return null;
    };

    const reconcile = () => {
      const found = findListbox();
      if (found && found !== attached) {
        detachListbox();
        attachListbox(found);
      } else if (!found && attached) {
        detachListbox();
      }
    };

    const startObserving = () => {
      if (bodyObserver) return;
      reconcile(); // initial sync — no waiting for the first future mutation
      bodyObserver = new MutationObserver(reconcile);
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    };

    const stopObserving = () => {
      bodyObserver?.disconnect();
      bodyObserver = null;
      detachListbox();
    };

    const onFocusIn = () => startObserving();
    const onFocusOut = () => stopObserving();

    editorElement.addEventListener('focusin', onFocusIn);
    editorElement.addEventListener('focusout', onFocusOut);

    if (document.activeElement === editorElement || editorElement.contains(document.activeElement)) {
      startObserving();
    }

    return () => {
      editorElement.removeEventListener('focusin', onFocusIn);
      editorElement.removeEventListener('focusout', onFocusOut);
      stopObserving();
    };
  }, [editorElement]);

  // ── Assigned item 1: wire useComposerFocus. `ref` needs to be a stable
  // `RefObject` whose IDENTITY changes exactly when `editorElement` does —
  // `useComposerFocus`'s own effects only re-run when `ref` itself changes,
  // not when some `.current` mutates quietly underneath a ref that never
  // changes identity — so this is a `useMemo`, not a plain `useRef`.
  const composerFocusRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({ current: editorElement }),
    [editorElement],
  );
  // Fix round 1, Important (superseded — Task 13): redirecting into a
  // NON-empty, unfocused editor and inserting via `setContent(char, 'merge')`
  // used to split the document at whatever the stale cursor position
  // happened to be (`insertContent([{type:'paragraph'}, ...])`) — real
  // corruption, not a display quirk. Round 1's fix gated the redirect on
  // `isEmpty()` and dropped the keystroke otherwise, because the handle
  // exposed no "insert inline at cursor" primitive. `insertAtCursor` (Task
  // 13, `ComposerEditorHandle`) is that primitive — it inserts literal text
  // at the CURRENT selection without moving focus to the end, exactly what
  // the old plain `<textarea>`'s `setRangeText` did. `useComposerFocus`
  // already focuses the element (via the DOM) before calling this, so
  // ProseMirror's existing selection is wherever the user's cursor actually
  // was — the empty-only gate is no longer needed.
  const handleTypeAhead = useCallback((char: string) => {
    editorRef.current?.insertAtCursor(char);
  }, []);
  useComposerFocus({
    ref: composerFocusRef,
    autoFocus,
    disabled: editorDisabled,
    onTypeAhead: handleTypeAhead,
  });

  // ── Model availability / connection gate — unchanged from
  // session-chat-input.tsx:710-740. ────────────────────────────────────────
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
  // `!isEmpty` instead of `text.trim().length > 0` — the whole point of
  // `onEmptyChange`'s boundary-only firing. A whitespace-only document
  // reads as non-empty here (ProseMirror's `isEmpty` doesn't trim), so the
  // Send button can briefly enable for whitespace-only input; `handleSubmit`
  // still trims and no-ops on submit, so this cannot send blank text — it's
  // a button-affordance quirk, not a correctness bug.
  const canSubmit = !isEmpty || attachedFiles.length > 0;
  const submitDisabled = disabled || modelUnavailable || lockForApproval;

  // ── Prefill: ported from session-chat-input.tsx:344-381. `setContent`'s
  // own `mode` already implements exactly what this needs (`replace` for a
  // starter prompt, `merge` for failed-first-turn recovery — see that
  // handle's own doc comment), so this is thinner than the original.
  //
  // Fix round 1, Critical: `editorElement` MUST be a dependency here, not
  // just the four `prefill*` values. `ComposerEditor` is lazy-loaded
  // (`ComposerEditorLazy` above) and its own `useEditor({immediatelyRender:
  // false})` doesn't finish constructing a real `Editor` until after the
  // chunk resolves — `editorRef.current` is a no-op stub for the entire
  // window in between (see `editorElement`'s own doc comment). A prefill
  // that arrives, or is already present on mount (a cold-loaded
  // failed-first-turn recovery — session-chat.tsx:3953-3958 — or the
  // rewind/"Ask for changes" hand-off, whose parent clears its store one
  // commit later on the assumption the child already consumed it —
  // session-chat.tsx:1749-1756), during that window used to be silently
  // discarded: `setContent` no-opped, and since none of the four `prefill*`
  // values necessarily change again on their own, the effect had nothing
  // left to re-run for. Watching `editorElement` is what makes the effect
  // re-fire the MOMENT the editor becomes real, with whatever prefill is
  // still current at that point. ──────────────────────────────────────────
  const prefillId = prefill?.id;
  const prefillText = prefill?.text ?? '';
  const prefillFiles = prefill?.files;
  const prefillMode = prefill?.mode;
  useEffect(() => {
    if (
      !shouldApplyPrefill({
        prefillId,
        prefillText,
        prefillFiles,
        prefillMode,
        editorReady: editorElement != null,
      })
    ) {
      return;
    }
    if (prefillMode === 'merge') {
      // Task 14, matrix row 1: `setContent(prefillText, 'merge')` appended at
      // the caret with no dedupe, which inverted the old ordering, let a
      // retry double the message, and injected blank paragraphs for a
      // files-only recovery. `planPrefillMerge` restores
      // `mergeFailedSubmissionText`'s exact three-branch contract on the
      // document (so mention atoms survive too), and returns `null` for the
      // two branches that must leave the draft untouched.
      const merged = planPrefillMerge({
        prefillDoc: textToDocument(prefillText),
        prefillIsEmpty: prefillText.length === 0,
        currentDoc: editorRef.current?.getDocument() ?? EMPTY_DOCUMENT,
        currentIsEmpty: editorRef.current?.isEmpty() ?? true,
      });
      if (merged) editorRef.current?.setDocument(merged);
    } else {
      editorRef.current?.setContent(prefillText);
    }
    if (prefillFiles?.length) {
      setAttachedFiles((current) =>
        prefillMode === 'merge'
          ? mergeFailedSubmissionFiles(current, prefillFiles)
          : [...prefillFiles],
      );
    }
    setStagedCommand(null);
    editorRef.current?.focus();
  }, [prefillId, prefillText, prefillFiles, prefillMode, editorElement]);

  // ── Question lock: save/restore the draft, ported from
  // session-chat-input.tsx:383-394.
  //
  // Task 13 fix — mention-preserving recovery: the version this replaced
  // saved `getContent().text` (a STRING) and restored it via `setContent`,
  // which flattens every mention into plain, unlinked "@label" text on the
  // way in AND has no way to turn that text back into mention atom nodes on
  // the way out. A question appearing mid-draft — @-mention a file, then a
  // question interrupts, then it resolves — used to come back with the
  // mention text still visible but its structured entry gone, so the next
  // send's `<file_ref>` block silently omitted it. Snapshotting/restoring
  // the full document (`getDocument`/`setDocument`) instead carries the
  // mention atom nodes through untouched. `isEmpty()` (not a truthy-string
  // check) decides whether there's anything worth saving, matching the old
  // code's "only restore if something was there" intent exactly.
  useEffect(() => {
    if (lockForQuestion) {
      const wasEmpty = editorRef.current?.isEmpty() ?? true;
      savedDocBeforeQuestionRef.current = wasEmpty ? null : (editorRef.current?.getDocument() ?? null);
      editorRef.current?.clear();
    } else if (savedDocBeforeQuestionRef.current) {
      setDocumentWithoutStealingFocus(editorRef.current, savedDocBeforeQuestionRef.current);
      savedDocBeforeQuestionRef.current = null;
    }
  }, [lockForQuestion]);

  /**
   * Task 14, matrix row 21. Restores `session-chat-input.tsx:1050-1052`'s
   * behaviour exactly: append at the END of the draft, separated by a single
   * SPACE, without moving focus. `setContent(text, 'merge')` did none of the
   * three — it inserted at the caret (so dictating mid-draft dropped the
   * transcript into the middle of a sentence), separated with a block
   * boundary (so `"hello transcribed"` reached the agent as
   * `"hello\n\ntranscribed"`), and force-focused the editor.
   * `setDocumentWithoutStealingFocus` is what keeps focus where the user put
   * it — the same wrapper the failed-send and question-unlock restores use,
   * and for the same reason.
   */
  const handleTranscription = useCallback((transcribedText: string) => {
    const handle = editorRef.current;
    if (!handle) return;
    const next = appendTranscribedText(
      handle.getDocument(),
      handle.isEmpty(),
      transcribedText,
    );
    setDocumentWithoutStealingFocus(handle, next);
  }, []);

  const handleSelectCommand = useCallback((cmd: Command) => {
    setStagedCommand(cmd);
    editorRef.current?.clear();
    editorRef.current?.focus();
  }, []);

  const handleSelectAction = useCallback(
    (action: SlashAction) => {
      switch (action.id) {
        case 'switch-agent':
          cycleAgent();
          return;
        case 'attach-file':
          fileInputRef.current?.click();
          return;
        case 'switch-model':
        case 'set-reasoning-effort':
        case 'set-scope':
        case 'start-voice':
          // `ModelSelector` and `VoiceRecorder` own their popover's `open`
          // state internally and accept no external open control, and both
          // files are closed to this task (model-selector.tsx is on the
          // explicit do-not-modify list; VoiceRecorder has no ref/imperative
          // surface either). Selecting one of these rows closes the `/`
          // menu and refocuses the editor (already done by
          // `slash-controller.ts`'s own `command()` before this fires) but
          // does not yet open the target control. Documented as a follow-up
          // in the task report.
          return;
        default:
          return;
      }
    },
    [cycleAgent],
  );

  // ── Submit — ported from session-chat-input.tsx:742-873, `text` replaced
  // by `editorRef.current.getContent()`. Read this whole block before
  // touching it; its tests (composer-reset.test.ts,
  // composer-draft-recovery.test.ts, message-queue-boundary.test.ts) assert
  // the pure functions it calls, unchanged. ────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (modelUnavailable) {
      toast.error(NO_MODEL_AVAILABLE_MESSAGE, {
        description: NO_MODEL_AVAILABLE_ACTION_MESSAGE,
      });
      return;
    }

    if (lockForApproval) {
      toast.error('Approve or deny the pending action to continue.');
      return;
    }

    if (stagedCommand) {
      const args = (editorRef.current?.getContent().text ?? '').trim();
      onCommand?.(stagedCommand, args || undefined);
      if (clearOnSend) {
        editorRef.current?.clear();
        setStagedCommand(null);
        setAttachedFiles((prev) => {
          for (const file of prev) {
            if (file.kind === 'local') URL.revokeObjectURL(file.localUrl);
          }
          return [];
        });
      }
      return;
    }

    if (lockForQuestion) {
      const trimmed = (editorRef.current?.getContent().text ?? '').trim();
      if (trimmed && onCustomAnswer) {
        onCustomAnswer(trimmed);
        editorRef.current?.clear();
        return;
      }
      if (onQuestionAction) {
        onQuestionAction();
        return;
      }
      return;
    }

    const content = editorRef.current?.getContent() ?? { text: '', mentions: [] };
    const trimmed = content.text.trim();
    if ((!trimmed && attachedFiles.length === 0) || submitDisabled) return;

    const filesToSend = attachedFiles.length > 0 ? [...attachedFiles] : undefined;
    const mentionsToSend = content.mentions.length > 0 ? [...content.mentions] : undefined;
    // Snapshot the actual document — not just its text — BEFORE `reset.clear`
    // below wipes it. This is what the catch block restores from on a
    // failed send; see its own comment for why a document snapshot, not a
    // string, is required to bring mentions back.
    const submittedDoc = editorRef.current?.getDocument() ?? null;
    const submittedIsEmpty = editorRef.current?.isEmpty() ?? true;

    const reset = resolveComposerResetOnSend(clearOnSend, attachedFiles);
    if (reset.clear) {
      editorRef.current?.clear();
      setAttachedFiles([]);
    }

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

    try {
      await onSend(trimmed, filesToSend, mentionsToSend);
      for (const url of reset.urlsToRevoke) URL.revokeObjectURL(url);
    } catch {
      // Task 13 fix — mention-preserving recovery, fix round 1: the decision
      // logic now lives entirely in `planFailedSendRecovery`
      // (`composer-logic.ts`), a pure function unit-tested without a DOM —
      // `handleSubmit` itself can't be (this repo's `bun test` has no DOM,
      // and this is a `React.lazy`-boundary client component). See that
      // function's own doc comment for the full "why a document snapshot,
      // not text" reasoning, and for MINOR 1's fix: a failed send must
      // restore attached files whenever `clearOnSend` is true, never nested
      // inside whatever gates the document restore — losing them in the
      // defensive null-handle case would be real data loss on a path this
      // function already tolerates a null `editorRef` for (the
      // `stagedCommand`/`lockForQuestion` branches above).
      const currentDoc = editorRef.current?.getDocument() ?? null;
      const currentIsEmpty = editorRef.current?.isEmpty() ?? true;
      const sentFiles = filesToSend ?? [];

      const plan = planFailedSendRecovery({
        clearOnSend,
        submittedDoc,
        submittedIsEmpty,
        currentDoc,
        currentIsEmpty,
        currentAttachedFiles: attachedFiles,
        sentFiles,
      });
      if (plan?.restoreDoc) {
        setDocumentWithoutStealingFocus(editorRef.current, plan.restoreDoc);
      }
      if (plan) {
        // `attachedFiles` above is whatever this `handleSubmit` closure
        // captured at CALL time — the user may have dropped in a new file
        // while the request was in flight, which only shows up through a
        // fresh functional-updater read, not the stale closure value.
        // `restoreDoc` doesn't have this problem (it's derived only from
        // `editorRef`, read imperatively, never from React state), so only
        // the files half needs re-deriving against the true latest value.
        setAttachedFiles(
          (current) =>
            planFailedSendRecovery({
              clearOnSend,
              submittedDoc,
              submittedIsEmpty,
              currentDoc,
              currentIsEmpty,
              currentAttachedFiles: current,
              sentFiles,
            })?.attachedFiles ?? current,
        );
      }
    }
  }, [
    submitDisabled,
    modelUnavailable,
    clearOnSend,
    onSend,
    isBusy,
    onQueueMessage,
    queuedMessages,
    queueInFlightId,
    onCommand,
    stagedCommand,
    attachedFiles,
    lockForQuestion,
    lockForApproval,
    onCustomAnswer,
    onQuestionAction,
  ]);

  const editorPlaceholder = resolveEditorPlaceholder({
    stagedCommand: !!stagedCommand,
    lockForApproval,
    lockForQuestion,
    questionButtonLabel,
    placeholder,
  });

  return (
    <div className="relative z-10 mx-auto w-full max-w-[52rem] shrink-0 px-2 pb-3 sm:px-4">
      <div
        ref={cardRef}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropFiles}
        className={cn(
          'bg-card border-border relative z-10 w-full rounded-xl border',
          'shadow-none transition-[border-color,box-shadow] duration-150',
          'focus-within:border-foreground/20 focus-within:shadow-sm',
          'focus-within:ring-ring focus-within:ring-2 focus-within:ring-offset-2',
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

          {/* Inline chips: thread context, todos, queue — unified spacing */}
          {(threadContext || sessionId || inputSlot || replyTo || queuedMessages?.length) && (
            <div className="mx-3 mt-2.5 flex flex-col gap-1.5 empty:hidden">
              <QueuedMessages
                messages={queuedMessages ?? EMPTY_QUEUE}
                failed={failedQueuedMessages}
                inFlightId={queueInFlightId}
                onRemove={onRemoveQueuedMessage}
                onEdit={onEditQueuedMessage}
                onReorder={onReorderQueuedMessage}
                onSendNow={onSendQueuedMessageNow}
                onRetry={onRetryQueuedMessage}
              />
              {replyTo && (
                <div className="bg-primary/5 border-primary/10 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
                  <Reply className="text-primary/60 size-3 flex-shrink-0" />
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {replyTo.text.length > 120 ? `${replyTo.text.slice(0, 120)}…` : replyTo.text}
                  </span>
                  {onClearReply && (
                    <button
                      type="button"
                      onClick={onClearReply}
                      className="text-muted-foreground hover:text-foreground flex-shrink-0 transition-colors"
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
                  <ArrowUpLeft className="text-muted-foreground size-3.5 flex-shrink-0 transition-transform group-hover:-translate-x-0.5 group-hover:-translate-y-0.5" />
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

          {/* Attached files — AttachmentTiles (assigned item 6), replacing
              the old AttachmentPreview. `attachment-preview.tsx` (along with
              `mention-popover.tsx` and `slash-command-popover.tsx`) was
              deleted in Task 13, once this component became the only live
              composer and they had no remaining reference. */}
          <AttachmentTiles files={attachedFiles} onRemove={removeAttachedFile} />

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
                    editorRef.current?.clear();
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

          <div
            className={cn(
              'flex max-h-[320px] flex-col gap-1 px-3.5 py-3',
              // Fix round 1, Minor: restores the amber placeholder emphasis
              // the old textarea overlay had for a paused connector approval
              // (session-chat-input.tsx:1233's `text-amber-600
              // dark:text-amber-400`) — a deliberate "the run is waiting on
              // you" affordance, not just muted placeholder text. Scopes the
              // color override to the placeholder pseudo-element only (see
              // globals.css's `.composer-locked-approval` rule) rather than
              // this div's own `color`, so the class can't accidentally
              // recolor the user's actual typed text.
              lockForApproval && 'composer-locked-approval',
            )}
          >
            <Suspense fallback={<ComposerEditorFallback />}>
              <ComposerEditorLazy
                ref={setEditorRef}
                placeholder={editorPlaceholder}
                disabled={editorDisabled}
                onSubmit={handleSubmit}
                onEmptyChange={setIsEmpty}
                agents={agents}
                sessions={allSessions ?? []}
                currentSessionId={sessionId}
                commands={stagedCommand ? EMPTY_COMMANDS : commands}
                actions={stagedCommand ? EMPTY_ACTIONS : undefined}
                onSelectCommand={handleSelectCommand}
                onSelectAction={handleSelectAction}
              />
            </Suspense>
          </div>

          {/* Bottom toolbar — hidden file input stays here since it needs
              appendAttachedFiles/disabled/lockForQuestion from this
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
            onAttachClick={handleAttachClick}
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
            hasText={!isEmpty}
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
 * Memoized so the input subtree doesn't re-render on every streaming token —
 * same reasoning, same shape as `SessionChatInput`'s own `memo()` wrap in
 * `session-chat-input.tsx`. Once Task 13 wires this in, the parent must keep
 * handing this stable (`useCallback`/`useMemo`) props for the memo to help
 * at all.
 */
export const Composer = memo(ComposerImpl);
