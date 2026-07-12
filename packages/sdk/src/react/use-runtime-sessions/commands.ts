'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { createAcpClient } from '../../acp/client';
import { platformConfig } from '../../core/http/config';
import { getSessionRuntime } from '../../core/session/session-runtime-registry';
import { useCurrentRuntime } from '../use-current-runtime';
import type { Command } from '../../core/runtime/wire-types';
import { runtimeKeys, useRuntimeReady } from './keys';
import { unwrap, getLSCache, setLSCache, LS_COMMANDS } from './shared';

// ============================================================================
// Command Hooks
// ============================================================================

export function useRuntimeCommands() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Command[]>({
    queryKey: runtimeKeys.commands(),
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

export function useExecuteRuntimeCommand() {
  const projectId = useCurrentRuntime((state) => state.projectId);
  return useMutation({
    mutationFn: async ({
      sessionId,
      command,
      args,
    }: {
      sessionId: string;
      command: string;
      args?: string;
    }) => {
      if (!projectId) throw new Error('No active Kortix project');
      const runtime = getSessionRuntime(projectId, sessionId);
      if (!runtime?.runtimeSessionId) throw new Error('ACP session is not ready');
      const endpoint = `${platformConfig().backendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/acp`;
      const client = createAcpClient({ endpoint });
      await client.prompt(runtime.runtimeSessionId, [
        { type: 'text', text: `/${command}${args ? ` ${args}` : ''}` },
      ]);
    },
    // CRITICAL: Disable retry for commands. The /command endpoint blocks until
    // the agent finishes, which can take minutes (e.g. onboarding). If a proxy
    // timeout or network error kills the connection, TanStack Query's default
    // global retry would re-POST the command, causing it to execute twice on
    // the server. Commands are non-idempotent — each POST creates a new
    // execution. Never retry them.
    retry: false,
  });
}
