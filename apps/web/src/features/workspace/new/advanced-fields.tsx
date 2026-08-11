'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  NewWorkspaceFormState,
  RepositorySource,
} from '@/features/workspace/new/new-workspace-form';
import Link from 'next/link';

/**
 * Repository source is a disclosure, not a visible choice, because `managed`
 * is right for almost everyone and `projects.repo_url` being NOT NULL means
 * the decision cannot be skipped — only defaulted. Same call the old create
 * modal made (`project-create-modal.tsx:171`), kept collapsed by default here
 * so `/new` still opens as a single name field.
 *
 * Wording matches `project-create-modal.tsx:125-129` (`REPOSITORY_MODE_DESCRIPTIONS`)
 * so the two surfaces never diverge while both exist — "workspace" replaces
 * "workspace" in the managed line only, the other two already say neither word.
 */
const SOURCE_DESCRIPTIONS: Record<RepositorySource, string> = {
  managed: 'Kortix creates and manages a private repository for this workspace.',
  'github-create': 'Kortix creates a private repository in your GitHub account.',
  'github-import': 'Select an existing repository from your GitHub account.',
};

const SOURCE_LABELS: Record<RepositorySource, string> = {
  managed: 'Kortix managed',
  'github-create': 'Create in GitHub',
  'github-import': 'Import from GitHub',
};

/**
 * `github-create` and `github-import` need a GitHub App installation id and a
 * repository — inputs `POST /workspaces/provision` does not accept. Those two
 * sources go through `POST /workspaces/create-repo` and the BYO-repo flow the
 * old create modal drives (`project-create-modal.tsx` `handleLinkGitHub` /
 * `githubCreateMutation`), which is out of scope for this task.
 *
 * The copy below says only what `/github/setup` actually does: it verifies
 * and links a GitHub App installation (`saveGitHubInstallation`,
 * `linkGitHubInstallation`, `listLinkableGitHubInstallations` —
 * `app/(auth)/github/setup/page.tsx`). It does **not** create or import a
 * repository, so the note must not claim it does. It also makes no "come
 * back and finish" promise: the old modal's round trip
 * (`rememberGitHubSetupReturn` before navigating, `consumeGitHubSetupReturn`
 * on return — `project-create-modal.tsx:126-131,:561`) has no equivalent
 * here, a plain `<Link>` loses the in-progress form state on navigation, and
 * the modal that round trip lives in is itself deleted by a later task in
 * this plan. The full GitHub-source form on `/new` is its own follow-up.
 *
 * Rendered as plain text inside the existing field group, not a second
 * bordered surface: `InfoBanner`'s neutral tone is itself a bordered
 * `bg-popover` box, and this note already sits inside the page's own
 * `bg-popover rounded-md border` card (`new-workspace-page.tsx`) and inside
 * this disclosure's `CollapsibleContent` — a nested card reads as an insert,
 * not a sentence in the same field group as the description above it.
 */
function GitHubSourceNote({ accountId }: { accountId: string | null }) {
  const href = accountId
    ? `/github/setup?account_id=${encodeURIComponent(accountId)}`
    : '/github/setup';

  return (
    <p className="text-muted-foreground text-xs">
      Only Kortix-managed repositories can be created here for now. Choose Kortix managed to
      continue, or{' '}
      <Link href={href} className="text-foreground underline underline-offset-2">
        connect a GitHub account
      </Link>{' '}
      to prepare for repository-backed workspaces.
    </p>
  );
}

export function AdvancedFields({
  state,
  onChange,
}: {
  state: NewWorkspaceFormState;
  onChange: (next: NewWorkspaceFormState) => void;
}) {
  return (
    <>
      <div className="flex flex-col space-y-3">
        <Label htmlFor="workspace-source">Repository</Label>
        <Select
          value={state.source}
          onValueChange={(value) => onChange({ ...state, source: value as RepositorySource })}
        >
          <SelectTrigger id="workspace-source" className="w-full" size="md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SOURCE_LABELS) as RepositorySource[]).map((source) => (
              // `github-create`/`github-import` need inputs `/provision`
              // does not accept (see `GitHubSourceNote`'s doc comment
              // above) — `canSubmit` already refuses them. Disabling the
              // option here makes that constraint visible BEFORE the user
              // picks it, not only in the note that used to appear after —
              // same reasoning Task 12 applied one field up.
              <SelectItem key={source} value={source} disabled={source !== 'managed'}>
                {SOURCE_LABELS[source]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state.source !== 'managed' ? <GitHubSourceNote accountId={state.accountId} /> : null}
      </div>

      <div className="flex flex-col space-y-3">
        <Label htmlFor="workspace-branch">Default branch</Label>
        <Input
          id="workspace-branch"
          size="md"
          value={state.defaultBranch}
          onChange={(event) => onChange({ ...state, defaultBranch: event.target.value })}
          placeholder="main"
        />
      </div>
    </>
  );
}
