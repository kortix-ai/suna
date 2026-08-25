'use client';

import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { isImageFile } from '@/lib/utils/file-utils';
import type { Agent, Command, MessageWithParts, ProviderListResponse } from '@kortix/sdk/react';
import { useRuntimeSessions } from '@kortix/sdk/react';
import {
  ArrowBendDoubleUpLeftIcon,
  ArrowUpLeftIcon as ArrowUpLeft,
  WarningIcon,
} from '@phosphor-icons/react';
import type { JSONContent } from '@tiptap/core';
import { useTranslations } from 'next-intl';
import type { RefObject } from 'react';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { extractClipboardFiles } from '../clipboard-files';
import { mergeFailedSubmissionFiles } from '../composer-draft-recovery';
import { resolveComposerResetOnSend } from '../composer-reset';
import {
  isModelRequiredButUnavailable,
  NO_MODEL_AVAILABLE_ACTION_MESSAGE,
  NO_MODEL_AVAILABLE_MESSAGE,
  resolveAvailableSelectedModel,
} from '../model-availability';
import { ModelConnectionBar } from '../model-connection-gate';
import type { FlatModel } from '../model-flatten';
import { type ModelDefaultControls } from '../model-selector';
import { useModelConnectionGate } from '../use-model-connection-gate';
import { NO_AGENT_ACCESS_HINT, NO_AGENT_ACCESS_LABEL } from './composer-agent-access';
import type { DraftScope, StoredDraft } from './draft/composer-draft';
import { useComposerDraft } from './draft/use-composer-draft';
import { commandBlocker, sendBlocker, sendBlockerMessage } from './send-blockers';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Close } from '@/features/icon/icons/close';
import { AnimatedComposerPlaceholder } from './animated-placeholder';
import { AttachmentTiles } from './attachment-tiles';
import {
  draftWillRunCommand,
  planCommandAttachments,
  readCommandChipLabel,
} from './command-attachments';
import {
  planDraftSubmission,
  planFailedSendRecovery,
  planPrefillMerge,
  resolveEditorPlaceholder,
  shouldApplyPrefill,
  shouldFocusEditorFromPadding,
  textToDocument,
} from './composer-logic';
import { ComposerToolbar } from './composer-toolbar';
import { ComposerUnderbar } from './composer-underbar';
import type { ComposerEditorHandle } from './editor/composer-editor';
import { useComposerFocus } from './hooks/use-composer-focus';
import { useMenuRevalidation } from './hooks/use-file-search';
import { type ContextUsage, getContextUsage } from './context-ring';
import { controlToOpenFor, SLASH_ACTIONS, type SlashAction } from './menus/slash-actions';
import type { SlashFile } from './menus/slash-files';
import { createSubmitLatch } from './submit-latch';
import type { AttachedFile, TrackedMention } from './types';

/** A draft captured out of the editor at Enter time — see `createSubmitLatch`. */
interface StashedDraft {
  content: ReturnType<ComposerEditorHandle['getContent']>;
  doc: JSONContent | null;
  files: AttachedFile[];
}

export interface SessionChatInputProps {
  onSend: (
    text: string,
    files?: AttachedFile[],
    mentions?: TrackedMention[],
  ) => void | Promise<void>;
  isBusy?: boolean;
  /**
   * The session is working, per the ONE projection (`useSessionWorking`).
   *
   * Distinct from `isBusy`, which is a 300 ms fade timer for the busy
   * indicator: this is the server's own turn authority, and it is what decides
   * whether a `/` command may be dispatched at all. Defaults to `isBusy` so a
   * host that has not wired it still refuses a command mid-turn — the safe
   * direction — rather than silently allowing one.
   */
  sessionWorking?: boolean;
  /**
   * The sandbox is up and this session is switched onto it (`useRuntimeReady`).
   *
   * Read by the `/` COMMAND path only. A prompt does not need it — it becomes a
   * durable inbox row and the drain delivers it once the box answers, which is
   * what the "Waking this session up…" notice promises. A command has no row:
   * `runCommand` returns a resolved promise when the runtime is not switched,
   * so dispatching one at a sleeping box cleared the draft and left an
   * optimistic bubble waiting on a turn that never starts.
   *
   * Defaults to `true` so a host that shows a composer without a runtime
   * concept (project home) is unaffected; `session-chat.tsx` passes the real
   * value.
   */
  runtimeReady?: boolean;
  onStop?: () => void;
  stopDisabled?: boolean;
  isSending?: boolean;
  /**
   * The session sits on a rewound path: sending commits it, restoring keeps
   * the removed messages and file changes. Renders a compact Restore control
   * beside send/stop — the moment of commitment — instead of a banner above
   * the card.
   */
  rewind?: { pending?: boolean; disabled?: boolean; onRestore: () => void };
  agents?: Agent[];
  selectedAgent?: string | null;
  onAgentChange?: (agentName: string | null | undefined) => void;
  agentSelectorLocked?: boolean;
  /**
   * The agent roster loaded and it is EMPTY for this user — project agents are
   * deny-by-default for a member without an explicit grant.
   *
   * Set it and the composer refuses the submission instead of POSTing a prompt
   * the server answers with a 403 (or, worse, silently runs under the manifest
   * `default_agent` nobody picked). The picker beside the send button renders
   * the same refusal in words. Hosts that have no agent concept at all leave it
   * `false` — an absent roster is not a denied one. See
   * `composer-agent-access.ts`.
   */
  noAccessibleAgents?: boolean;
  commands?: Command[];
  /**
   * The session's own files, as `/` palette rows — the Outputs card's
   * deliverables and the Context card's reads, built by
   * `menus/slash-files.ts`'s `sessionSlashFiles`.
   *
   * A prop, not a `useOptionalSessionPanel()` call inside this component,
   * even though the panel provider does sit above every session composer.
   * Importing that provider here would pull the entire detail-panel tree
   * (files explorer, audit panel, previews) into this module's graph — and
   * this composer also renders on project home and in the marketing demo,
   * neither of which has any use for it. The host that already lives beside
   * the panel (`session-chat.tsx`) reads the context and hands the derived
   * list down; every other host omits it.
   */
  slashFiles?: SlashFile[];
  /**
   * `split` is where the chip sat in `args` — display only. Without it every
   * consumer rebuilds the sent message as `/name` + args, so a command typed
   * mid-sentence (`explain /webapp to me`) came back reordered to the front.
   */
  onCommand?: (command: Command, args?: string, split?: { before: string; after: string }) => void;
  models?: FlatModel[];
  selectedModel?: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  modelDefaultControls?: ModelDefaultControls;
  variants?: string[];
  selectedVariant?: string | null;
  onVariantChange?: (variant: string | null | undefined) => void;
  messages?: MessageWithParts[];
  sessionId?: string;
  projectId?: string;
  /**
   * Persist the unsent draft under this scope and restore it on the next
   * mount — see `composer/draft/`. Project scope for the home hero composer
   * (no session yet), session scope for every in-thread one.
   *
   * Omitted → the composer persists nothing, which is what the two
   * marketing-demo composers rely on.
   */
  draftScope?: DraftScope | null;
  disabled?: boolean;
  /**
   * A line shown in a bar directly ABOVE the composer card. Used for "this
   * session is still waking" — a state that used to disable the input and show
   * a spinner with no explanation, which was indistinguishable from broken.
   */
  notice?: string | null;
  /**
   * Renders a "Retry" action inline in the notice bar when set. Wired to
   * `requestRuntimeReconnect()` for a confirmed-unreachable runtime, or a
   * runtime that has been booting/connecting past a sane ceiling with no
   * ready flip either — see `SessionComposerReadiness.retryable`. Omitted (no
   * button) for the ordinary, still-within-budget booting/waking notice,
   * where the background poller is expected to resolve things on its own
   * shortly.
   */
  onNoticeRetry?: () => void;
  clearOnSend?: boolean;
  modelRequired?: boolean;
  modelsLoading?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  prefill?: {
    text: string;
    id: number;
    files?: AttachedFile[];
    mode?: 'replace' | 'merge';
  } | null;
  /**
   * Called with `prefill.id` the moment that prefill has actually landed in the
   * editor — the CONSUME half of the handoff.
   *
   * A prefill can only be applied once the lazy editor exists, which is one or
   * more commits after the composer mounts. A holder that clears its draft in
   * its own mount effect therefore clears it BEFORE this composer could read
   * it, and the text is lost — with the effect running child-before-parent
   * making it look correct in the case where the editor happens to be ready.
   * So the holder waits to be told, rather than assuming.
   */
  onPrefillApplied?: (prefillId: number) => void;
  /**
   * A fresh (never-before-seen) value asks the composer to open its attach
   * (file-picker) flow — the empty Context card's "Add context" button.
   * Id-keyed exactly like `prefill.id`: a repeat request bumps to a new id
   * so the effect below fires again even if the composer never unmounted.
   */
  attachRequestId?: number | null;

