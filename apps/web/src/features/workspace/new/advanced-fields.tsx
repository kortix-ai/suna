'use client';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { CaretRightIcon } from '@phosphor-icons/react';
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
 * "project" in the managed line only, the other two already say neither word.
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
 * repository — inputs `POST /projects/provision` does not accept. Those two
 * sources go through `POST /projects/create-repo` and the BYO-repo flow the
 * old create modal drives (`project-create-modal.tsx` `handleLinkGitHub` /
 * `githubCreateMutation`), which is out of scope for this task. Rather than
 * ship a half-built installation/repo picker that 400s against `/provision`,
 * this renders an honest note pointing at the real connect route
 * (`project-create-modal.tsx:561`, `router.push('/github/setup?account_id=…')`).
 * The full GitHub-source form on `/new` is its own follow-up.
 */
function GitHubSourceNote({ accountId }: { accountId: string | null }) {
  const href = accountId
    ? `/github/setup?account_id=${encodeURIComponent(accountId)}`
    : '/github/setup';

  return (
    <InfoBanner
      tone="neutral"
      title="Connect GitHub to use this source"
      action={
        <Button asChild variant="transparent" size="sm">
          <Link href={href}>Connect GitHub</Link>
        </Button>
      }
    >
      Creating and importing GitHub repositories happens on the GitHub connect page, not here.
      Connect an account there, then come back to finish this workspace.
    </InfoBanner>
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
    <Collapsible defaultOpen={false} className="mt-2">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex cursor-pointer items-center gap-1.5 text-sm transition-colors">
        <CaretRightIcon className="size-3.5 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]:rotate-90" />
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="workspace-source">Repository</Label>
          <Select
            value={state.source}
            onValueChange={(value) => onChange({ ...state, source: value as RepositorySource })}
          >
            <SelectTrigger id="workspace-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SOURCE_LABELS) as RepositorySource[]).map((source) => (
                <SelectItem key={source} value={source}>
                  {SOURCE_LABELS[source]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{SOURCE_DESCRIPTIONS[state.source]}</p>
        </div>

        {state.source !== 'managed' ? <GitHubSourceNote accountId={state.accountId} /> : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="workspace-branch">Default branch</Label>
          <Input
            id="workspace-branch"
            value={state.defaultBranch}
            onChange={(event) => onChange({ ...state, defaultBranch: event.target.value })}
            placeholder="main"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
