// Project starter-suggestions — the prompt chips shown before a project's
// first message. `GET /projects/:id/starter-suggestions` returns either a
// personalized set (generated from the account's signal bundle) or the
// static fallback set, never a client-side choice between the two.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** A setup step a suggestion may point at instead of (or alongside) a plain
 *  prompt — mirrors the API's `SuggestionAction` enum
 *  (`apps/api/src/projects/starter-suggestions/sanitize.ts`). */
export type StarterSuggestionAction =
  | 'connectors'
  | 'skills'
  | 'schedules'
  | 'agent'
  | 'members'
  | 'channels';

export interface StarterSuggestionsResponse {
  source: 'personalized' | 'static';
  generated_at: string | null;
  items: Array<{
    id: string;
    label: string;
    prompt: string;
    action?: StarterSuggestionAction;
  }>;
}

export async function getProjectStarterSuggestions(
  projectId: string,
): Promise<StarterSuggestionsResponse> {
  return unwrap(
    await backendApi.get<StarterSuggestionsResponse>(
      `/projects/${projectId}/starter-suggestions`,
    ),
  );
}