  providers?: ProviderListResponse;
  threadContext?: {
    parentTitle: string;
    onBackToParent: () => void;
  };

  onContextClick?: () => void;
  /**
   * Open the host's Compact-session modal. Also gates the `/` palette's
   * "Compact session" row — absent handler, absent row, so the palette never
   * offers an action that would do nothing (see the `set-scope` note in
   * `menus/slash-actions.ts`). Same contract for `onContextClick` and the
   * "Show context" row.
   */
  onCompactClick?: () => void;
  inputSlot?: React.ReactNode;

  toolbarSlot?: React.ReactNode;
  /**
   * Where the under-row's controls live — attach, the agent picker and the
   * context ring.
   *
   * `'below'` (default) keeps them as their own row beneath the card, which is
   * the session page: the card holds the message, the row beneath holds what
   * you bring to it and what it costs.
   *
   * `'inline'` folds them into the toolbar instead, ahead of the model
   * selector. Project Home is a HERO composer floating in the middle of an
   * empty page — a second rail hanging under it has no column to align to and
   * reads as a detached strip, so there the controls belong on the one bar.
   */
  underbarPlacement?: 'below' | 'inline';

  /**
   * Where the `/` menu docks relative to the card. `'above'` (default) keeps
   * it in flow above the composer — on the session page the card sits at the
   * viewport bottom, so above is the only side with room, and pushing the
   * card down is invisible there.
   *
   * `'below'` absolutely positions the dock under the card instead. Project
   * Home is a HERO composer in the middle of the page: docking above would
   * shove the centered heading up on every keystroke that filters the list,
   * while below has the whole empty lower half of the page to paint over.
   * Absolute — not in flow — so opening the menu never reflows the hero or
   * the starter chips beneath it.
   */
  slashMenuPlacement?: 'above' | 'below';

  cardClassName?: string;

  replyTo?: { text: string } | null;
  onClearReply?: () => void;
  lockForQuestion?: boolean;
  lockForApproval?: boolean;
  onCustomAnswer?: (text: string) => void;
  questionButtonLabel?: string | null;
  questionCanAct?: boolean;
  onQuestionAction?: () => void;
  escCount?: number;
  parentClassName?: string;
}

/**
 * The composer's outer shell — max width, centering, and the horizontal gutter
 * everything in the composer (notice bar, reply bar, card, under-row, model
 * connection bar) is measured from.
 *
 * The BASE gutter is `px-4` and it carries no breakpoint, deliberately. This
 * was `px-2 sm:px-0`, and `sm:` is a VIEWPORT query answering a CONTAINER
 * question. This element's width is set by the session layout — sidebar,
 * action-panel column, and the browser/terminal/files detail panel — never by
 * the window:
 *
 *  - Action panel or a detail tab open on a 1512px screen: the viewport is
 *    still ≥640px, so `sm:px-0` zeroed the gutter while the chat column was
 *    only ~600px wide. The column is narrower than `max-w-210`, so `mx-auto`
 *    has no slack to donate and the card sat flush against the panel divider.
 *  - Everything closed: the column grows past `max-w-210`, `mx-auto` produces
 *    slack on both sides, and the gutter appears to "work" again.
 *
 * Same class, opposite result, decided by a query that cannot see the panel —
 * which is exactly the "sometimes there's padding, sometimes there isn't" bug.
 * A constant gutter is correct in all of them: when the column is wide the
 * 16px is invisible inside the centering slack, and when it is narrow it is
 * the only thing keeping the card off the edge.
 *
 * 16px is not arbitrary — it is the transcript's own gutter (`session-chat.tsx`:
 * `mx-auto w-full max-w-3xl min-w-0 px-4 pt-6`). Whenever the column is
 * narrower than either max-width — every panel-open case — the card's edges
 * land on exactly the same rails as the messages above it.
 *
 * `md:pr-1` is Jay's optical trim and is NOT the old bug returning — do not
 * "clean it up". It trims the RIGHT gutter to 4px from `md` up because on
 * desktop the chat column already ends in the action-panel column's chevron
 * rail (`session-action-panel-column.tsx`: `gap-2` + a `size-7` button + `mr-1`
 * when collapsed, ~40px), so a full 16px on top of that read as a composer
 * pushed left. The distinction that matters: a breakpoint may TRIM this gutter,
 * it may never ZERO it — zero is what let the card touch the panel divider, and
 * `composer-underbar.test.tsx` guards exactly that line.
 *
 * Known limit of the trim, left as-is on purpose: the chevron rail it
 * compensates for is not always there. The panel column is `hidden` while a
 * detail panel (browser, terminal, files, preview) is up, and it never mounts
 * on project-home / instant-session-shell. In those states the right gutter is
 * 4px against a 16px left. Worth a look if the composer ever reads
 * right-shifted with a browser tab open; harmless otherwise.
 *
 * Beyond that trim, do not add breakpoints. If this needs to respond to width,
 * it has to be a container query on the chat column, not a media query — the
 * media query cannot see the panel, which is the whole reason it broke before.
 */
