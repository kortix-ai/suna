/**
 * `/new?source=github-import` — which repository source the form opens on.
 *
 * Exists for one flow: a user picks a GitHub source, has no GitHub account
 * connected yet, and follows the link to `/github/setup`. That is a real
 * navigation, so the in-progress form state is gone when they come back. The
 * setup page returns them to whatever path `rememberGitHubSetupReturn` stored,
 * so `advanced-fields.tsx` stores `/new?source=<their choice>` and this reads
 * it back — otherwise they land on a form reset to `managed` and have to
 * rediscover the option that sent them away.
 *
 * Unknown and absent values both resolve to `null`, and the caller keeps its
 * own default. An unvalidated pass-through would let `?source=anything` put
 * the form in a state `isSubmittable` has no branch for.
 */
import type { RepositorySource } from './new-workspace-form';

const SOURCES: readonly RepositorySource[] = ['managed', 'github-create', 'github-import'];

export function readSourceParam(params: URLSearchParams): RepositorySource | null {
  const raw = params.get('source')?.trim();
  if (!raw) return null;
  return SOURCES.find((source) => source === raw) ?? null;
}

/** The path `/github/setup` should return to, preserving the picked source. */
export function newWorkspaceReturnPath(source: RepositorySource): string {
  return source === 'managed' ? '/new' : `/new?source=${encodeURIComponent(source)}`;
}
