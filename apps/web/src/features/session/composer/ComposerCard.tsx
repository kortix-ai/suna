'use client';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { Agent, UsePromptAttachmentsResult, useRuntimeSessions } from '@kortix/sdk/react';
import type { PastedContent } from '@kortix/shared';
import { WarningIcon } from '@phosphor-icons/react';
import type { JSONContent } from '@tiptap/core';
import type {
  ChangeEventHandler,
  Dispatch,
  DragEventHandler,
  RefObject,
  SetStateAction,
} from 'react';
import { lazy, Suspense, useRef } from 'react';

import { ImagesUnsupportedBar, ModelConnectionBar } from '../model-connection-gate';
import { AnimatedComposerPlaceholder } from './animated-placeholder';
import { AttachmentTiles } from './attachment-tiles';
import {
  EMPTY_AGENTS,
  EMPTY_COMMANDS,
  EMPTY_MODELS,
  EMPTY_SLASH_FILES,
  EMPTY_VARIANTS,
  type SessionChatInputProps,
} from './composer';
import { shouldFocusEditorFromPadding } from './composer-logic';
import { ComposerToolbar } from './composer-toolbar';
import { ComposerUnderbar } from './composer-underbar';
import type { ComposerEditorHandle } from './editor/composer-editor';
import type { SlashAction } from './menus/slash-actions';
import type { AttachedFile } from './types';

const ComposerEditorLazy = lazy(() =>
  import('./editor/composer-editor').then((mod) => ({ default: mod.ComposerEditor })),
);

function ComposerEditorFallback() {
  return <div className="min-h-[1.5em]" aria-hidden />;
}

/**
 * The composer card and everything docked to it: the card shell (drag
 * overlay, attachment tiles, `/` refusal, editor, toolbar), the model-gate
 * bars under it, the below-card underbar row and the `'below'` `/` dock
 * anchor. `ComposerImpl` owns the state and effects and passes them in; this
 * renders exactly the subtree `ComposerImpl` used to inline (KRTX-373
 * phase 1).
 */
export interface ComposerCardDerived {
  tHardcodedUi: ReturnType<typeof useTranslations>;
  isDragOver: boolean;
  handleDragEnter: DragEventHandler<HTMLElement>;
  handleDragOver: DragEventHandler<HTMLElement>;
  handleDragLeave: DragEventHandler<HTMLElement>;
  handleDropFiles: DragEventHandler<HTMLElement>;
  attachedFiles: AttachedFile[];
  promptAttachmentItems: UsePromptAttachmentsResult['attachments'];
  removeAttachedFile: (index: number) => void;
  retryAttachedFile: (id: string) => void;
  pastes: PastedContent[];
  removePaste: (id: string) => void;
  commandAttachmentPlan: ReturnType<typeof import('./command-attachments').planCommandAttachments>;
  editorDisabled: boolean;
  editorRef: RefObject<ComposerEditorHandle | null>;
  setEditorRef: (handle: ComposerEditorHandle | null) => void;
  editorPlaceholder: string;
  animatePlaceholder: boolean;
  handleSubmit: (placement?: 'transcript' | 'composer') => Promise<void>;
  handleArrowUpAtStart: () => boolean;
  setIsEmpty: Dispatch<SetStateAction<boolean>>;
  handleDocChange: (doc: JSONContent, isEmpty: boolean) => void;
  allSessions: ReturnType<typeof useRuntimeSessions>['data'];
  slashActions: SlashAction[];
  handleSelectAction: (action: SlashAction) => void;
  dockId: string;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileSelect: ChangeEventHandler<HTMLInputElement>;
  handleAttachClick: () => void;
  primaryAgents: Agent[];
  availableSelectedModel: { providerID: string; modelID: string } | null;
  modelMenuOpen: boolean;
  setModelMenuOpen: Dispatch<SetStateAction<boolean>>;
  reasoningMenuOpen: boolean;
  setReasoningMenuOpen: Dispatch<SetStateAction<boolean>>;
  isEmpty: boolean;
  canSubmit: boolean;
  submitDisabled: boolean;
  attachmentFailed: boolean;
  modelRejectingImages: string | null;
  imagesUnsupportedReason: string | null;
  modelUnavailable: boolean;
  agentUnavailable: boolean;
  noModelsConnected: boolean;
}

