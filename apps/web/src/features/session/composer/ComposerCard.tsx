import { WarningIcon } from '@phosphor-icons/react';
import { lazy, Suspense } from 'react';
import { cn } from '@/lib/utils';
import { AnimatedComposerPlaceholder } from './animated-placeholder';
import { AttachmentTiles } from './attachment-tiles';
import { shouldFocusEditorFromPadding } from './composer-logic';
import { ComposerToolbar } from './composer-toolbar';
import { ComposerUnderbar } from './composer-underbar';
import { ImagesUnsupportedBar, ModelConnectionBar } from '../model-connection-gate';
import type { SessionChatInputProps } from './composer';
import type { ComposerEditorHandle } from './editor/composer-editor';
import type { AttachedFile } from './types';
import type { SlashAction } from './menus/slash-actions';
import type { Agent } from '@kortix/sdk/react';
import type { RefObject, Dispatch, SetStateAction } from 'react';

const ComposerEditorLazy = lazy(() =>
  import('./editor/composer-editor').then((mod) => ({ default: mod.ComposerEditor })),
);

function ComposerEditorFallback() {
  return <div className="min-h-[1.5em]" aria-hidden />;
}

export type ComposerCardProps = Pick<SessionChatInputProps,
  | 'cardClassName' | 'notice' | 'agents' | 'sessionId' | 'commands' | 'slashFiles'
  | 'selectedAgent' | 'onAgentChange' | 'agentSelectorLocked' | 'noAccessibleAgents'
  | 'messages' | 'models' | 'onContextClick' | 'modelsLoading' | 'onModelChange'
  | 'modelDefaultControls' | 'providers' | 'modelRequired' | 'variants'
  | 'selectedVariant' | 'onVariantChange' | 'projectId' | 'toolbarSlot' | 'rewind'
  | 'isSending' | 'isBusy' | 'onStop' | 'stopDisabled' | 'escCount'
  | 'lockForQuestion' | 'questionButtonLabel' | 'questionCanAct' | 'disabled'
  | 'onArrowUpAtStart'
> & {
  cardRef: RefObject<HTMLDivElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  editorRef: RefObject<ComposerEditorHandle | null>;
  handleDragEnter: React.DragEventHandler<HTMLElement>;
  handleDragOver: React.DragEventHandler<HTMLElement>;
  handleDragLeave: React.DragEventHandler<HTMLElement>;
  handleDropFiles: React.DragEventHandler<HTMLElement>;
  isDragOver: boolean;
  tHardcodedUi: ReturnType<typeof import('@/i18n/use-translations').useTranslations>;
  attachedFiles: AttachedFile[];
  promptAttachmentItems: React.ComponentProps<typeof AttachmentTiles>['uploads'];
  removeAttachedFile: (index: number) => void;
  retryAttachedFile: (id: string) => void;
  commandAttachmentPlan: ReturnType<typeof import('./command-attachments').planCommandAttachments>;
  lockForApproval: boolean;
  editorDisabled: boolean;
  editorPlaceholder: string;
  animatePlaceholder: boolean;
  setEditorRef: (handle: ComposerEditorHandle | null) => void;
  handleSubmit: (placement?: 'transcript' | 'composer') => Promise<void>;
  handleArrowUpAtStart: () => boolean;
  setIsEmpty: Dispatch<SetStateAction<boolean>>;
  handleDocChange: React.ComponentProps<typeof ComposerEditorLazy>['onDocChange'];
  allSessions: ReturnType<typeof import('@kortix/sdk/react').useRuntimeSessions>['data'];
  slashActions: SlashAction[];
  handleSelectAction: (action: SlashAction) => void;
  dockId: string;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  handleFileSelect: React.ChangeEventHandler<HTMLInputElement>;
  inlineUnderbar: boolean;
  handleAttachClick: () => void;
  primaryAgents: Agent[];
  availableSelectedModel: SessionChatInputProps['selectedModel'];
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
};

export function ComposerCard({
  cardRef,
  handleDragEnter,
  handleDragOver,
  handleDragLeave,
  handleDropFiles,
  cardClassName,
  isDragOver,
  notice,
  tHardcodedUi,
  attachedFiles,
  promptAttachmentItems,
  removeAttachedFile,
  retryAttachedFile,
  commandAttachmentPlan,
  lockForApproval,
  editorDisabled,
  editorRef,
  editorPlaceholder,
  animatePlaceholder,
  setEditorRef,
  handleSubmit,
  onArrowUpAtStart,
  handleArrowUpAtStart,
  setIsEmpty,
  handleDocChange,
  agents,
  allSessions,
  sessionId,
  commands,
  slashActions,
  slashFiles,
  handleSelectAction,
  dockId,
  setMenuOpen,
  fileInputRef,
  handleFileSelect,
  inlineUnderbar,
  handleAttachClick,
  primaryAgents,
  selectedAgent,
  onAgentChange,
  agentSelectorLocked,
  noAccessibleAgents,
  messages,
  models,
  availableSelectedModel,
  onContextClick,
  modelsLoading,
  onModelChange,
  modelDefaultControls,
  providers,
  modelRequired,
  modelMenuOpen,
  setModelMenuOpen,
  reasoningMenuOpen,
  setReasoningMenuOpen,
  variants,
  selectedVariant,
  onVariantChange,
  projectId,
  toolbarSlot,
  rewind,
  isSending,
  isBusy,
  onStop,
  stopDisabled,
  escCount,
  lockForQuestion,
  questionButtonLabel,
  questionCanAct,
  isEmpty,
  canSubmit,
  submitDisabled,
  attachmentFailed,
  modelRejectingImages,
  imagesUnsupportedReason,
  disabled,
  modelUnavailable,
  agentUnavailable,
  noModelsConnected,
}: ComposerCardProps) {
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
          notice && 'rounded-t-none',
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
              attachedFiles.length > 0 && 'pt-3',
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
          agentSelectorLocked={agentSelectorLocked}
          noAccessibleAgents={noAccessibleAgents}
          messages={messages}
          models={models}
          selectedModel={availableSelectedModel}
          onContextClick={onContextClick}
          toolbarSlot={toolbarSlot}
        />
      )}

    </>
  );
}
