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
import type { Command } from '@kortix/sdk/react';
import { useRuntimeSessions } from '@kortix/sdk/react';

import {
  ArrowUpLeftIcon as ArrowUpLeft,
  ArrowBendUpLeftIcon as Reply,
  TerminalWindowIcon as Terminal,
  XIcon as X,
} from '@phosphor-icons/react';

import { extractClipboardFiles } from '../clipboard-files';
import {
  mergeFailedSubmissionFiles,
  mergeFailedSubmissionText,
} from '../composer-draft-recovery';
import { resolveComposerResetOnSend } from '../composer-reset';
import { shouldQueueInsteadOfSend } from '../message-queue-boundary';
import {
  NO_MODEL_AVAILABLE_ACTION_MESSAGE,
  NO_MODEL_AVAILABLE_MESSAGE,
  isModelRequiredButUnavailable,
  resolveAvailableSelectedModel,
} from '../model-availability';
import { ModelConnectionBar } from '../model-connection-gate';
import { useModelConnectionGate } from '../use-model-connection-gate';
import type { SessionChatInputProps } from '../session-chat-input';

import { AttachmentTiles } from './attachment-tiles';
import { ComposerToolbar } from './composer-toolbar';
import type { ComposerEditorHandle } from './editor/composer-editor';
import { useComposerFocus } from './hooks/use-composer-focus';
import type { SlashAction } from './menus/slash-actions';
import { QueuedMessages, type QueuedMessageView } from './queued-messages';
import type { AttachedFile } from './types';

/** Stable empty list — mirrors `session-chat-input.tsx`'s `EMPTY_QUEUE`, same
 *  reasoning (never hand a fresh array to a memoized child). */
const EMPTY_QUEUE: QueuedMessageView[] = [];

/**
 * `ComposerEditor` (`./editor/composer-editor.tsx`) wraps `@tiptap/react` +
 * `prosemirror-*` — real weight that must not land in the first paint (T15
 * measures this). The brief for this task says to reach for
 * `next/dynamic(() => import(...), { ssr: false })`, but that wrapper's ref
 * forwarding is broken for a `forwardRef` target: `next@16.3.0`'s
 * `loadable.shared-runtime.js`'s `LoadableComponent(props, ref)` does
 * `useImperativeHandle(ref, () => ({ retry }), [])` — a ref attached to the
 * dynamic wrapper only ever resolves to `{ retry }`, and its
 * `createElement(resolve(state.loaded), props)` never forwards a `ref`
 * argument to the actually-loaded component at all (read line by line
 * against the installed package; this is not a version guess). `Composer`
 * needs the REAL `ComposerEditorHandle` (`getContent`/`setContent`/`clear`/
 * `focus`/`getElement`) for everything below it, so `next/dynamic` cannot be
 * used here as written — using it anyway would silently break every
 * imperative call site (submit, prefill, Tab-cycle, ARIA wiring).
 *
 * `React.lazy` + `Suspense` gets the SAME code-splitting outcome — `import()`
 * is what webpack/Turbopack actually key chunk-splitting off; `next/dynamic`
 * is a convenience wrapper around it, not the mechanism itself — while
 * correctly resolving to the real `forwardRef` component, so a `ref` on
 * `<ComposerEditorLazy>` reaches the genuine `ComposerEditorHandle`. Defined
 * at module scope, not inside `ComposerImpl`: calling `lazy()` fresh every
 * render would hand React a new component type each time, forcing an
 * unmount/remount of the editor (and losing its content) on every render.
 */
const ComposerEditorLazy = lazy(() =>
  import('./editor/composer-editor').then((mod) => ({ default: mod.ComposerEditor })),
);

/** Reserves the loaded editor's own min-height so the Suspense fallback
 *  doesn't shift layout once the real chunk resolves. */