export type ComposerCardProps = SessionChatInputProps & ComposerCardDerived;

export function ComposerCard({
  tHardcodedUi,
  isDragOver,
  handleDragEnter,
  handleDragOver,
  handleDragLeave,
  handleDropFiles,
  attachedFiles,
  promptAttachmentItems,
  removeAttachedFile,
  retryAttachedFile,
  pastes,
  removePaste,
  onOpenPastedContent,
  commandAttachmentPlan,
  editorDisabled,
  editorRef,
  setEditorRef,
  editorPlaceholder,
  animatePlaceholder,
  handleSubmit,
  handleArrowUpAtStart,
  setIsEmpty,
  handleDocChange,
  allSessions,
  slashActions,
  handleSelectAction,
  dockId,
  setMenuOpen,
  fileInputRef,
  handleFileSelect,
  sessionId,
  handleAttachClick,
  primaryAgents,
  availableSelectedModel,
  modelMenuOpen,
  setModelMenuOpen,
  reasoningMenuOpen,
  setReasoningMenuOpen,
  isEmpty,
  canSubmit,
  submitDisabled,
  attachmentFailed,
  modelRejectingImages,
  imagesUnsupportedReason,
  modelUnavailable,
  agentUnavailable,
  noModelsConnected,
  // Raw props the moved JSX reads; `{...props}` carries the rest. These
  // defaults mirror `ComposerImpl`'s, because the spread passes the raw
  // values, not the component's defaulted locals.
  agents = EMPTY_AGENTS,
  commands = EMPTY_COMMANDS,
  slashFiles = EMPTY_SLASH_FILES,
  models = EMPTY_MODELS,
  notice = null,
  disabled = false,
  lockForQuestion = false,
  lockForApproval = false,
  questionButtonLabel = null,
  submitLabel = null,
  questionCanAct = true,
  escCount = 0,
  isBusy = false,
  isSending = false,
  onStop,
  stopDisabled = false,
  modelsLoading = false,
  modelRequired = false,
  onModelChange,
  modelDefaultControls,
  providers,
  variants = EMPTY_VARIANTS,
  selectedVariant = null,
  onVariantChange,
  projectId,
  toolbarSlot,
  servedModel,
  rewind,
  selectedAgent = null,
  onAgentChange,
  noAccessibleAgents = false,
  onContextClick,
  messages,
  underbarPlacement = 'below',
  slashMenuPlacement = 'above',
  cardClassName,
  onArrowUpAtStart,
}: ComposerCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const inlineUnderbar = underbarPlacement === 'inline';

  return (
    <>
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
        'bg-background border-border relative isolate z-10 w-full rounded-xl border',
        'pt-3',
        // The drag border swaps colour AND gains a ring. Without this it
        // snapped: a hard flash the moment a file crossed the card.
        'duration-normal ease-default transition-[border-color]',
        'motion-reduce:transition-none',
        cardClassName,
        isDragOver && 'border-kortix-blue/80 ring-primary/40 border ring',
        // A strip above (`ComposerAboveCard`) owns the top corners.
        (notice || (onModelChange && servedModel)) && 'rounded-t-none',
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
            {tHardcodedUi.raw('i18nComplete.text1ab1b095c1ed')}
          </span>
        </div>
      )}

      <div
        className={cn(
          'relative z-[1] flex w-full flex-col overflow-visible',
          'transition-opacity duration-(--duration-normal) ease-[cubic-bezier(0.23,1,0.32,1)]',
          'motion-reduce:transition-none',
          isDragOver && 'opacity-30',
        )}
      >
        {/* Inline chips: thread context, todos, queue — unified spacing */}

        <AttachmentTiles
          files={attachedFiles}
          uploads={promptAttachmentItems}
          onRemove={removeAttachedFile}
          onRetry={retryAttachedFile}
          pastes={pastes}
          onRemovePaste={removePaste}
          onOpenPaste={
            onOpenPastedContent ? (paste) => onOpenPastedContent(paste.id, paste.text) : undefined
          }
        />

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
            (attachedFiles.length > 0 || pastes.length > 0) && 'pt-3',
          )}
        >
          {/*
            This padding is part of the input, so it has to behave like it.
            `px-1 pb-9` lives on THIS element, not on the contenteditable
            inside it, so the band under the last line and the strip down
            each side were dead: a press landed on the div, the editor
            never took focus, and nothing happened. That band is exactly
            where you click to resume typing, which made the composer read as
            broken. `cursor-text` matches the affordance to the behaviour.

            The guard is in `shouldFocusEditorFromPadding` — see it for why
            only a press that TERMINATES here may be forwarded.
          */}
          <div
            className="relative min-w-0 cursor-text px-1 pb-9"
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
                onArrowUpAtStart={onArrowUpAtStart ? handleArrowUpAtStart : undefined}
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
            accept="image/*,.pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.toml,.js,.ts,.jsx,.tsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.vue,.svelte,.log,.sql,.zip,.tar,.gz,.rar"
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
            submitLabel={submitLabel}
            questionCanAct={questionCanAct}
            hasText={!isEmpty}
            canSubmit={canSubmit}
            submitDisabled={
              submitDisabled ||
              attachmentFailed ||
              modelRejectingImages !== null ||
              commandAttachmentPlan.kind === 'refuse'
            }
            attachmentFailed={attachmentFailed}
            attachmentUnsupported={imagesUnsupportedReason}
            disabled={disabled}
            modelUnavailable={modelUnavailable}
            agentUnavailable={agentUnavailable}
            onSubmit={() => handleSubmit()}
          />
        </div>
      </div>
    </div>

    {/*
      Directly under the card, and BEFORE the underbar — the bar is a tray
      that hangs off the card's bottom edge (see `ModelConnectionBar` for the
      overlap), so it has to be the card's next sibling. Below the underbar it
      was a third detached box under a second detached box.

      The card is `isolate z-10` and this is `z-0`, so the card paints over
      the overlap and only the tray's exposed strip shows.
    */}
    <ModelConnectionBar show={noModelsConnected} />
    <ImagesUnsupportedBar modelName={noModelsConnected ? null : modelRejectingImages} />

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
        noAccessibleAgents={noAccessibleAgents}
        messages={messages}
        models={models}
        selectedModel={availableSelectedModel}
        onContextClick={onContextClick}
        toolbarSlot={toolbarSlot}
      />
    )}

    {/*
      The `'below'` dock. Absolute, not in flow: `top-full` hangs it off the
      shell's bottom edge so an opening menu paints OVER whatever sits under
      the composer (starter chips, empty page) instead of pushing it down.
      `mt-2.5` is the same gap the menu's own `mb-2.5` gives the `'above'`
      dock — there the margin faces the card, here it faces away, so the
      gap moves to the dock. The horizontal inset mirrors the shell's
      `px-4` gutter so the menu stays flush with the card edges.
      Empty (menu closed) it has zero height and intercepts nothing.

      `z-99` only beats siblings inside THIS shell (the card is
      `isolate z-10`). The shell itself is raised to `z-50` when placement
      is `'below'` so this whole stacking context sits above later siblings
      (starter suggestions). A z-index on those siblings that exceeds `z-50`
      would cover the menu again — they must stay unstacked.
    */}
    {slashMenuPlacement === 'below' && (
      <div id={dockId} className="absolute top-full right-4 left-4 z-99 mt-3.5" />
    )}
    </>
  );
}
