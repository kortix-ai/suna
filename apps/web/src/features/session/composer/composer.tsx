'use client';

import { toast } from '@/lib/toast';
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
import { shouldQueueInsteadOfSend } from '../message-queue-boundary';
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

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Close } from '@/features/icon/icons/close';
import { AttachmentTiles } from './attachment-tiles';
import {
  draftWillRunCommand,
  planCommandAttachments,
  readCommandChipLabel,
} from './command-attachments';
import {
  appendTranscribedText,
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
import { controlToOpenFor, SLASH_ACTIONS, type SlashAction } from './menus/slash-actions';
import { QueuedMessages, type QueuedMessageView } from './queued-messages';
import type { AttachedFile, TrackedMention } from './types';

export interface SessionChatInputProps {
  onSend: (
    text: string,
    files?: AttachedFile[],
    mentions?: TrackedMention[],
  ) => void | Promise<void>;
  isBusy?: boolean;
  queuedMessages?: QueuedMessageView[];
  failedQueuedMessages?: QueuedMessageView[];
  /** The queued messages currently on the wire. Cannot be edited, moved or removed.
   *  Plural: the queue drains as one batch, so several rows are live at once. */
  queueInFlightIds?: string[];
  /**
   * The queue is held by a stop. Dims the list — never silent.
   *
   * Ported from `session-chat-input.tsx` during the main merge: that file is
   * now a re-export barrel, and its old implementation (which main had grown
   * these two props on) is gone. `session-chat.tsx` still passes them, and
   * `QueuedMessages` still reads them, so without this the paused state would
   * have been dropped on the floor by the merge rather than by a decision.
   */
  queuePaused?: boolean;
  /** The agent is mid-turn, so the per-row send must stop it first. */
  queueIsRunning?: boolean;
  onQueueMessage?: (
    text: string,
    files?: AttachedFile[],
    mentions?: TrackedMention[],
    /** Present when this entry runs a `/` command instead of sending `text`. */
    command?: { name: string; split?: { before: string; after: string } },
  ) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onEditQueuedMessage?: (id: string, text: string) => void;
  /**
   * Accepted but no longer wired to anything. The queue drains as ONE batch,
   * so moving row 3 above row 2 changes nothing a user can observe — the
   * reorder UI was chrome for a distinction without a difference and was
   * removed with the ChatGPT-style queue rows. Kept in the type so existing
   * callers keep compiling; delete it here and at those call sites together.
   */
  onReorderQueuedMessage?: (id: string, toIndex: number) => void;
  onSendQueuedMessageNow?: (id: string) => void;
  onRetryQueuedMessage?: (id: string) => void;
  onStop?: () => void;
  stopDisabled?: boolean;
  isSending?: boolean;
  agents?: Agent[];
  selectedAgent?: string | null;
  onAgentChange?: (agentName: string | null | undefined) => void;
  agentSelectorLocked?: boolean;
  commands?: Command[];
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
  disabled?: boolean;
  /**
   * The session's runtime is up. `false` — a stopped or still-waking sandbox —
   * does NOT disable anything: it routes a submit to the queue instead of the
   * wire (`shouldQueueInsteadOfSend`), where the drain's matching gate holds it
   * until the box answers. Pair it with `notice` so the reason is on screen.
   */
  runtimeReady?: boolean;
  /**
   * A line shown in a bar directly ABOVE the composer card. Used for "this
   * session is still waking" — a state that used to disable the input and show
   * a spinner with no explanation, which was indistinguishable from broken.
   */
  notice?: string | null;
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

  providers?: ProviderListResponse;
  threadContext?: {
    parentTitle: string;
    onBackToParent: () => void;
  };

  onContextClick?: () => void;
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
 * `mx-auto w-full max-w-3xl min-w-0 px-4 py-6 pb-32`). Whenever the column is
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

const EMPTY_QUEUE: QueuedMessageView[] = [];
/** Same, for the in-flight ids. */
const EMPTY_QUEUE_IN_FLIGHT: string[] = [];

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
  failedQueuedMessages,
  queuedMessages,
  queueInFlightIds = EMPTY_QUEUE_IN_FLIGHT,
  queuePaused = false,
  queueIsRunning = false,
  onQueueMessage,
  onRemoveQueuedMessage,
  onEditQueuedMessage,
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
  runtimeReady = true,
  notice = null,
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
  underbarPlacement = 'below',
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

  const dockId = `composer-slash-dock-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
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
  const submitDisabled = disabled || modelUnavailable || lockForApproval;
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

  const handleTranscription = useCallback((transcribedText: string) => {
    const handle = editorRef.current;
    if (!handle) return;
    const next = appendTranscribedText(handle.getDocument(), handle.isEmpty(), transcribedText);
    setDocumentWithoutStealingFocus(handle, next);
  }, []);

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
  const slashActions = useMemo(
    () =>
      selectedAgent
        ? SLASH_ACTIONS.map((action) =>
            action.id === 'switch-agent' ? { ...action, value: selectedAgent } : action,
          )
        : SLASH_ACTIONS,
    [selectedAgent],
  );

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
        default:
          // `set-scope` and `start-voice` remain no-ops: `VoiceRecorder` owns
          // its own state with no external control, and scope lives outside
          // this component entirely.
          return;
      }
    },
    [cycleAgent],
  );

  const dispatchSubmission = useCallback(async () => {
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

    const draft = editorRef.current?.getContent();
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
        attachmentCount: attachedFiles.length,
      });
      if (guard.kind === 'refuse') {
        toast.error(guard.message, { description: guard.description });
        return;
      }

      // A command takes its turn like everything else.
      //
      // This branch used to `return` before the queue decision below, which
      // made a `/` command STRUCTURALLY unqueueable: submitting one while the
      // agent was mid-turn put it straight on the wire, ahead of every message
      // already waiting — and, because a new prompt aborts the running turn,
      // killed the answer in progress. Ordering is the queue's whole purpose;
      // a command is a turn, and the only thing that differs is which call
      // dispatches it, which the drain decides at dispatch time.
      if (
        onQueueMessage &&
        shouldQueueInsteadOfSend({
          isBusy,
          pendingCount: queuedMessages?.length ?? 0,
          hasInFlight: queueInFlightIds.length > 0,
          runtimeReady,
        })
      ) {
        // No files: the guard above proves there are none to pass. `undefined`
        // here is a fact about the draft, not a discard.
        onQueueMessage(plan.args ?? '', undefined, undefined, {
          name: plan.command.name,
          split: draft?.commandSplit,
        });
      } else {
        onCommand?.(plan.command, plan.args, draft?.commandSplit);
      }
      if (clearOnSend) {
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

    const content = draft ?? { text: '', mentions: [] };
    const trimmed = plan.text;
    if ((!trimmed && attachedFiles.length === 0) || submitDisabled) return;

    const filesToSend = attachedFiles.length > 0 ? [...attachedFiles] : undefined;
    const mentionsToSend = content.mentions.length > 0 ? [...content.mentions] : undefined;
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
        hasInFlight: queueInFlightIds.length > 0,
        runtimeReady,
      })
    ) {
      onQueueMessage(trimmed, filesToSend, mentionsToSend);
      return;
    }

    try {
      await onSend(trimmed, filesToSend, mentionsToSend);
      for (const url of reset.urlsToRevoke) URL.revokeObjectURL(url);
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
  }, [
    submitDisabled,
    modelUnavailable,
    clearOnSend,
    onSend,
    isBusy,
    onQueueMessage,
    queuedMessages,
    queueInFlightIds,
    onCommand,
    commands,
    attachedFiles,
    lockForQuestion,
    lockForApproval,
    onCustomAnswer,
    onQuestionAction,
  ]);

  /**
   * One user action = one submission, even if the action fires twice.
   *
   * The sandbox proxy used to absorb an accidental double-fire for free: with
   * no `Idempotency-Key` (the browser cannot send one — it is absent from the
   * API's CORS allow-list) it deduped a delivery by sha256 of the request body,
   * so two identical prompts inside 60s collapsed to one. Giving each
   * submission its own `messageID` deliberately ended that, because the same
   * mechanism was silently swallowing prompts a user MEANT to send twice.
   *
   * That leaves the accidental case with nothing behind it. `dispatchSubmission`
   * clears the editor synchronously before it awaits, which stops a repeat of
   * the TEXT — but `setAttachedFiles([])` is React state and has not flushed, so
   * a second Enter in the same tick could still get past the empty-draft guard
   * on `attachedFiles.length > 0` and post an empty message carrying the files.
   *
   * A latch is the honest fix, and it belongs here rather than in the transport:
   * only this layer knows the difference between one user action and two. A ref,
   * not state, because it has to be observable in the same tick it is set.
   */
  const submissionInFlight = useRef(false);
  const handleSubmit = useCallback(async () => {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    try {
      await dispatchSubmission();
    } finally {
      // `finally`, so a throw from any dispatch path cannot wedge the composer
      // into permanently refusing to send. `dispatchSubmission` already handles
      // its own send failure and restores the draft; this only releases the gate.
      submissionInFlight.current = false;
    }
  }, [dispatchSubmission]);

  const editorPlaceholder = resolveEditorPlaceholder({
    lockForApproval,
    lockForQuestion,
    questionButtonLabel,
    placeholder,
  });

  /**
   * Whether the inset strip above the card has anything to show. Gated on
   * actual CONTENT, never on `sessionId`: that was truthy in every session, so
   * the strip's padded, bordered shell rendered as an empty rounded sliver
   * floating above the notice bar whenever the queue was empty.
   */
  const queueHasRows =
    (queuedMessages?.length ?? 0) > 0 || (failedQueuedMessages?.length ?? 0) > 0;
  const showQueueStrip = Boolean(threadContext || inputSlot || queueHasRows);

  return (
    <div className={COMPOSER_SHELL_CLASS}>
      {/*
        The "still waking" notice. Above the card, in flow, so it pushes the
        composer down rather than covering anything — the same reasoning as the
        `/` dock below it.

        This replaces disabling the input. A stopped sandbox does not clear on
        its own, so the old treatment (dead editor, spinner where the send
        button belongs, no text) was indistinguishable from a broken composer.
        The input stays live; `shouldQueueInsteadOfSend` routes the submit to
        the queue and the drain's `runtimeReady` gate releases it when the box
        answers, so nothing is lost by letting people type.

        `role="status"` + `aria-live="polite"`: this appears without the user
        doing anything, and it changes what the send button will DO. A screen
        reader that never announces it leaves exactly the confusion this bar
        exists to remove.
      */}
      <div id={dockId} />

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
            <div className="bg-sidebar border-border flex w-[96%] flex-col items-center gap-2 rounded-t-xl border border-b-0 px-2 py-1.5 empty:hidden">
              <QueuedMessages
                  messages={queuedMessages ?? EMPTY_QUEUE}
                  failed={failedQueuedMessages}
                  inFlightIds={queueInFlightIds}
                  paused={queuePaused}
                  isRunning={queueIsRunning}
                  onRemove={onRemoveQueuedMessage}
                  onEdit={onEditQueuedMessage}
                  onSendNow={onSendQueuedMessageNow}
                  onRetry={onRetryQueuedMessage}
                />

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
          'bg-sidebar shadow-card border-border relative isolate z-10 w-full rounded-xl border shadow-xl',
          'pt-3 shadow-[0_0_4px_oklch(0_0_0/0.03)] dark:shadow-md',
          'transition-[border-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
          'motion-reduce:transition-none',
          cardClassName,
          isDragOver && 'border-kortix-blue/80 ring-primary/40 border opacity-30 ring',
          (replyTo || notice) && 'rounded-t-none',
        )}
      >
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
                  commands={commands}
                  actions={slashActions}
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
              submitDisabled={submitDisabled || commandAttachmentPlan.kind === 'refuse'}
              disabled={disabled}
              modelUnavailable={modelUnavailable}
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
          messages={messages}
          models={models}
          selectedModel={availableSelectedModel}
          onContextClick={onContextClick}
          toolbarSlot={toolbarSlot}
        />
      )}

      <ModelConnectionBar show={noModelsConnected} />
    </div>
  );
}

export const Composer = memo(ComposerImpl);