export const COMPOSER_SHELL_CLASS = 'relative z-10 mx-auto w-full max-w-210 shrink-0 px-4 md:pr-1';

/**
 * The inset strip above the card that hosts `inputSlot` — the approval notice,
 * the permission notice, and `QuestionPrompt`.
 *
 * `items-center` is load-bearing and it BITES: a flex column sizes each child
 * to its content unless the child says otherwise, so anything mounted here that
 * omits `w-full` renders as a narrow box floating in the middle of the strip,
 * with a width that tracks whatever text happens to be inside it. Exported so
 * the invariant is pinned by a test (composer-input-slot.test.tsx) rather than
 * rediscovered by the next notice that gets added.
 */
export const COMPOSER_INPUT_SLOT_CLASS =
  'bg-sidebar border-border flex w-[96%] flex-col items-center gap-2 rounded-t-xl border border-b-0 p-1 empty:hidden';

/** Stable empty defaults so a fresh `[]` per render never breaks memoization. */
const EMPTY_AGENTS: Agent[] = [];
const EMPTY_COMMANDS: Command[] = [];
const EMPTY_MODELS: FlatModel[] = [];
const EMPTY_VARIANTS: string[] = [];
const EMPTY_SLASH_FILES: SlashFile[] = [];

/** Stable identities for the command-chip subscription below. */
const NO_SUBSCRIPTION = () => {};
const NO_COMMAND_CHIP = () => null;

const EMPTY_DOCUMENT = textToDocument('');

const ComposerEditorLazy = lazy(() =>
  import('./editor/composer-editor').then((mod) => ({ default: mod.ComposerEditor })),
);

