/**
 * The two GitHub-backed repository sources on `/new`, as pure functions.
 *
 * `/new` shipped with `github-create` and `github-import` present in the
 * Select but `disabled`, and `canSubmit` additionally required
 * `source === 'managed'` — so both were dead options with an apology under
 * them. Nothing was missing on the server: `POST /projects/create-repo` and
 * `POST /projects/link-repository` (`apps/api/src/projects/routes/project-from-repository.ts`) are
 * live, and `createProjectRepo` / `linkRepository` are exported from
 * `@kortix/sdk`. Only the client wiring was gone, deleted with
 * `project-create-modal.tsx` in #6276.
 *
 * The payload shapes below are the ones those two routes actually read; each
 * field is commented with the route line that consumes it, because the two
 * routes disagree in ways that are easy to get wrong (see `repoSlugFromName`
 * and the `default_branch` note on `buildLinkRepositoryPayload`).
 */

import type { CreateProjectRepoInput, LinkRepositoryInput } from '@kortix/sdk';
import type { NewWorkspaceFormState, RepositorySource } from './new-workspace-form';

/** True for the two sources that act through a GitHub App installation. */
export function isGitHubSource(source: RepositorySource): boolean {
  return source === 'github-create' || source === 'github-import';
}

/**
 * The branch a `managed` workspace defaults to. Kept here beside the switch
 * that restores it rather than read back off `INITIAL_FORM_STATE`, which would
 * make this module depend on that object's runtime value purely to recover one
 * string.
 */
const MANAGED_DEFAULT_BRANCH = 'main';

/**
 * Switch the repository source, clearing what the previous source owned.
 *
 * A bare `{ ...state, source }` leaks state across the switch in two ways that
 * both end in a wrong create:
 *
 * 1. `installationId` / `repoFullName` survive into `managed`, where nothing
 *    reads them — harmless — but ALSO survive from `github-import` into
 *    `github-create`, where a repository the user picked to IMPORT would sit
 *    in state while the form creates a new one.
 * 2. `defaultBranch` survives out of `github-import` carrying the imported
 *    repository's branch (say `trunk`), and `managed` then provisions a brand
 *    new repo whose default branch is a name the user never chose for it.
 *
 * So the branch is restored to the managed default on any switch away from
 * `github-import`, and the two GitHub fields are cleared on every switch.
 */
export function withRepositorySource(
  state: NewWorkspaceFormState,
  source: RepositorySource,
): NewWorkspaceFormState {
  return {
    ...state,
    source,
    installationId: null,
    repoFullName: null,
    defaultBranch: state.source === 'github-import' ? MANAGED_DEFAULT_BRANCH : state.defaultBranch,
  };
}

/**
 * A workspace name turned into a GitHub repository name.
 *
 * `POST /projects/create-repo` validates `name` against
 * `/^[a-zA-Z0-9._-]+$/` (`project-from-repository.ts`) — no spaces — while a workspace name is
 * free text and routinely has them. The old create modal did this inline as
 * `values.name.trim().replace(/\s+/g, '-')`, which only covered spaces: a
 * name like `Ana's agents` still reached the route with an apostrophe and
 * came back 400. Every character outside GitHub's set collapses to a single
 * hyphen here instead.
 *
 * Leading and trailing `.`/`-`/`_` are trimmed: GitHub accepts them but they
 * produce repository names nobody would type, and a name of only punctuation
 * would otherwise reduce to a string of hyphens. A name with no usable
 * characters at all falls back to `workspace`; the route then auto-dedupes
 * (`workspace`, `workspace-2`, …) rather than failing.
 */
export function repoSlugFromName(name: string): string {
  const slug = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  return slug || 'workspace';
}

/**
 * `github.com/<owner>/<repo>` for the repository "Create in GitHub" would
 * make, or null while the owner is still unknown. Rendered under the source
 * picker so the derived slug is visible BEFORE the user presses Create —
 * `repoSlugFromName` can change the name they typed quite a lot, and finding
 * that out from the created repo is finding out too late.
 */
export function plannedRepoPath(ownerLogin: string | null, name: string): string | null {
  if (!ownerLogin) return null;
  return `github.com/${ownerLogin}/${repoSlugFromName(name)}`;
}

/**
 * Whether the GitHub-specific inputs for `state.source` are filled in.
 *
 * Both sources need an installation. Only `github-import` needs a repository:
 * `github-create` makes one. `managed` needs neither, and returns true so
 * callers can ask this unconditionally.
 */
export function githubSourceReady(state: NewWorkspaceFormState): boolean {
  if (state.source === 'managed') return true;
  if (!state.installationId) return false;
  if (state.source === 'github-import') return Boolean(state.repoFullName);
  return true;
}

