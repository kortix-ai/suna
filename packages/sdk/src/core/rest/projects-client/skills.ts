// Project skills — create a skill file on the project repo's default branch.
//
// The dashboard's Skills "New" control has two ways in: a configure chat
// session (needs a model) and this direct form path (needs no model), so a
// free account without a paid model can still create a skill.

import { type ApiClientOptions, backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Body of `POST /v1/projects/:projectId/skills`. */
export interface CreateProjectSkillInput {
  /** Display name; the server derives the `skills/<slug>/` folder from it. */
  name: string;
  /** Frontmatter `description` — the agent-facing "load this when…" trigger. */
  description?: string;
}

/** A committed skill: where it lives in the repo and the slug it got. */
export interface CreatedProjectSkill {
  ok: true;
  /** The derived folder slug (also the skill's stable id). */
  slug: string;
  /** The committed file path, relative to the repo root. */
  path: string;
}

export async function createProjectSkill(
  projectId: string,
  input: CreateProjectSkillInput,
  options?: ApiClientOptions,
): Promise<CreatedProjectSkill> {
  // `showErrors: false`: the create modal renders this failure inline, with
  // its own wording, instead of the global handler toasting it too.
  return unwrap(
    await backendApi.post<CreatedProjectSkill>(`/projects/${projectId}/skills`, input, {
      showErrors: false,
      ...options,
    }),
  );
}