function ComposerEditorFallback() {
  return <div className="min-h-[3rem]" aria-hidden />;
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
  // `onFileSearch` is NOT wired. The `@` menu's file search
  // (`composer/hooks/use-file-search.ts`) is a closed surface for this task
  // and always calls `searchWorkspaceFiles` directly — it takes no override.
  // `session-chat.tsx` is the one real caller passing a custom
  // `onFileSearch` (`handleFileSearch`) today; once Task 13 swaps this
  // component in, that override is silently unused. Flagged in the task
  // report — fixing it needs a new parameter on `useFileSearch`, out of
  // scope for a closed file.
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
  const savedTextBeforeQuestionRef = useRef('');

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
  // (a `MutationObserver` on `document.body`) rather than adding a new
  // prop-driven channel. Mirrors whichever listbox is currently mounted
  // onto the editor element's `aria-controls`/`aria-activedescendant`;
  // clears both when neither menu is open. Unverifiable without a browser —
  // see the task report. ─────────────────────────────────────────────────
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

    const detach = () => {
      attrObserver?.disconnect();
      attrObserver = null;
      attached = null;
      editorElement.removeAttribute('aria-controls');
      editorElement.removeAttribute('aria-activedescendant');
    };

    const attach = (el: HTMLElement) => {
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

    const bodyObserver = new MutationObserver(() => {
      const found = findListbox();
      if (found && found !== attached) {
        detach();
        attach(found);
      } else if (!found && attached) {
        detach();
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      bodyObserver.disconnect();
      detach();
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
  const handleTypeAhead = useCallback((char: string) => {
    // The handle exposes no raw "insert at cursor" primitive (by design —
    // see composer-editor.tsx's own comment on `setContent`). `merge` mode
    // is the closest equivalent: when the editor is empty (the overwhelming
    // common case for this redirect — it only fires while nothing is
    // focused, which is usually before anything has been typed at all) it
    // is a plain, correct insert. When the editor already has content, it
    // appends the character as a new paragraph rather than inline at the
    // exact cursor position — a known, minor deviation from the old
    // `ta.setRangeText(...)`, documented in the task report.
    editorRef.current?.setContent(char, 'merge');
  }, []);
  useComposerFocus({
    ref: composerFocusRef,
    autoFocus,
    disabled,
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
  // handle's own doc comment), so this is thinner than the original. ──────
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
    editorRef.current?.setContent(prefillText, prefillMode === 'merge' ? 'merge' : 'replace');
    if (prefillFiles?.length) {
      setAttachedFiles((current) =>
        prefillMode === 'merge'
          ? mergeFailedSubmissionFiles(current, prefillFiles)
          : [...prefillFiles],
      );
    }
    setStagedCommand(null);
    editorRef.current?.focus();
  }, [prefillId, prefillText, prefillFiles, prefillMode]);

  // ── Question lock: save/restore the draft, ported from
  // session-chat-input.tsx:383-394. Loses mention richness in the saved
  // draft (folds back in as plain "@label" text) for the same reason as the
  // failed-send recovery below — documented there and in the task report.
  useEffect(() => {
    if (lockForQuestion) {
      savedTextBeforeQuestionRef.current = editorRef.current?.getContent().text ?? '';
      editorRef.current?.clear();
    } else if (savedTextBeforeQuestionRef.current) {
      editorRef.current?.setContent(savedTextBeforeQuestionRef.current, 'replace');
      savedTextBeforeQuestionRef.current = '';
    }
  }, [lockForQuestion]);

  const handleTranscription = useCallback((transcribedText: string) => {
    editorRef.current?.setContent(transcribedText, 'merge');
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
      // Restore the submitted draft, merged with whatever the user typed
      // while the request was in flight — same order as the original
      // (`${submitted}\n\n${current}`, via `mergeFailedSubmissionText`
      // itself, not the handle's `setContent(..., 'merge')`, whose insert
      // order is reversed — see the task report). Mentions from the failed
      // send fold back in as plain "@label" text: `ComposerEditorHandle`
      // has no primitive to reinsert a mention ATOM node at an arbitrary
      // position, only `setContent(text, mode)`, so the retry's structured
      // mention payload is not restored — the visible text is, and stays
      // readable. Documented in the task report as a follow-up needing a
      // small extension to the (closed, for this task) editor handle.
      if (clearOnSend) {
        const currentText = editorRef.current?.getContent().text ?? '';
        const merged = mergeFailedSubmissionText(currentText, trimmed);
        editorRef.current?.setContent(merged, 'replace');
        setAttachedFiles((current) => mergeFailedSubmissionFiles(current, filesToSend ?? []));
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

  const editorPlaceholder = stagedCommand
    ? 'Enter details and press Enter, or press Esc to cancel'
    : lockForApproval
      ? 'Approve or deny the action above to continue…'
      : lockForQuestion
        ? questionButtonLabel
          ? 'Or type your own answer...'
          : 'Type your answer...'
        : placeholder;

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
              the old AttachmentPreview. `attachment-preview.tsx` is not
              deleted; Task 13 owns that once every consumer of the old
              composer has moved. */}
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

          <div className="flex max-h-[320px] flex-col gap-1 px-3.5 py-3">
            <Suspense fallback={<ComposerEditorFallback />}>
              <ComposerEditorLazy
                ref={setEditorRef}
                placeholder={editorPlaceholder}
                disabled={disabled || lockForApproval}
                onSubmit={handleSubmit}
                onEmptyChange={setIsEmpty}
                agents={agents}
                sessions={allSessions ?? []}
                currentSessionId={sessionId}
                commands={commands}
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
            // Assigned item 5: the responsive collapse belongs to the new
            // shell, not the (shared, still-live) toolbar — see this prop's
            // own doc comment in composer-toolbar.tsx.
            tokenProgressWrapperClassName="hidden sm:flex"
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
