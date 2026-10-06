// Project skills — the model-free form path behind POST /v1/projects/:projectId/skills.

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
