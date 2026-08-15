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
    /** A real, connectable catalog app the suggestion points at — present
     *  only when the API validated a model-named connector against its
     *  offered catalog for that run. Never present on the static fallback
     *  pool. Mirrors the API's enriched `connector` field
     *  (`apps/api/src/projects/starter-suggestions/sanitize.ts`). */
    connector?: { slug: string; name: string; img_src: string | null };
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
