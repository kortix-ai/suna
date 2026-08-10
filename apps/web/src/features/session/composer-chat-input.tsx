'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionScopeCommit } from '@/features/session/scope/session-scope-model';
import { SessionScopeToolbar } from '@/features/session/scope/session-scope-toolbar';
import {
  type AttachedFile,
  SessionChatInput,
  type SessionChatInputProps,
  type TrackedMention,
} from '@/features/session/session-chat-input';
import { useRuntimeConfig } from '@kortix/sdk/react';
import { type ModelKey, useSessionModelSelection } from '@kortix/sdk/react';
import {
  type Command,
  useRuntimeAgents,
  useRuntimeCommands,
  useRuntimeProviders,
} from '@kortix/sdk/react';
import { useProjectConfig } from '@kortix/sdk/react';
import { isMetaAgentName } from '@kortix/shared';

export interface ComposerOptions {
  agent?: string;
  model?: ModelKey;
  variant?: string;
  scope?: SessionScopeCommit;
}

/**
 * The canonical "compose a first message" input: {@link SessionChatInput}
 * pre-wired with the OpenCode model / agent / variant / command selectors (the
 * four catalog queries + per-session selection state). Used by the home composer
 * and the instant session shell so neither hand-rolls the selector wiring.
 *
 * The current selections are handed to `onSend` / `onCommand` as `options`, so
 * callers never need their own `useRuntimeLocal`.
 */
