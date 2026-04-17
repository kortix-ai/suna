/**
 * useCompactSession — triggers session compaction via the OpenCode summarize API.
 *
 * Mirrors the frontend's useSummarizeOpenCodeSession():
 *  1. Resolve providerID/modelID from config → session messages → provider list
 *  2. POST /session/{id}/summarize
 *  3. SSE `session.compacted` event handles message rehydration
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { opencodeFetch } from './use-opencode-data';
import { platformKeys } from '@/lib/platform/hooks';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';
import { useCompactionStore } from '@/stores/compaction-store';

interface CompactParams {
  sandboxUrl: string;
  sessionId: string;
}

/**
 * Resolve the provider and model to use for summarization.
 * Follows the same fallback chain as the frontend:
 *  1. Config default model (e.g. "cortix/minimax-m27")
 *  2. Latest assistant message's model
 *  3. First available model from connected providers
 */
async function resolveModel(sandboxUrl: string, sessionId: string): Promise<{ providerID: string; modelID: string }> {
  // 1. Try config default model
  try {
    // Read /global/config so the model default survives sandbox dispose.
    // Matches web aa7ed87.
    const config = await opencodeFetch<any>(sandboxUrl, '/global/config');
    if (config?.model) {
      const parts = (config.model as string).split('/');
      if (parts.length >= 2) {
        const result = { providerID: parts[0], modelID: parts.slice(1).join('/') };
        log.log(`[Compact] Resolved model from config: ${result.providerID}/${result.modelID}`);
        return result;
      }
    }
  } catch (e) {
    log.log(`[Compact] Config model resolution failed: ${e}`);
  }

  // 2. Try latest assistant message
  try {
    const msgs = await opencodeFetch<any[]>(sandboxUrl, `/session/${sessionId}/message`);
    if (msgs && Array.isArray(msgs)) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]?.info;
        if (m?.role === 'assistant' && m.providerID && m.modelID) {
          log.log(`[Compact] Resolved model from session messages: ${m.providerID}/${m.modelID}`);
          return { providerID: m.providerID, modelID: m.modelID };
        }
      }
    }
  } catch (e) {
    log.log(`[Compact] Session message model resolution failed: ${e}`);
  }

  // 3. Try first available provider/model
  try {
    const providers = await opencodeFetch<any>(sandboxUrl, '/provider');
    if (providers?.all && Array.isArray(providers.all)) {
      const connectedSet = new Set(providers.connected || []);
      for (const provider of providers.all) {
        if (!connectedSet.has(provider.id)) continue;
        if (provider.models && typeof provider.models === 'object') {
          const firstModelId = Object.keys(provider.models)[0];
          if (firstModelId) {
            log.log(`[Compact] Resolved model from providers: ${provider.id}/${firstModelId}`);
            return { providerID: provider.id, modelID: firstModelId };
          }
        }
      }
    }
  } catch (e) {
    log.log(`[Compact] Provider model resolution failed: ${e}`);
  }

  throw new Error('No model available for compaction. Please configure a model in settings.');
}

export function useCompactSession() {
  const queryClient = useQueryClient();
  const startCompaction = useCompactionStore((s) => s.startCompaction);
  const stopCompaction = useCompactionStore((s) => s.stopCompaction);

  return useMutation({
    mutationFn: async ({ sandboxUrl, sessionId }: CompactParams) => {
      const { providerID, modelID } = await resolveModel(sandboxUrl, sessionId);

      log.log(`[Compact] Calling summarize for session ${sessionId} with ${providerID}/${modelID}`);

      // Use opencodeFetch which handles auth properly
      await opencodeFetch<boolean>(sandboxUrl, `/session/${sessionId}/summarize`, {
        method: 'POST',
        body: JSON.stringify({ providerID, modelID }),
      });

      log.log(`[Compact] Summarize call completed for session ${sessionId}`);
      return sessionId;
    },
    onMutate: ({ sessionId }) => {
      // Immediately show compacting UI
      startCompaction(sessionId);
    },
    onError: (_err, { sessionId }) => {
      stopCompaction(sessionId);
    },
    onSuccess: (sessionId) => {
      // SSE session.compacted event handles message/session rehydration + stopCompaction.
      // Invalidate as a safety net.
      queryClient.invalidateQueries({ queryKey: platformKeys.sessionMessages(sessionId) });
      queryClient.invalidateQueries({ queryKey: platformKeys.session(sessionId) });
    },
  });
}
