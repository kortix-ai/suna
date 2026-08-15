'use client';

import { useQuery } from '@tanstack/react-query';
import {
  getProjectStarterSuggestions,
  type StarterSuggestionsResponse,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Personalized-or-static prompt-chip suggestions shown before a project's
 * first message. Thin React Query binding over
 * `projects-client/starter-suggestions.ts`. `source` on the response tells
 * the caller whether the set is personalized or the static fallback — the
 * hook never chooses between the two, the server already did.
 */
export function useProjectStarterSuggestions(projectId: string | null | undefined) {
  return useQuery<StarterSuggestionsResponse>({
    queryKey: qk.project.starterSuggestions(projectId ?? ''),
    queryFn: () => getProjectStarterSuggestions(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
}
