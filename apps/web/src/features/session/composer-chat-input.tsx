'use client';

import type { ReactNode } from 'react';

import {
  type AttachedFile,
  SessionChatInput,
} from '@/features/session/session-chat-input';
import { useOpenCodeConfig } from '@/hooks/opencode/use-opencode-config';
import { type ModelKey, useOpenCodeLocal } from '@/hooks/opencode/use-opencode-local';
import {
  type Command,
  useOpenCodeAgents,
  useOpenCodeCommands,
  useOpenCodeProviders,
} from '@/hooks/opencode/use-opencode-sessions';

export interface ComposerOptions {
  agent?: string;
  model?: ModelKey;
  variant?: string;
}

/**
 * The canonical "compose a first message" input: {@link SessionChatInput}
 * pre-wired with the OpenCode model / agent / variant / command selectors (the
 * four catalog queries + per-session selection state). Used by the home composer
 * and the instant session shell so neither hand-rolls the selector wiring.
 *
 * The current selections are handed to `onSend` / `onCommand` as `options`, so
 * callers never need their own `useOpenCodeLocal`.
 */
export function ComposerChatInput({
  onSend,
  onCommand,
  sessionId,
  projectId,
  isBusy,
  disabled,
  autoFocus,
  placeholder,
  prefill,
  inputSlot,
}: {
  onSend: (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => void;
  onCommand?: (command: Command, args: string | undefined, options: ComposerOptions) => void;
  sessionId?: string;
  projectId?: string;
  isBusy?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  prefill?: { text: string; id: number } | null;
  inputSlot?: ReactNode;
}) {
  const { data: agents } = useOpenCodeAgents({ projectId });
  const { data: providers } = useOpenCodeProviders();
  const { data: commands } = useOpenCodeCommands();
  const { data: config } = useOpenCodeConfig();
  const local = useOpenCodeLocal({ agents, providers, config, sessionId });

  // Read at send-time so the latest selections are captured.
  const options = (): ComposerOptions => {
    const o: ComposerOptions = {};
    if (local.agent.current) o.agent = local.agent.current.name;
    if (local.model.currentKey) o.model = local.model.currentKey;
    if (local.model.variant.current) o.variant = local.model.variant.current;
    return o;
  };

  return (
    <SessionChatInput
      onSend={(text, files) => onSend(text, files, options())}
      onCommand={onCommand ? (cmd, args) => onCommand(cmd, args, options()) : undefined}
      isBusy={isBusy}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      prefill={prefill}
      inputSlot={inputSlot}
      sessionId={sessionId}
      providers={providers}
      agents={local.agent.list}
      selectedAgent={local.agent.current?.name ?? null}
      onAgentChange={(name) => local.agent.set(name ?? undefined)}
      models={local.model.list}
      selectedModel={local.model.currentKey ?? null}
      onModelChange={(m) => local.model.set(m ?? undefined, { recent: true })}
      variants={local.model.variant.list}
      selectedVariant={local.model.variant.current ?? null}
      onVariantChange={(v) => local.model.variant.set(v ?? undefined)}
      commands={commands || []}
    />
  );
}
