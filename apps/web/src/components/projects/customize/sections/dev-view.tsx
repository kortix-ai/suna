'use client';

/**
 * Customize → Dev. The "work on this project from your own machine" guide.
 *
 * A project can be created entirely in the cloud — there's no implied CLI-first
 * setup — so this panel hands you the exact, copy-pasteable commands to clone
 * the repo, run the same agent locally, and ship changes back as a change
 * request. Every command is pre-filled with this project's real clone URL,
 * id, and default branch.
 */

import { FormEvent, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, Loader2, Terminal, UserPlus } from 'lucide-react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast';
import {
  getProject,
  inviteRepoCollaborator,
  isManagedGithubProject,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';

export function DevView({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CustomizeSectionHeader icon={Terminal} title="Dev" />
      <DevBody projectId={projectId} />
    </div>
  );
}

function DevBody({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 20_000,
  });

  const project = projectQuery.data;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
        <header className="space-y-1.5">
          <h2 className="text-lg font-semibold text-foreground">
            Develop on your own machine
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            This project lives in one git repo. Clone it, run the same agent
            locally, and send your changes back as a change request — the same
            way a cloud session does.
          </p>
        </header>

        {projectQuery.isLoading && (
          <>
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </>
        )}

        {projectQuery.isError && (
          <SectionCard
            tone="destructive"
            title="Couldn't load this project"
            description={(projectQuery.error as Error).message}
          />
        )}

        {project && <DevSteps project={project} />}
      </div>
    </div>
  );
}

function DevSteps({
  project,
}: {
  project: Awaited<ReturnType<typeof getProject>>;
}) {
  const cloneUrl = cloneUrlFor(project.repo_url);
  const repoDir = repoDirFor(project.repo_url) || 'my-project';
  const managed = isManagedGithubProject(project);
  const branch = project.default_branch || 'main';

  // Managed repos are private and Kortix-owned, so you can't clone until you're
  // added as a collaborator — that has to come first. Unmanaged repos you
  // already have access to, so we skip straight to cloning.
  let step = 0;
  const next = () => (step += 1);

  return (
    <div className="space-y-5">
      {managed && (
        <Step
          n={next()}
          title="Get access to the repo"
          hint="This repo is private and owned by Kortix. Add your GitHub account as a collaborator, then accept the invite GitHub emails you."
        >
          <RepoAccessForm projectId={project.project_id} />
        </Step>
      )}

      <Step
        n={next()}
        title="Clone the repo"
        hint={
          managed
            ? 'Once your invite is accepted, clone it like any other repo.'
            : 'You need read access to the repo to clone it.'
        }
      >
        <CommandBlock
          lines={[`git clone ${cloneUrl}`, `cd ${repoDir}`]}
        />
      </Step>

      <Step
        n={next()}
        title="Install the Kortix CLI"
        hint="Manages this project's secrets, sessions, and change requests from your terminal."
      >
        <CommandBlock
          lines={['curl -fsSL https://kortix.com/install | bash', 'kortix login']}
        />
      </Step>

      <Step
        n={next()}
        title="Link this folder to the project"
        hint="Writes .kortix/link.json so every kortix command in this repo targets this project."
      >
        <CommandBlock lines={[`kortix projects link ${project.project_id}`]} />
      </Step>

      <Step
        n={next()}
        title="Pull secrets"
        hint="Writes a .env with this project's secret names — fill in the values locally. Plaintext never leaves the cloud."
      >
        <CommandBlock lines={['kortix env pull']} />
      </Step>

      <Step
        n={next()}
        title="Run the agent locally"
        hint="Uses the same .kortix/opencode config that powers cloud sessions — identical agents, skills, and commands."
      >
        <CommandBlock lines={['opencode']} />
      </Step>

      <Step
        n={next()}
        title="Ship your changes back"
        hint="Open a change request, then review and merge it from the dashboard or with kortix cr merge."
      >
        <CommandBlock
          lines={[
            'git checkout -b my-change',
            'git commit -am "Describe your change"',
            `git push origin HEAD`,
            'kortix cr open --title "Describe your change"',
          ]}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Branches merge into{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.7rem] text-foreground">
            {branch}
          </code>{' '}
          through change requests — there's no other path to the main branch.
        </p>
      </Step>
    </div>
  );
}

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3.5">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold tabular-nums text-foreground">
        {n}
      </div>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {hint && (
            <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function CommandBlock({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join('\n');

  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/60 bg-muted/40">
      <pre className="overflow-x-auto px-3.5 py-3 pr-12 text-[0.8rem] leading-relaxed">
        <code className="font-mono text-foreground">
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span aria-hidden className="select-none pr-3 text-muted-foreground/50">
                $
              </span>
              <span className="min-w-0 break-all">{line}</span>
            </div>
          ))}
        </code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy command"
        className={cn(
          'absolute right-2 top-2 flex size-7 items-center justify-center rounded-lg',
          'text-muted-foreground transition-colors hover:bg-background hover:text-foreground',
        )}
      >
        {copied ? (
          <Check className="size-3.5 text-primary" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}

/**
 * Add a GitHub user as a collaborator on this project's managed repo, so they
 * can clone it. Mirrors the control in Settings → Repository — surfaced here as
 * step one of the local-dev flow, where you actually need it.
 */
function RepoAccessForm({ projectId }: { projectId: string }) {
  const [username, setUsername] = useState('');

  const invite = useMutation({
    mutationFn: () => inviteRepoCollaborator(projectId, username.trim(), 'write'),
    onSuccess: (res) => {
      if (res.alreadyCollaborator) {
        toast.success(`@${res.username} already has access to this repo`);
      } else {
        toast.success(`Invite sent to @${res.username} — accept it on GitHub`);
      }
      setUsername('');
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Failed to add collaborator'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim() && !invite.isPending) invite.mutate();
  };

  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
      <div className="relative min-w-0 flex-1 basis-48">
        <GithubMark className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Your GitHub username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="pl-9"
        />
      </div>
      <Button
        type="submit"
        size="lg"
        className="shrink-0 gap-1.5"
        disabled={!username.trim() || invite.isPending}
      >
        {invite.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <UserPlus className="size-3.5" />
        )}
        Add me
      </Button>
    </form>
  );
}

/** GitHub mark rendered from Google's favicon service. */
function GithubMark({ className }: { className?: string }) {
  return (
    <img
      src="https://www.google.com/s2/favicons?domain=github.com&sz=64"
      alt=""
      aria-hidden
      className={cn('rounded-[4px]', className)}
    />
  );
}

/**
 * Turn a stored repo URL into something you can `git clone`. GitHub web/SSH
 * URLs become an HTTPS clone URL; anything else is used as-is.
 */
function cloneUrlFor(repoUrl: string | null | undefined): string {
  const normalized = repoUrl?.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!normalized) return 'git@github.com:owner/repo.git';

  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh?.[1] && ssh[2]) return `https://github.com/${ssh[1]}/${ssh[2]}.git`;

  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https?.[1] && https[2]) return `https://github.com/${https[1]}/${https[2]}.git`;

  return `${normalized}.git`;
}

/** The directory `git clone` drops you into — the repo name. */
function repoDirFor(repoUrl: string | null | undefined): string {
  const normalized = repoUrl?.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!normalized) return '';
  const last = normalized.split(/[/:]/).pop() ?? '';
  return last;
}
