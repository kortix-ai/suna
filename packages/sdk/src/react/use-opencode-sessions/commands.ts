'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Command } from '../../core/runtime/runtime-types';
import { useRuntimeSupports } from '../use-runtime-supports';
import { runtimeKeys, useRuntimeReady } from './keys';
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
 *
 * Slash commands are a runtime capability (`session.commands`): a runtime
 * without them is never asked, and the list stays empty.
 */
export function useRuntimeCommands() {
  const runtimeReady = useRuntimeReady();
  const supported = useRuntimeSupports('session.commands');
  return useQuery<Command[]>({
    queryKey: runtimeKeys.commands(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.command.list();
      const commands = asRuntimeList<Command>(unwrap(result));
      setLSCache(LS_COMMANDS, commands);
      return commands;
    },
    placeholderData: () => cachedRuntimeList<Command>(LS_COMMANDS),
    enabled: runtimeReady && supported,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export interface ExecuteRuntimeCommandInput {
  sessionId: string;
  command: string;
  args?: string;
  agent?: string;
  model?: string;
  variant?: string;
}

export async function executeRuntimeCommand({
  sessionId,
  command,
  args,
  agent,
  model,
  variant,
}: ExecuteRuntimeCommandInput): Promise<void> {
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

export function useExecuteRuntimeCommand() {
  return useMutation({
    mutationFn: executeRuntimeCommand,
    // CRITICAL: Disable retry for commands. The /command endpoint blocks until
    // the agent finishes, which can take minutes (e.g. onboarding). If a proxy
    // timeout or network error kills the connection, TanStack Query's default
    // global retry would re-POST the command, causing it to execute twice on
    // the server. Commands are non-idempotent — each POST creates a new
    // execution. Never retry them.
    retry: false,
  });
}

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `ExecuteRuntimeCommandInput`. Removed in the next major. */
export type ExecuteOpenCodeCommandInput = ExecuteRuntimeCommandInput;
/** @deprecated Renamed to `executeRuntimeCommand`. Removed in the next major. */
export const executeOpenCodeCommand = executeRuntimeCommand;
/** @deprecated Renamed to `useRuntimeCommands`. Removed in the next major. */
export const useOpenCodeCommands = useRuntimeCommands;
/** @deprecated Renamed to `useExecuteRuntimeCommand`. Removed in the next major. */
export const useExecuteOpenCodeCommand = useExecuteRuntimeCommand;
