import type { ProjectIconValue } from '../projects/modal/project-icon-field';
import { githubSourceReady } from './github-source';
import { validateWorkspaceName } from './workspace-name';

export type RepositorySource = 'managed' | 'github-create' | 'github-import';

export interface NewWorkspaceFormState {
  name: string;
  icon: ProjectIconValue;
  source: RepositorySource;
  defaultBranch: string;
  templateId: string | null;
  /**
   * The account whose GitHub connection the GitHub sources use
   * (`githubSourceAccount`): their installations are account-scoped. The
   * server still makes a new workspace for the create. Null for the managed
   * source, which sends `new_workspace: true`. There is no account picker: a
   * workspace is one account and its project.
   */
  accountId: string | null;
  /**
   * The GitHub App installation the two GitHub sources act through — the
   * `installation_id` both `POST /projects/create-repo` and
   * `POST /projects/link-repository` require. Null for `managed`, which needs
   * no GitHub account at all.
   */
  installationId: string | null;
  /** `owner/repo`, for `github-import` only. Null for the other two sources. */
  repoFullName: string | null;
}

/**
 * `managed` is the default because `projects.repo_url` is NOT NULL — every
 * workspace has a repo, and a name-only create has to choose one. Kortix
 * managing it is the only option that needs no GitHub account and no
 * repo-name uniqueness.
 */
export const INITIAL_FORM_STATE: NewWorkspaceFormState = {
  name: '',
  icon: null,
  source: 'managed',
  defaultBranch: 'main',
  templateId: null,
  accountId: null,
  installationId: null,
  repoFullName: null,
};

export function isSubmittable(state: NewWorkspaceFormState): boolean {
  if (!validateWorkspaceName(state.name).ok) return false;
  // The two GitHub sources need inputs `managed` does not: an installation for
  // both, and a repository for `github-import`. Gated HERE, so what blocks
  // submit is a MISSING input, the same as an empty name — never the choice.
  if (!githubSourceReady(state)) return false;
  // A GitHub source names the account its installation lives in. The managed
  // source needs none: the server creates the account.
  if (state.source !== 'managed' && !state.accountId) return false;
  return true;
}

/**
 * The request body for `POST /v1/projects/provision` with `new_workspace:
 * true` (the caller adds it): the server picks the account, so no
 * `account_id` is sent.
 *
 * Keys are omitted rather than sent as null: the API treats an absent icon key
 * as "no icon" and normalises invalid values by dropping them, so sending
 * `icon: null` and omitting it mean the same thing to the server but only the
 * omission is unambiguous to a reader of the network tab.
 *
 * `icon` and `icon_glyph` are NEVER both present. The union type makes that
 * unrepresentable here, which is why the icon is one field and not two nullable
 * slots.
 */
export function buildProvisionPayload(state: NewWorkspaceFormState): Record<string, unknown> {
  const validated = validateWorkspaceName(state.name);
  const payload: Record<string, unknown> = {
    name: validated.ok ? validated.name : state.name.trim(),
    seed_starter: true,
    default_branch: state.defaultBranch,
  };

  if (state.icon && 'emoji' in state.icon) payload.icon = state.icon.emoji;
  else if (state.icon && 'glyph' in state.icon) payload.icon_glyph = state.icon.glyph;

  if (state.templateId) payload.source_item_id = state.templateId;

  return payload;
}