/**
 * The icon key, as the create routes read it.
 *
 * Spread, never `icon: icon ?? undefined`: the key is absent from the JSON
 * entirely when nothing is picked, so each route keeps its own "no icon"
 * default instead of receiving an explicit null to interpret. Which key —
 * `icon` or `icon_glyph` — comes straight from which side of the union
 * `state.icon` holds, so no caller can ever send both. Same rule
 * `buildProvisionPayload` follows for the managed source.
 */
export function iconPayload(state: NewWorkspaceFormState): Record<string, unknown> {
  if (!state.icon) return {};
  if ('emoji' in state.icon) return { icon: state.icon.emoji };
  return { icon_glyph: state.icon.glyph };
}

/**
 * The request body for `POST /v1/projects/create-repo`.
 *
 * `name` is the GITHUB repository name and `project_name` is the Kortix
 * workspace name — two different fields the route reads separately
 * (`project-from-repository.ts`: `name` is charset-validated then passed to `createRepo`,
 * `project_name` falls back to `deriveProjectName(repo.full_name)`). Sending
 * only `name` was survivable in the old modal because its repo-name field WAS
 * the project name; here the user types a workspace name with spaces, so both
 * are sent and the workspace keeps the name that was typed.
 *
 * No `default_branch`. The route does not accept one — it reads
 * `repo.default_branch` off the repository GitHub just created (`project-from-repository.ts`) —
 * so `/new` hides the branch field for this source rather than collecting a
 * value that would be silently dropped.
 */
export function buildCreateRepoPayload(
  state: NewWorkspaceFormState,
  accountId: string | undefined,
): CreateProjectRepoInput {
  return {
    ...(accountId ? { account_id: accountId } : {}),
    name: repoSlugFromName(state.name),
    project_name: state.name.trim(),
    ...(state.installationId ? { installation_id: state.installationId } : {}),
    private: true,
    starter_template: 'general-knowledge-worker',
    ...(state.templateId ? { source_item_id: state.templateId } : {}),
    ...iconPayload(state),
  } as CreateProjectRepoInput;
}

/**
 * The request body for `POST /v1/projects/link-repository`.
 *
 * `default_branch` is sent, and that is deliberate rather than incidental.
 * `resolveImportedDefaultBranch` (`apps/api/src/projects/lib/git.ts`) uses
 * the repository's OWN default when the key is absent, and VALIDATES the
 * value against GitHub when it is present — 400 `Selected branch "x" does not
 * exist` otherwise. `/new` seeds `state.defaultBranch` from the picked
 * repository's `default_branch` the moment a repository is chosen
 * (`advanced-fields.tsx`), so the value sent is the repository's real default
 * unless the user deliberately typed another branch — in which case a
 * validated 400 is the correct answer, not a silent import onto the wrong
 * branch.
 */
export function buildLinkRepositoryPayload(
  state: NewWorkspaceFormState,
  accountId: string | undefined,
): LinkRepositoryInput {
  const name = state.name.trim();
  const branch = state.defaultBranch.trim();
  return {
    ...(accountId ? { account_id: accountId } : {}),
    ...(state.installationId ? { installation_id: state.installationId } : {}),
    ...(state.repoFullName ? { repo_full_name: state.repoFullName } : {}),
    ...(name ? { name } : {}),
    ...(branch ? { default_branch: branch } : {}),
    ...iconPayload(state),
  };
}

/**
 * Apply a repository choice from the `/new` list — source and GitHub owner in
 * one update.
 *
 * Delegates the clearing rules to `withRepositorySource` so a switch cannot
 * leak a repository or a branch across sources, then sets the installation the
 * chosen owner is reached through.
 */
export function withRepositoryChoice(
  state: NewWorkspaceFormState,
  choice: { kind: RepositorySource; installationId: string | null },
): NewWorkspaceFormState {
  return { ...withRepositorySource(state, choice.kind), installationId: choice.installationId };
}

/**
 * True when the `managed` source is importing an existing managed repository
 * rather than provisioning a new one.
 *
 * `repoFullName` is null for every ordinary managed create — `/new` only ever
 * sets it under `managed` through the operator-only managed-import picker — so
 * its presence IS the distinction, and no fourth `RepositorySource` value is
 * needed for a case that shares the source's meaning.
 */
export function isManagedImport(state: NewWorkspaceFormState): boolean {
  return state.source === 'managed' && Boolean(state.repoFullName);
}

/**
 * The request body for importing a repository the managed-git owner already
 * holds: `link-repository`, through the managed credentials rather than a
 * per-account GitHub App installation.
 */
export function buildManagedImportPayload(
  state: NewWorkspaceFormState,
  accountId: string | undefined,
): LinkRepositoryInput {
  // `source: 'managed'` is the explicit selector; a managed choice carries no
  // installation id (`withRepositoryChoice` clears it), so the two can never
  // both reach the route.
  return { ...buildLinkRepositoryPayload(state, accountId), source: 'managed' };
}