function ComposerEditorFallback() {
  return <div className="min-h-[1.5em]" aria-hidden />;
}

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
  sessionWorking,
  runtimeReady = true,
  onStop,
  stopDisabled = false,
  isSending = false,
  rewind,
  agents = EMPTY_AGENTS,
  selectedAgent = null,
  onAgentChange,
  agentSelectorLocked = false,
  noAccessibleAgents = false,
  commands = EMPTY_COMMANDS,
  slashFiles = EMPTY_SLASH_FILES,
  onCommand,
  models = EMPTY_MODELS,
  selectedModel = null,
  onModelChange,
  modelDefaultControls,
  variants = EMPTY_VARIANTS,
  selectedVariant = null,
  onVariantChange,
  messages,
  sessionId,
  projectId,
  draftScope = null,
  disabled = false,
  notice = null,
  onNoticeRetry,
  clearOnSend = true,
  modelRequired = false,
  modelsLoading = false,
  autoFocus,
  placeholder = 'Ask anything…',
  prefill = null,
  onPrefillApplied,
  attachRequestId = null,
  providers,
  threadContext,
  onContextClick,
  onCompactClick,
  inputSlot,
  toolbarSlot,
  underbarPlacement = 'below',
  slashMenuPlacement = 'above',
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
  parentClassName,
}: SessionChatInputProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const dockId = `composer-slash-dock-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  // Synchronous mirror of `attachedFiles`, for the one reader that cannot
  // wait for a React flush: the submit latch's stash (see `handleSubmit`).
  const attachedFilesRef = useRef<AttachedFile[]>([]);
  useEffect(() => {
    attachedFilesRef.current = attachedFiles;
  }, [attachedFiles]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useMenuRevalidation(menuOpen, projectId);

  const cardRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const savedDocBeforeQuestionRef = useRef<JSONContent | null>(null);

  const editorRef = useRef<ComposerEditorHandle | null>(null);
  const [editorElement, setEditorElement] = useState<HTMLElement | null>(null);
  const setEditorRef = useCallback((handle: ComposerEditorHandle | null) => {
    editorRef.current = handle;
    setEditorElement(handle?.getElement() ?? null);
  }, []);

  /**
   * Put a stored draft back into the live editor.
   *
   * `setDocumentWithoutStealingFocus`, not `setDocument`: this fires on mount,
   * and `setDocument` force-focuses the document end — a session page would
   * yank focus into the composer on every reload.
   *
   * Attachments are only seeded into an EMPTY tray. Anything already attached
   * was added by the person in this mount and outranks a stored list. Local
   * attachments were never storable, so nothing is restored for them.
   */
  const handleDraftRestore = useCallback((draft: StoredDraft) => {
    setDocumentWithoutStealingFocus(editorRef.current, draft.doc);
    if (draft.files.length > 0) {
      setAttachedFiles((current) => (current.length > 0 ? current : [...draft.files]));
    }
  }, []);

  const { handleDocChange, clearSavedDraft } = useComposerDraft({
    scope: draftScope,
    editorRef,
    editorReady: editorElement != null,
    attachedFiles,
    hasPrefill: !!prefill,
    onRestore: handleDraftRestore,
  });

  const { data: allSessions } = useRuntimeSessions();

  const primaryAgents = useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent'),
    [agents],
  );

  const editorDisabled = disabled || lockForApproval;
  const inlineUnderbar = underbarPlacement === 'inline';

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

  // "Add context" (Task 5): a fresh `attachRequestId` opens the same file
  // picker `handleAttachClick` opens for a manual click or the `/attach-file`
  // command — see `session-composer-prefill-store.ts` for the held/id-keyed
  // handoff this consumes.
  useEffect(() => {
    if (attachRequestId == null) return;
    handleAttachClick();
  }, [attachRequestId, handleAttachClick]);

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

  /**
   * Whether the draft carries a `/` command chip — the other half of the
   * attachment guard in `command-attachments.ts`.
   *
   * Watched ONLY while something is attached, because that is the only state
   * in which the answer changes anything. With no attachments nothing is
   * observed and nothing is read, so ordinary typing costs what it did before.
   *
   * A `MutationObserver` rather than an editor callback: `onEmptyChange` fires
   * on the empty↔non-empty boundary only (`trackEmptyBoundary`), so it never
   * sees a chip inserted into a draft that already has text — and adding a new
   * prop to `ComposerEditor` would reach outside this change. The chip is an
   * atom node with a stable `data-mention` attribute, and the selector is
   * pinned to `MentionNode`'s real rendered output by a test.
   *
   * Both orders are covered: attach-then-type is caught by the observer, and
   * type-then-attach by the snapshot React reads when the subscription changes
   * on the first attachment.
   *
   * `useSyncExternalStore`, not `useState` + an effect: the editor's DOM is
   * literally an external store here, and reading it in an effect would render
   * once with a stale answer and again with the real one.
   */
  const hasAttachments = attachedFiles.length > 0;
  const subscribeToCommandChip = useCallback(
    (onChange: () => void) => {
      if (!editorElement || !hasAttachments) return NO_SUBSCRIPTION;
      const observer = new MutationObserver(onChange);
      observer.observe(editorElement, { childList: true, subtree: true });
      return () => observer.disconnect();
    },
    [editorElement, hasAttachments],
  );
  // A string or null, so the snapshot is stable by value and cannot loop.
  const readChipSnapshot = useCallback(
    () => (hasAttachments ? readCommandChipLabel(editorElement) : null),
    [editorElement, hasAttachments],
  );
  const draftCommandChipLabel = useSyncExternalStore(
    subscribeToCommandChip,
    readChipSnapshot,
    NO_COMMAND_CHIP,
  );

  const cycleAgent = useCallback((): boolean => {
    if (primaryAgents.length <= 1 || !onAgentChange || agentSelectorLocked) return false;
    const currentIdx = primaryAgents.findIndex((a) => a.name === selectedAgent);
    const nextIdx = (currentIdx + 1) % primaryAgents.length;
    onAgentChange(primaryAgents[nextIdx].name);
    return true;
  }, [primaryAgents, onAgentChange, agentSelectorLocked, selectedAgent]);

  // Escape no longer has a staged command to cancel: the command is a chip in
  // the document, so Backspace removes it — one keystroke, at the caret, with
  // undo — and there is no mode left for Escape to exit. Escape is left
  // entirely to `@tiptap/suggestion`, which uses it to dismiss an open menu.
  useEffect(() => {
    if (!editorElement) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !e.defaultPrevented) {
        if (cycleAgent()) e.preventDefault();
      }
    };
    editorElement.addEventListener('keydown', onKeyDown);
    return () => editorElement.removeEventListener('keydown', onKeyDown);
  }, [editorElement, cycleAgent]);

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
        const suffix =
          attached.getAttribute('aria-label') === 'Mention suggestions' ? 'mention' : 'slash';
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

    if (
      document.activeElement === editorElement ||
      editorElement.contains(document.activeElement)
    ) {
      startObserving();
    }

    return () => {
      editorElement.removeEventListener('focusin', onFocusIn);
      editorElement.removeEventListener('focusout', onFocusOut);
      stopObserving();
    };
  }, [editorElement]);

  const composerFocusRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({ current: editorElement }),
    [editorElement],
  );
  const handleTypeAhead = useCallback((char: string) => {
    editorRef.current?.insertAtCursor(char);
  }, []);
  useComposerFocus({
    ref: composerFocusRef,
    autoFocus,
    disabled: editorDisabled,
    onTypeAhead: handleTypeAhead,
  });

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
  const canSubmit = !isEmpty || attachedFiles.length > 0;
  /**
   * No agent may run this prompt. Refused here rather than at the server:
   * `lockForQuestion` is exempt because answering an open question is not a new
   * prompt and runs under the agent that asked it.
   */
  const agentUnavailable = noAccessibleAgents && !lockForQuestion;
  const submitDisabled = disabled || modelUnavailable || agentUnavailable || lockForApproval;
  /**
   * A `/` command cannot carry the attached files, so this state refuses the
   * submit and says why — before anything is sent and before anything is
   * cleared. See `command-attachments.ts` for why carrying them is not
   * reachable from here.
   *
   * Kept out of `submitDisabled` on purpose: that value also gates the voice
   * recorder, and dictation is one of the ways out of this state.
   */
  const commandAttachmentPlan = planCommandAttachments({
    isCommand: draftWillRunCommand(draftCommandChipLabel, commands),
    attachmentCount: attachedFiles.length,
  });

  const prefillId = prefill?.id;
  const prefillText = prefill?.text ?? '';
  const prefillFiles = prefill?.files;
  const prefillMode = prefill?.mode;
  const onPrefillAppliedRef = useRef(onPrefillApplied);
  useEffect(() => {
    onPrefillAppliedRef.current = onPrefillApplied;
  }, [onPrefillApplied]);
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
    editorRef.current?.focus();
    // Reported AFTER the text is in the editor, in the same statement run — a
    // holder that clears on this signal cannot clear a draft that has not
    // landed. `prefillId` is non-undefined here: `shouldApplyPrefill` returned
    // true, which requires it.
    //
    // Through a ref, deliberately: this callback in the dependency array would
    // re-run the effect whenever the caller re-created it, and a `merge` prefill
    // applied twice appends its text twice.
    onPrefillAppliedRef.current?.(prefillId as number);
  }, [prefillId, prefillText, prefillFiles, prefillMode, editorElement]);

  useEffect(() => {
    if (lockForQuestion) {
      const wasEmpty = editorRef.current?.isEmpty() ?? true;
      savedDocBeforeQuestionRef.current = wasEmpty
        ? null
        : (editorRef.current?.getDocument() ?? null);
      editorRef.current?.clear();
    } else if (savedDocBeforeQuestionRef.current) {
      setDocumentWithoutStealingFocus(editorRef.current, savedDocBeforeQuestionRef.current);
      savedDocBeforeQuestionRef.current = null;
    }
  }, [lockForQuestion]);

  /**
   * The model popover's open state, hoisted out of `ModelSelector` so the `/`
   * palette can open it. `focusSection` is what separates the palette's two
   * model-related rows: reasoning effort is a footer row INSIDE this popover
   * rather than a control of its own (see `model-selector.tsx`), so both rows
   * open the same element and only the landing point differs.
   */
  /**
   * Open state for the two toolbar controls the `/` palette can reach.
   * Hoisted out of the controls themselves so a palette row can open them;
   * both stay uncontrolled for every other consumer.
   *
   * Two separate flags, not one with a "which section" discriminator: model
   * and reasoning effort are now two distinct dropdowns, so a single flag
   * would open both or neither.
   */
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);

  /**
   * `SLASH_ACTIONS` with the live agent name filled into the "Switch agent"
   * row, so the palette shows what you are switching FROM without opening
   * anything. The static list cannot know it; this component holds
   * `selectedAgent`, so the derivation belongs here.
   *
   * Memoized on `selectedAgent` alone. The `/` menu reads this through a ref
   * at open time (`composer-editor.tsx`'s `actionsRef`), so identity churn
   * would not produce a wrong menu — but `ComposerEditorLazy` is memoized on
   * its props, and a fresh array every render would defeat that on every
   * keystroke.
   */
  /**
   * The live context-window snapshot behind the "Show context" row — the ring
   * icon reads percent + tone, the palette's detail pane renders the full
   * `ContextUsageCard` from the rest. Two memos on purpose: `messages`
   * changes identity on every streamed token, so the derivation re-runs
   * cheaply — but the OBJECT is pinned to its scalar fields, which change
   * only when a turn completes and reports usage. Without the pin, every
   * token would ripple through `slashActions` into the memoized editor.
   */
  const rawContextUsage = useMemo(
    () => getContextUsage(messages, models, availableSelectedModel),
    [messages, models, availableSelectedModel],
  );
  const contextUsage = useMemo<ContextUsage>(
    () => ({
      percent: rawContextUsage.percent,
      tone: rawContextUsage.tone,
      ratio: rawContextUsage.ratio,
      limit: rawContextUsage.limit,
      modelName: rawContextUsage.modelName,
      breakdown: rawContextUsage.breakdown,
    }),
    // Deliberately keyed on the leaf scalars, not the objects: `breakdown` is
    // rebuilt every derivation, so its identity would defeat the pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      rawContextUsage.percent,
      rawContextUsage.tone,
      rawContextUsage.ratio,
      rawContextUsage.limit,
      rawContextUsage.modelName,
      rawContextUsage.breakdown.input,
      rawContextUsage.breakdown.output,
      rawContextUsage.breakdown.reasoning,
      rawContextUsage.breakdown.cache,
      rawContextUsage.breakdown.total,
    ],
  );

  const slashActions = useMemo(() => {
    // Rows whose handler this host did not provide are dropped, not shown
    // dead — the `set-scope` lesson in `slash-actions.ts`: a row that
    // highlights, offers "Use", and does nothing is worse than no row.
    const available = SLASH_ACTIONS.filter((action) => {
      if (action.id === 'compact-session') return Boolean(onCompactClick);
      if (action.id === 'show-context') return Boolean(onContextClick);
      return true;
    });
    return available.map((action) => {
      if (action.id === 'switch-agent' && selectedAgent) {
        return { ...action, value: selectedAgent };
      }
      // The ring icon (via `context`) plus the reading as the row's
      // "current setting" text — same grammar as the agent row's value.
      if (action.id === 'show-context') {
        return { ...action, value: `${contextUsage.percent}%`, context: contextUsage };
      }
      return action;
    });
  }, [selectedAgent, onCompactClick, onContextClick, contextUsage]);

  const handleSelectAction = useCallback(
    (action: SlashAction) => {
      // Which control a row opens lives in `controlToOpenFor`
      // (menus/slash-actions.ts) so it can be tested; this file cannot be.
      const control = controlToOpenFor(action.id);
      if (control === 'model') {
        setModelMenuOpen(true);
        return;
      }
      if (control === 'reasoning') {
        setReasoningMenuOpen(true);
        return;
      }

      switch (action.id) {
        case 'switch-agent':
          cycleAgent();
          return;
        case 'attach-file':
          fileInputRef.current?.click();
          return;
        case 'compact-session':
          onCompactClick?.();
          return;
        case 'show-context':
          onContextClick?.();
          return;
      }
    },
    [cycleAgent, onCompactClick, onContextClick],
  );

  const dispatchSubmission = useCallback(
    async (stash?: StashedDraft) => {
      // Ahead of the model check: with no agent to run it, the model this prompt
      // would have used is not the user's problem.
      if (agentUnavailable) {
        errorToast(NO_AGENT_ACCESS_LABEL, { description: NO_AGENT_ACCESS_HINT });
        return;
      }
      if (modelUnavailable) {
        errorToast(NO_MODEL_AVAILABLE_MESSAGE, {
          description: NO_MODEL_AVAILABLE_ACTION_MESSAGE,
        });
        return;
      }

      // What refuses EVERY submission — a prompt, a `/` command, and a custom
      // answer alike. `hasActiveQuestion` is deliberately not consulted here: an
      // open question does not refuse a submission, it REROUTES it to
      // `onCustomAnswer` further down. The command branch passes it for real,
      // because a command is not an answer.
      const submissionBlocker = sendBlocker({
        hasActiveQuestion: false,
        // The composer only knows "something is pending", not how many.
        pendingPermissionCount: lockForApproval ? 1 : 0,
        readOnly: disabled,
      });
      if (submissionBlocker) {
        const copy = sendBlockerMessage(submissionBlocker);
        errorToast(copy.message, copy.description ? { description: copy.description } : undefined);
        return;
      }

      // A stashed draft was captured out of the editor (and the editor cleared)
      // when its Enter arrived mid-send — see `createSubmitLatch`. It is
      // submitted as captured; the live editor belongs to whatever the user
      // typed since.
      const draft = stash ? stash.content : editorRef.current?.getContent();
      const filesNow = stash ? stash.files : attachedFiles;
      const plan = planDraftSubmission({
        commandName: draft?.commandName,
        text: draft?.text ?? '',
        commands: commands ?? [],
      });
      if (plan.kind === 'command') {
        // A command cannot deliver the attached files, and the code below is
        // about to clear them and revoke their object URLs. Refuse the whole
        // submission instead — before either dispatch path and before the clear,
        // so the direct call and the queued entry are guarded by one check
        // rather than two that can drift. Nothing is sent, nothing is cleared,
        // and the reason is already on screen next to the send button; the toast
        // covers the keyboard path, which no disabled button can gate.
        const guard = planCommandAttachments({
          isCommand: true,
          attachmentCount: filesNow.length,
        });
        if (guard.kind === 'refuse') {
          errorToast(guard.message, { description: guard.description });
          return;
        }

        // A command is REFUSED while the session is working — or while its
        // sandbox is still waking — not queued.
        //
        // A PROMPT is never held here: it goes to the server-side inbox, which
        // admits it only when the session can take it, so ordering is decided by
        // server truth rather than by this component's read of `isBusy`, and a
        // sleeping box just means the row is delivered a little later. A COMMAND
        // has no such row — it is dispatched by `runCommand`, never by
        // `POST .../prompts` — so no admission gate ever sees it, putting one on
        // the wire mid-turn aborts the answer in progress, and dispatching one at
        // a box that is not up is swallowed by `runCommand`'s own
        // `runtimeActionReady` guard with no request and no error.
        //
        // It used to wait in a browser-local queue for that reason. That queue is
        // gone: it lived in this tab's localStorage, so a closed tab lost it, a
        // second tab could not see it, and its release timing was a guess at a
        // turn boundary made from a debounced `isBusy`. A refusal keeps the draft
        // in the editor and says when the command can run — nothing is stored,
        // and nothing can be lost.
        const blocker = commandBlocker({
          hasActiveQuestion: lockForQuestion,
          // The composer only knows "something is pending", not how many.
          pendingPermissionCount: lockForApproval ? 1 : 0,
          readOnly: disabled,
          isWorking: sessionWorking ?? isBusy,
          runtimeReady,
        });
        if (blocker) {
          const copy = sendBlockerMessage(blocker);
          errorToast(
            copy.message,
            copy.description ? { description: copy.description } : undefined,
          );
          return;
        }
        onCommand?.(plan.command, plan.args, draft?.commandSplit);
        // The command is on its way; the draft that produced it is spent.
        // Deliberately NOT on either refusal path above (`guard.kind ===
        // 'refuse'`, `blocker`) — those keep the text in the editor on
        // purpose, so its draft has to survive with it.
        clearSavedDraft();
        if (clearOnSend && !stash) {
          editorRef.current?.clear();
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
        const trimmed = (draft?.text ?? '').trim();
        if (trimmed && onCustomAnswer) {
          onCustomAnswer(trimmed);
          if (!stash) editorRef.current?.clear();
          return;
        }
        if (onQuestionAction) {
          onQuestionAction();
          return;
        }
        return;
      }

      const content = draft ?? { text: '', mentions: [] };
      const trimmed = plan.text;
      if ((!trimmed && filesNow.length === 0) || submitDisabled) return;

      const filesToSend = filesNow.length > 0 ? [...filesNow] : undefined;
      const mentionsToSend = content.mentions.length > 0 ? [...content.mentions] : undefined;
      const submittedDoc = stash ? stash.doc : (editorRef.current?.getDocument() ?? null);
      const submittedIsEmpty = stash ? false : (editorRef.current?.isEmpty() ?? true);

      const reset = resolveComposerResetOnSend(clearOnSend, filesNow);
      if (reset.clear && !stash) {
        editorRef.current?.clear();
        attachedFilesRef.current = [];
        setAttachedFiles([]);
      }

      try {
        await onSend(trimmed, filesToSend, mentionsToSend);
        for (const url of reset.urlsToRevoke) URL.revokeObjectURL(url);
        // AFTER the await, so a send that throws keeps its draft. Explicit,
        // NOT derived from `reset.clear`: the project-home composer passes
        // `clearOnSend={false}` because its send navigates it away
        // (`composer-reset.ts`), so keying this off the editor clearing would
        // strand a stale home draft forever. The catch below puts the text
        // back in the editor, which re-saves the draft through the ordinary
        // debounce — nothing to restore by hand.
        clearSavedDraft();
      } catch {
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
    },
    [
      submitDisabled,
      modelUnavailable,
      agentUnavailable,
      clearOnSend,
      onSend,
      isBusy,
      sessionWorking,
      runtimeReady,
      disabled,
      onCommand,
      commands,
      attachedFiles,
      lockForQuestion,
      lockForApproval,
      onCustomAnswer,
      onQuestionAction,
      clearSavedDraft,
    ],
  );

  /**
   * One user action = one submission — without eating the next one. The whole
   * story (why a latch exists, why a blanket `if (inFlight) return` silently
   * dropped the second message a user typed while the previous send's ACK was
   * pending, and how a double-fire is told apart from a distinct message) lives
   * on `createSubmitLatch`.
   *
   * Created ONCE and dispatching through a ref: the latch's in-flight state
   * must survive re-renders (a fresh latch mid-send would reopen the
   * double-fire window), while the deferred re-run must read the CURRENT
   * dispatch closure, not the one from the render that created the latch.
   */
  const dispatchSubmissionRef = useRef(dispatchSubmission);
  useEffect(() => {
    dispatchSubmissionRef.current = dispatchSubmission;
  });
  const submitLatchRef = useRef<(() => Promise<void>) | null>(null);
  const handleSubmit = useCallback(() => {
    // Lazy-created at the first submit (never during render, which the
    // compiler's ref rules forbid) and reused forever after.
    submitLatchRef.current ??= createSubmitLatch<StashedDraft>(
      (stash) => dispatchSubmissionRef.current(stash),
      // Typed text is what marks a re-entrant submit as a distinct message
      // worth stashing; a double-fire arrives with the editor already
      // cleared. The stash takes the draft OUT of the editor right now — the
      // user sees the message leave on Enter, exactly as a direct send — and
      // submits it unchanged once the in-flight send settles. Files ride
      // along from the synchronous mirror, not from React state that may not
      // have flushed.
      () => {
        const editor = editorRef.current;
        const content = editor?.getContent();
        if (!editor || !content || !content.text.trim()) return null;
        const doc = editor.getDocument() ?? null;
        const files = attachedFilesRef.current;
        editor.clear();
        attachedFilesRef.current = [];
        setAttachedFiles([]);
        return { content, doc, files };
      },
    );
    return submitLatchRef.current();
  }, []);

  const editorPlaceholder = resolveEditorPlaceholder({
    lockForApproval,
    lockForQuestion,
    questionButtonLabel,
    placeholder,
  });

  /**
   * The rotating-hint overlay owns the placeholder only in the plain idle
   * state. A lock's copy is functional ("Answer the question…"), and a
   * disabled editor should not advertise shortcuts it will not honour — in
   * both cases the static TipTap placeholder keeps the job. While the overlay
   * IS active the editor gets `''`, so its `::before` renders empty and two
   * placeholders never paint at once (see animated-placeholder.tsx).
   */
  const animatePlaceholder = isEmpty && !editorDisabled && !lockForQuestion;

  /**
   * Whether the inset strip above the card has anything to show. Gated on
   * actual CONTENT, never on `sessionId`: that was truthy in every session, so
   * the strip's padded, bordered shell rendered as an empty rounded sliver
   * floating above the notice bar whenever it was empty. The prompt queue no
   * longer lives here — queued prompts are drawn in the transcript
   * (`turn/queued-prompt-bubbles.tsx`).
   */
  const showQueueStrip = Boolean(threadContext || inputSlot);

  return (
    <div
      className={cn(
        COMPOSER_SHELL_CLASS,
        // `'below'` docks the `/` menu as an overlay of later siblings
        // (starter suggestions). `twMerge` replaces the shell's `z-10` so
        // this stacking context sits above them; the dock's own `z-99` only
        // ranks inside this shell and cannot do that job.
        slashMenuPlacement === 'below' && 'z-50',
        parentClassName,
      )}
    >
      {/*
        The "still waking" notice. Above the card, in flow, so it pushes the
        composer down rather than covering anything — the same reasoning as the
        `/` dock below it.

        This replaces disabling the input. A stopped sandbox does not clear on
        its own, so the old treatment (dead editor, spinner where the send
        button belongs, no text) was indistinguishable from a broken composer.
        The input stays live; the submit becomes a durable inbox row and the
        control plane delivers it when the box answers, so nothing is lost by
        letting people type.

        `role="status"` + `aria-live="polite"`: this appears without the user
        doing anything, and it changes what the send button will DO. A screen
        reader that never announces it leaves exactly the confusion this bar
        exists to remove.
      */}
      {slashMenuPlacement === 'above' && <div id={dockId} />}

      {/*
        The stack above the card. Each layer owns its OWN top rounding rather
        than leaning on a wrapper clip: the old `overflow-hidden rounded-t-xl`
        on this wrapper only rounded whichever child happened to be topmost,
        so a full-width notice under the 96%-wide queue strip kept square
        corners — the "sometimes it breaks" bug. The rule now is width-based
        and unconditional: a layer wider than the one above it rounds its top
        (queue strip at 96%, first full-width bar, the card itself); a layer
        the SAME width as the one above stays square and shares the divider.
      */}
      {(notice || replyTo || showQueueStrip) && (
        <div className="relative isolate flex w-full flex-col items-center justify-center">
          {/*
            ONE element carries both the strip's chrome (bg, border, padding)
            AND `empty:hidden`. `inputSlot` is a fragment whose children all
            self-hide, so it is ALWAYS a truthy ReactNode — no JS condition can
            know whether it rendered anything. Only CSS `:empty` can, and it
            only works on the element that owns the visible chrome: the old
            two-div version hid an inner wrapper while the padded, bordered
            shell around it kept painting as an empty sliver.
          */}
          {showQueueStrip && (
            <div className={COMPOSER_INPUT_SLOT_CLASS}>
              {threadContext && (
                <button
                  onClick={threadContext.onBackToParent}
                  className={cn(
                    // `group`, or the arrow's `group-hover:` transforms below
                    // have no group to hover — the nudge was written and never
                    // fired.
                    'group text-muted-foreground hover:text-foreground hover:bg-muted/80 flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
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

          {notice && (
            <div
              role="status"
              aria-live="polite"
              // Always rounded: it is either the topmost layer or sits under
              // the NARROWER queue strip — both cases expose its top corners.
              className="bg-sidebar border-border flex w-full items-center gap-2 rounded-t-xl border border-b-0 px-3 py-1.5"
            >
              <Loading className="size-3.5 shrink-0" />
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                {notice}
              </span>
              {onNoticeRetry && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground hover:text-foreground h-auto shrink-0 px-1.5 py-0.5 text-xs"
                  onClick={onNoticeRetry}
                >
                  {'Retry'}
                </Button>
              )}
            </div>
          )}

          {replyTo && (
            // `w-full`, or the `items-center` column shrinks this bar to its
            // content width. Rounded only when no notice sits above it — the
            // notice is the same width, so under one this bar is a flush
            // continuation, not a new edge.
            <div
              className={cn(
                'bg-sidebar border-border flex w-full items-center gap-2 border border-b-0 px-3 py-1.5',
                !notice && 'rounded-t-xl',
              )}
            >
              <ArrowBendDoubleUpLeftIcon className="text-muted-foreground size-4 shrink-0" />
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                {replyTo.text.length > 120 ? `${replyTo.text.slice(0, 120)}…` : replyTo.text}
              </span>
              {onClearReply && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  onClick={onClearReply}
                  className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                  aria-label={tHardcodedUi.raw(
                    'componentsSessionSessionChatInput.line2078JsxAttrAriaLabelClearReply',
                  )}
                >
                  <Close className="size-3" />
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <div
        ref={cardRef}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropFiles}
        className={cn(
          // One shadow, from the ladder. `shadow-card` is defined nowhere in
          // `globals.css` and `shadow-xl` was dead — twMerge dropped it for the
          // arbitrary `shadow-[…oklch…]` that followed, which was the only
          // raw colour left in the composer.
          'bg-sidebar border-border relative isolate z-10 w-full rounded-xl border',
          'pt-3',
          'transition-[border-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
          'motion-reduce:transition-none',
          cardClassName,
          // NO `opacity-30` here. It used to sit on the card AND on the column
          // inside it, and the two multiplied — 0.3 × 0.3 = 0.09 — so the whole
          // composer, border and drop target included, went all but invisible
          // the moment a file crossed it. The card keeps full opacity and its
          // highlighted border; only the CONTENT dims, under the label below.
          isDragOver && 'border-kortix-blue/80 ring-primary/40 border ring',
          (replyTo || notice) && 'rounded-t-none',
        )}
      >
        {/* What the dimmed card is asking for. Without it the drag state said
            only "something is happening" — it never named the action or its
            result. `pointer-events-none` so it can never eat the drop. */}
        {isDragOver && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center"
          >
            <span className="text-foreground bg-sidebar/80 rounded-md px-3 py-1.5 text-sm font-medium">
              Drop files to attach
            </span>
          </div>
        )}

        <div
          className={cn(
            'relative z-[1] flex w-full flex-col overflow-visible',
            'transition-opacity duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
            'motion-reduce:transition-none',
            isDragOver && 'opacity-30',
          )}
        >
          {/* Inline chips: thread context, todos, queue — unified spacing */}

          <AttachmentTiles files={attachedFiles} onRemove={removeAttachedFile} />

          {/*
            The `/` command + attachments refusal. Directly under the tiles it
            refers to, and above the editor, so the files, the reason, and the
            two ways out are all in one glance.

            `role="alert"`: this appears in response to the user's own edit but
            it also DISABLES the send button, and a control that goes dead with
            no announcement is the exact "indistinguishable from broken" state
            the notice bar above the card exists to prevent.
          */}
          {commandAttachmentPlan.kind === 'refuse' && (
            <div
              role="alert"
              className="text-muted-foreground flex items-start gap-2 px-4 pt-3 text-xs"
            >
              <WarningIcon className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 text-balance">
                <span className="text-foreground font-medium">
                  {commandAttachmentPlan.message}.
                </span>{' '}
                {commandAttachmentPlan.description}
              </span>
            </div>
          )}

          <div
            className={cn(
              'flex min-w-0 flex-col px-2 pb-2',
              lockForApproval && 'composer-locked-approval',
              attachedFiles.length > 0 && 'pt-3',
            )}
          >
            {/*
              This padding is part of the input, so it has to behave like it.
              `px-2 pb-6` lives on THIS element, not on the contenteditable
              inside it, so the 24px band under the last line and the 8px strip
              down each side were dead: a press landed on the div, the editor
              never took focus, and nothing happened. That band is exactly
              where you click to resume typing, which made the composer read as
              broken. `cursor-text` matches the affordance to the behaviour.

              The guard is in `shouldFocusEditorFromPadding` — see it for why
              only a press that TERMINATES here may be forwarded.
            */}
            <div
              className="relative min-w-0 cursor-text px-2 pb-6"
              onMouseDown={(e) => {
                if (
                  !shouldFocusEditorFromPadding({
                    onWrapperItself: e.target === e.currentTarget,
                    disabled: editorDisabled,
                  })
                ) {
                  return;
                }
                // Before focusing, or the browser starts its own selection on
                // the div and immediately fights the caret we are placing.
                e.preventDefault();
                editorRef.current?.focus();
              }}
            >
              <AnimatedComposerPlaceholder
                placeholder={editorPlaceholder}
                active={animatePlaceholder}
              />
              <Suspense fallback={<ComposerEditorFallback />}>
                <ComposerEditorLazy
                  ref={setEditorRef}
                  placeholder={animatePlaceholder ? '' : editorPlaceholder}
                  disabled={editorDisabled}
                  onSubmit={handleSubmit}
                  onEmptyChange={setIsEmpty}
                  onDocChange={handleDocChange}
                  agents={agents}
                  sessions={allSessions ?? []}
                  currentSessionId={sessionId}
                  commands={commands}
                  actions={slashActions}
                  files={slashFiles}
                  onSelectAction={handleSelectAction}
                  slashDockSelector={`#${dockId}`}
                  onMenuOpenChange={setMenuOpen}
                />
              </Suspense>
            </div>

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
              leading={
                inlineUnderbar ? (
                  <ComposerUnderbar
                    variant="inline"
                    onAttachClick={handleAttachClick}
                    agents={primaryAgents}
                    selectedAgent={selectedAgent}
                    onAgentChange={onAgentChange}
                    agentSelectorLocked={agentSelectorLocked}
                    noAccessibleAgents={noAccessibleAgents}
                    messages={messages}
                    models={models}
                    selectedModel={availableSelectedModel}
                    onContextClick={onContextClick}
                  />
                ) : null
              }
              modelsLoading={modelsLoading}
              models={models}
              selectedModel={availableSelectedModel}
              onModelChange={onModelChange}
              modelDefaultControls={modelDefaultControls}
              providers={providers}
              modelRequired={modelRequired}
              modelMenuOpen={modelMenuOpen}
              onModelMenuOpenChange={setModelMenuOpen}
              reasoningMenuOpen={reasoningMenuOpen}
              onReasoningMenuOpenChange={setReasoningMenuOpen}
              variants={variants}
              selectedVariant={selectedVariant}
              onVariantChange={onVariantChange}
              projectId={projectId}
              // Inline placement has no under-row, so the slot (the session
              // overrides gear, meta indicator) rides the toolbar itself. With
              // the 'below' placement the ComposerUnderbar further down renders
              // it — passing it here as well would show the gear twice.
              toolbarSlot={inlineUnderbar ? toolbarSlot : undefined}
              rewind={rewind}
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
              submitDisabled={submitDisabled || commandAttachmentPlan.kind === 'refuse'}
              disabled={disabled}
              modelUnavailable={modelUnavailable}
              agentUnavailable={agentUnavailable}
              onSubmit={handleSubmit}
            />
          </div>
        </div>
      </div>

      {/*
        Attach + agent + context ring, in a row UNDER the card — not in the
        toolbar inside it. The card carries the message and the controls that
        shape the reply; this row carries what you bring to the message and
        what it costs. See `composer-underbar.tsx` for the layout rationale.
      */}
      {inlineUnderbar ? null : (
        <ComposerUnderbar
          onAttachClick={handleAttachClick}
          agents={primaryAgents}
          selectedAgent={selectedAgent}
          onAgentChange={onAgentChange}
          agentSelectorLocked={agentSelectorLocked}
          noAccessibleAgents={noAccessibleAgents}
          messages={messages}
          models={models}
          selectedModel={availableSelectedModel}
          onContextClick={onContextClick}
          toolbarSlot={toolbarSlot}
        />
      )}

      <ModelConnectionBar show={noModelsConnected} />

      {/*
        The `'below'` dock. Absolute, not in flow: `top-full` hangs it off the
        shell's bottom edge so an opening menu paints OVER whatever sits under
        the composer (starter chips, empty page) instead of pushing it down.
        `mt-2.5` is the same gap the menu's own `mb-2.5` gives the `'above'`
        dock — there the margin faces the card, here it faces away, so the
        gap moves to the dock. The horizontal inset mirrors the shell's
        `px-4 md:pr-1` gutter so the menu stays flush with the card edges.
        Empty (menu closed) it has zero height and intercepts nothing.

        `z-99` only beats siblings inside THIS shell (the card is
        `isolate z-10`). The shell itself is raised to `z-50` when placement
        is `'below'` so this whole stacking context sits above later siblings
        (starter suggestions). A z-index on those siblings that exceeds `z-50`
        would cover the menu again — they must stay unstacked.
      */}
      {slashMenuPlacement === 'below' && (
        <div id={dockId} className="absolute top-full right-4 left-4 z-99 mt-3.5 md:right-1" />
      )}
    </div>
  );
}

export const Composer = memo(ComposerImpl);
