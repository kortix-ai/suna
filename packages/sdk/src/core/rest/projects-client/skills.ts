// Project skills — the model-free form path behind POST /v1/projects/:projectId/skills.

import { type ApiClientOptions, backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Body of `POST /v1/projects/:projectId/skills`. */
export interface CreateProjectSkillInput {
  /** Display name; the server derives the `skills/<slug>/` folder from it. */
  name: string;
  /** Frontmatter `description` — the agent-facing "load this when…" trigger. */
  description?: string;
  /** Markdown instructions; blank or omitted uses the starter template. */
  body?: string;
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

/** Whole-folder removal includes user edits; shared dependencies are never removed. */
export async function removeProjectSkill(
  projectId: string,
  input: { folder: string; confirm: true },
  options?: ApiClientOptions,
): Promise<{ ok: true; commitSha: string; removed: string[] }> {
  return unwrap(
    await backendApi.post<{ ok: true; commitSha: string; removed: string[] }>(
      `/projects/${projectId}/skills/remove`,
      input,
      { showErrors: false, ...options },
    ),
  );
}

/** One reference file a built-in skill carries: its path under the skill, its size, and its text with `full`. */
export interface BuiltinSkillReference {
  path: string;
  bytes: number;
  /** Present when the skill was read with `full: true`. */
  content?: string;
}

/**
 * A skill Kortix ships (`GET /v1/skills/:name`): its frontmatter description,
 * the full SKILL.md body an agent follows, the feature flag that gates it (or
 * null), and the reference files beside it. Not a file in the project's repo.
 */
export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
  featureFlag: string | null;
  references: BuiltinSkillReference[];
}

/**
 * Read one Kortix built-in skill by name. `full: true` also inlines every
 * reference file's text (large: `kortix-system` is ~230 KB). The caller shows
 * a failure itself.
 */
export async function getBuiltinSkill(
  name: string,
  options?: ApiClientOptions & { full?: boolean },
): Promise<BuiltinSkill> {
  const { full, ...request } = options ?? {};
  const path = `/skills/${encodeURIComponent(name)}${full ? '?full=1' : ''}`;
  return unwrap(await backendApi.get<BuiltinSkill>(path, { showErrors: false, ...request }));
}
