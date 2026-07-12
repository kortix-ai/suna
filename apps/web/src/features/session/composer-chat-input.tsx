'use client';

import type { ReactNode } from 'react';

import { type AttachedFile, SessionChatInput } from '@/features/session/session-chat-input';
import { useRuntimeConfig } from '@/hooks/runtime/use-runtime-config';
import { type ModelKey, useRuntimeLocal } from '@/hooks/runtime/use-runtime-local';
import {
  type Agent,
  type Command,
  useRuntimeAgents,
  useRuntimeProviders,
} from '@/hooks/runtime/use-runtime-sessions';
import { agentRequiresCatalogModel, useProjectConfig } from '@kortix/sdk/react';

export interface ComposerOptions {
  agent?: string;
  model?: ModelKey;
  variant?: string;
}

export function buildComposerOptions(input: {
  agent: Agent | undefined;
  lockedAgentName?: string | null;
  model?: ModelKey;
  variant?: string;
}): ComposerOptions {
  const options: ComposerOptions = {};
  const agentName = input.lockedAgentName?.trim() || input.agent?.name;
  if (agentName) options.agent = agentName;
  if (agentRequiresCatalogModel(input.agent) && input.model) options.model = input.model;
  if (input.variant) options.variant = input.variant;
  return options;
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
  const { data: config } = useRuntimeConfig();
  const projectConfig = useProjectConfig(projectId);
  const commands: Command[] = (projectConfig?.commands ?? []).map((command) => ({
    ...command,
    id: command.name,
  }));
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
  const catalogModelRequired = agentRequiresCatalogModel(local.agent.current);

  // Read at send-time so the latest selections are captured.
  const options = (): ComposerOptions => {
    return buildComposerOptions({
      agent: local.agent.current,
      lockedAgentName,
      model: local.model.currentKey,
      variant: local.model.variant.current,
    });
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
      models={catalogModelRequired ? local.model.list : []}
      selectedModel={catalogModelRequired ? (local.model.currentKey ?? null) : null}
      onModelChange={
        catalogModelRequired ? (m) => local.model.set(m ?? undefined, { recent: true }) : undefined
      }
      modelRequired={catalogModelRequired}
      modelsLoading={providersLoading}
      variants={local.model.variant.list}
      selectedVariant={local.model.variant.current ?? null}
      onVariantChange={(v) => local.model.variant.set(v ?? undefined)}
      commands={commands}
    />
  );
}
