'use client';

import type { ReactNode } from 'react';

import { type AttachedFile, SessionChatInput } from '@/features/session/session-chat-input';
import { useRuntimeConfig } from '@/hooks/runtime/use-runtime-config';
import { type ModelKey, useRuntimeLocal } from '@/hooks/runtime/use-runtime-local';
import { useProjectConfig } from '@kortix/sdk/react';
import {
  type Command,
  useRuntimeAgents,
  useRuntimeCommands,
  useRuntimeProviders,
} from '@/hooks/runtime/use-runtime-sessions';

export interface ComposerOptions {
  agent?: string;
  model?: ModelKey;
  variant?: string;
}

/**
 * The canonical "compose a first message" input: {@link SessionChatInput}
 * pre-wired with the Runtime model / agent / variant / command selectors (the
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
}) {
  const { data: agents } = useRuntimeAgents({ projectId });
  const { data: providers, isLoading: providersLoading } = useRuntimeProviders();
  const { data: commands } = useRuntimeCommands();
  const { data: config } = useRuntimeConfig();
  const projectConfig = useProjectConfig(projectId);
  const local = useRuntimeLocal({
    agents,
    providers,
    config,
    sessionId,
    boundAgentName,
    defaultAgentName: projectConfig?.runtime_default_agent,
  });
  // Session agent-lock disabled (see KORTIX_ENFORCE_SESSION_AGENT_LOCK / session-chat.tsx):
  // the new-session picker is switchable; the chosen agent rides through on create.
  const SESSION_AGENT_LOCK_ENABLED: boolean = false;
  const lockedAgentName = SESSION_AGENT_LOCK_ENABLED ? boundAgentName?.trim() || null : null;

  // Read at send-time so the latest selections are captured.
  const options = (): ComposerOptions => {
    const o: ComposerOptions = {};
    if (lockedAgentName) o.agent = lockedAgentName;
    else if (local.agent.current) o.agent = local.agent.current.name;
    if (local.model.currentKey) o.model = local.model.currentKey;
    if (local.model.variant.current) o.variant = local.model.variant.current;
    return o;
  };

  return (
    <SessionChatInput
      onSend={(text, files) => onSend(text, files, options())}
      onCommand={onCommand ? (cmd, args) => onCommand(cmd, args, options()) : undefined}
      clearOnSend={clearOnSend}
      isBusy={isBusy}
      stopDisabled={stopDisabled}
      isSending={isSending}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      prefill={prefill}
      inputSlot={inputSlot}
      toolbarSlot={toolbarSlot}
      cardClassName={cardClassName}
      sessionId={sessionId}
      providers={providers}
      agents={local.agent.list}
      selectedAgent={lockedAgentName ?? local.agent.current?.name ?? null}
      onAgentChange={lockedAgentName ? undefined : (name) => local.agent.set(name ?? undefined)}
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
