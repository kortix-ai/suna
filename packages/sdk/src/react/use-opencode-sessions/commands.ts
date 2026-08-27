'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Command } from '@opencode-ai/sdk/v2/client';
import { opencodeKeys, useOpenCodeRosterReady } from './keys';
import { unwrap, asRuntimeList, cachedRuntimeList, setLSCache, LS_COMMANDS } from './shared';

// ============================================================================
// Command Hooks
// ============================================================================

/**
 * The session's slash commands.
 *
 * Always resolves an ARRAY. `GET /command` is typed `Command[]`, but a runtime
 * or proxy that answers with an object body used to hand that value straight
 * to the render, where `for (const cmd of commands)` threw
 * `TypeError: t is not iterable` and killed the whole session view (dev,
 * 2026-08-23). `asRuntimeList` normalizes the response and `cachedRuntimeList`
 * treats a corrupt localStorage placeholder as a miss, so every consumer
 * (`detectCommandFromText`, the slash menu, command attachments) can iterate
 * the result unconditionally.
 */
export function useOpenCodeCommands() {
  const rosterReady = useOpenCodeRosterReady();
  return useQuery<Command[]>({
    queryKey: opencodeKeys.commands(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.command.list();
      const commands = asRuntimeList<Command>(unwrap(result));
      setLSCache(LS_COMMANDS, commands);
      return commands;
    },
    placeholderData: () => cachedRuntimeList<Command>(LS_COMMANDS),
    enabled: rosterReady,
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
