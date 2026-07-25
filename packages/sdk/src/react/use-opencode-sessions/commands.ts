'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Command } from '@opencode-ai/sdk/v2/client';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import { unwrap, getLSCache, setLSCache, LS_COMMANDS } from './shared';

// ============================================================================
// Command Hooks
// ============================================================================

export function useOpenCodeCommands() {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Command[]>({
    queryKey: opencodeKeys.commands(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.command.list();
      const commands = unwrap(result);
      setLSCache(LS_COMMANDS, commands);
      return commands;
    },
    placeholderData: () => getLSCache<Command[]>(LS_COMMANDS),
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export interface ExecuteOpenCodeCommandInput {
  sessionId: string;
  command: string;
  args?: string;
  agent?: string;
  model?: string;
  variant?: string;
}

export async function executeOpenCodeCommand({
  sessionId,
  command,
  args,
  agent,
  model,
  variant,
}: ExecuteOpenCodeCommandInput): Promise<void> {
  const client = getClient();
  const result = await client.session.command({
    sessionID: sessionId,
    command,
    arguments: args || '',
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
  });
  unwrap(result);
}

export function useExecuteOpenCodeCommand() {
  return useMutation({
    mutationFn: executeOpenCodeCommand,
    // CRITICAL: Disable retry for commands. The /command endpoint blocks until
    // the agent finishes, which can take minutes (e.g. onboarding). If a proxy
    // timeout or network error kills the connection, TanStack Query's default
    // global retry would re-POST the command, causing it to execute twice on
    // the server. Commands are non-idempotent — each POST creates a new
    // execution. Never retry them.
    retry: false,
  });
}
