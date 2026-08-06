import type { ProjectIconValue } from '@/features/projects/modal/project-icon-field';
import { validateWorkspaceName } from '@/features/workspace/new/workspace-name';

export type RepositorySource = 'managed' | 'github-create' | 'github-import';

export interface NewWorkspaceFormState {
  name: string;
  icon: ProjectIconValue;
  source: RepositorySource;
  defaultBranch: string;
  templateId: string | null;
  /** Null means "the user has exactly one account, so there is nothing to pick". */
  accountId: string | null;
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
};

export function isSubmittable(state: NewWorkspaceFormState, accountCount: number): boolean {
  if (!validateWorkspaceName(state.name).ok) return false;
  // With one account there is nothing to disambiguate, so the picker is not
  // rendered and `accountId` stays null legitimately.
  if (accountCount > 1 && !state.accountId) return false;
  return true;
}

/**
 * The request body for `POST /v1/projects/provision`.
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
  if (state.accountId) payload.account_id = state.accountId;

  return payload;
}