export function ComposerChatInput({
  onSend,
  onCommand,
  sessionId,
  projectId,
  isBusy,
  stopDisabled,
  isSending,
  disabled,
  autoFocus,
  placeholder,
  prefill,
  inputSlot,
  toolbarSlot,
  cardClassName,
  boundAgentName,
  clearOnSend,
  queuedMessages,
  failedQueuedMessages,
  queueInFlightId,
  queuePaused,
  onResumeQueue,
  onQueueMessage,
  onRemoveQueuedMessage,
  onEditQueuedMessage,
  onReorderQueuedMessage,
  onRetryQueuedMessage,
  onAgentSelectionChange,
}: {
  onSend: (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => void;
  onCommand?: (command: Command, args: string | undefined, options: ComposerOptions) => void;
  sessionId?: string;
  projectId?: string;
  isBusy?: boolean;
  /** Show a disabled stop button while busy (e.g. the computer is still booting). */
  stopDisabled?: boolean;
  /** Send in flight, not yet settled — spinner in the send slot (see SessionChatInput.isSending). */
  isSending?: boolean;
  disabled?: boolean;
  /** Clear the composer optimistically on send. Set false on the project-home
   *  composer, whose send navigates it away (see SessionChatInput.clearOnSend). */
  clearOnSend?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  prefill?: {
    text: string;
    id: number;
    files?: AttachedFile[];
    mode?: 'replace' | 'merge';
  } | null;
  inputSlot?: ReactNode;
  toolbarSlot?: ReactNode;
  /** Extra classes for the input card (e.g. the project-home radius override). */
  cardClassName?: string;
  /** Immutable project-session agent. When set, sends are locked to this agent. */
  boundAgentName?: string | null;
  /** Queued-while-busy support, passed straight through to SessionChatInput. */
  queuedMessages?: SessionChatInputProps['queuedMessages'];
  failedQueuedMessages?: SessionChatInputProps['failedQueuedMessages'];
  queueInFlightId?: SessionChatInputProps['queueInFlightId'];
  queuePaused?: SessionChatInputProps['queuePaused'];
  onResumeQueue?: SessionChatInputProps['onResumeQueue'];
  onQueueMessage?: (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onEditQueuedMessage?: (id: string, text: string) => void;
  onReorderQueuedMessage?: (id: string, toIndex: number) => void;
  onRetryQueuedMessage?: (id: string) => void;
  /** Reports the effective agent to parent controls such as the sandbox picker. */
  onAgentSelectionChange?: (agentName: string | null) => void;
}) {
  const { data: agents } = useRuntimeAgents({ projectId });
  const { data: providers, isLoading: providersLoading } = useRuntimeProviders();
  const { data: commands } = useRuntimeCommands();
  const { data: config } = useRuntimeConfig();
  const projectConfig = useProjectConfig(projectId);
  const local = useSessionModelSelection({
    agents,
    providers,
    config,
    sessionId,
    boundAgentName,
    defaultAgentName: projectConfig?.open_code_default_agent,
  });
  // Session agent-lock disabled (see KORTIX_ENFORCE_SESSION_AGENT_LOCK / session-chat.tsx):
  // the new-session picker is switchable; the chosen agent rides through on create.
  const SESSION_AGENT_LOCK_ENABLED: boolean = false;
  const lockedAgentName =
    isMetaAgentName(boundAgentName) || SESSION_AGENT_LOCK_ENABLED
      ? boundAgentName?.trim() || null
      : null;
  const selectedAgentName = lockedAgentName ?? local.agent.current?.name ?? null;

  useEffect(() => {
    onAgentSelectionChange?.(selectedAgentName);
  }, [onAgentSelectionChange, selectedAgentName]);

  const [newSessionScope, setNewSessionScope] = useState<{
    agentName: string | null;
    commit: SessionScopeCommit;
  } | null>(null);
  const handleCommittedScope = useCallback(
    (commit: SessionScopeCommit | undefined) => {
      setNewSessionScope(commit ? { agentName: selectedAgentName, commit } : null);
    },
    [selectedAgentName],
  );
  const sessionScopeToolbar = useMemo(
    () =>
      projectId ? (
        <SessionScopeToolbar
          projectId={projectId}
          sessionId={sessionId}
          agentName={selectedAgentName ?? undefined}
          onCommittedDraft={sessionId ? undefined : handleCommittedScope}
        />
      ) : null,
    [handleCommittedScope, projectId, selectedAgentName, sessionId],
  );
  const combinedToolbarSlot = useMemo(
    () =>
      toolbarSlot || sessionScopeToolbar ? (
        <>
          {toolbarSlot}
          {sessionScopeToolbar}
        </>
      ) : undefined,
    [sessionScopeToolbar, toolbarSlot],
  );

  // Read at send-time so the latest selections are captured.
  const options = (): ComposerOptions => {
    const o: ComposerOptions = {};
    if (lockedAgentName) o.agent = lockedAgentName;
    else if (local.agent.current) o.agent = local.agent.current.name;
    if (local.model.currentKey) o.model = local.model.currentKey;
    if (local.model.variant.current) o.variant = local.model.variant.current;
    if (!sessionId && newSessionScope && newSessionScope.agentName === selectedAgentName) {
      o.scope = newSessionScope.commit;
    }
    return o;
  };

  return (
    <SessionChatInput
      onSend={(text, files) => onSend(text, files, options())}
      onCommand={onCommand ? (cmd, args) => onCommand(cmd, args, options()) : undefined}
      clearOnSend={clearOnSend}
      queuedMessages={queuedMessages}
      failedQueuedMessages={failedQueuedMessages}
      queueInFlightId={queueInFlightId}
      queuePaused={queuePaused}
      onResumeQueue={onResumeQueue}
      onQueueMessage={onQueueMessage}
      onRemoveQueuedMessage={onRemoveQueuedMessage}
      onEditQueuedMessage={onEditQueuedMessage}
      onReorderQueuedMessage={onReorderQueuedMessage}
      onRetryQueuedMessage={onRetryQueuedMessage}
      isBusy={isBusy}
      stopDisabled={stopDisabled}
      isSending={isSending}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      prefill={prefill}
      inputSlot={inputSlot}
      toolbarSlot={combinedToolbarSlot}
      cardClassName={cardClassName}
      sessionId={sessionId}
      projectId={projectId}
      providers={providers}
      agents={local.agent.list}
      selectedAgent={selectedAgentName}
      onAgentChange={
        // The selectedAgentName effect above notifies the parent; no inline call.
        lockedAgentName ? undefined : (name) => local.agent.set(name ?? undefined)
      }
      agentSelectorLocked={!!lockedAgentName}
      models={local.model.list}
      selectedModel={local.model.currentKey ?? null}
      onModelChange={(m) => local.model.set(m ?? undefined, { recent: true })}
      modelRequired
      modelsLoading={providersLoading}
      variants={local.model.variant.list}
      selectedVariant={local.model.variant.current ?? null}
      onVariantChange={(v) => local.model.variant.set(v ?? undefined)}
      commands={commands || []}
    />
  );
}
