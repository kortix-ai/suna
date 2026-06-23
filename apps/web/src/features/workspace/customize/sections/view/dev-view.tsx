'use client';

import { useTranslations } from 'next-intl';
/**
 * Customize → Dev. The "work on this project from your own machine" guide.
 *
 * A project can be created entirely in the cloud — there's no implied CLI-first
 * setup — so this panel hands you the exact, copy-pasteable commands to clone
 * the repo, run the same agent locally, and ship changes back as a change
 * request. Every command is pre-filled with this project's real clone URL,
 * id, and default branch.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, Loader2, UserPlus } from 'lucide-react';
import { FormEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { getProject, inviteRepoCollaborator, isManagedGithubProject } from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import CustomizeSectionWrapper from '../component/section-wrapper';

export function DevView({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 20_000,
  });

  const project = projectQuery.data;

  return (
    <CustomizeSectionWrapper
      title={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxTextDevelopOn125f276d',
      )}
      description={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxTextThisProjectfee1f74b',
      )}
    >
      {projectQuery.isLoading && (
        <>
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </>
      )}

      {projectQuery.isError && (
        <SectionCard
          tone="destructive"
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleCouldnfd7978fb',
          )}
          description={(projectQuery.error as Error).message}
        />
      )}

      {project && <DevSteps project={project} />}
    </CustomizeSectionWrapper>
  );
}

function DevSteps({ project }: { project: Awaited<ReturnType<typeof getProject>> }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleGetd1e11afa',
          )}
          hint={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintThiseeeaf15f',
          )}
        >
          <RepoAccessForm projectId={project.project_id} />
        </Step>
      )}

      <Step
        n={next()}
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleCloneeed535b5',
        )}
        hint={
          managed
            ? 'Once your invite is accepted, clone it like any other repo.'
            : 'You need read access to the repo to clone it.'
        }
      >
        <CommandBlock lines={[`git clone ${cloneUrl}`, `cd ${repoDir}`]} />
      </Step>

      <Step
        n={next()}
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleInstall5ee6d4a5',
        )}
        hint={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintManages9608753c',
        )}
      >
        <CommandBlock lines={['curl -fsSL https://kortix.com/install | bash', 'kortix login']} />
      </Step>

      <Step
        n={next()}
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleSet0eb61991',
        )}
        hint={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintWires03f7d392',
        )}
      >
        <CommandBlock lines={['kortix init --force']} />
      </Step>

      <Step
        n={next()}
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitlePull407b0e0e',
        )}
        hint={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintWritese14f4d88',
        )}
      >
        <CommandBlock lines={['kortix env pull']} />
      </Step>

      <Step
        n={next()}
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleBuild28ec472e',
        )}
        hint={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintThisc4b92026',
        )}
      >
        <Launchers />
      </Step>

      <Step
        n={next()}
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleShip32cd936f',
        )}
        hint={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintOpen4938bb8e',
        )}
      >
        <CommandBlock
          lines={[
            'git checkout -b my-change',
            'git commit -am "Describe your change"',
            `git push origin HEAD`,
            'kortix cr open --title "Describe your change"',
          ]}
        />
        <p className="text-muted-foreground mt-2 text-xs">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsDevViewJsxTextBranchesMerge6cfcecc7',
          )}{' '}
          <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[0.7rem]">
            {branch}
          </code>{' '}
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsDevViewJsxTextThroughChange0501ea03',
          )}
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
      <div className="bg-primary/10 text-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums">
        {n}
      </div>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="space-y-1">
          <h3 className="text-foreground text-sm font-semibold">{title}</h3>
          {hint && <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

function CommandBlock({ lines }: { lines: string[] }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
    <div className="group border-border/60 bg-muted/40 relative overflow-hidden rounded-xl border">
      <pre className="overflow-x-auto px-3.5 py-3 pr-12 text-[0.8rem] leading-relaxed">
        <code className="text-foreground font-mono">
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span aria-hidden className="text-muted-foreground/50 pr-3 select-none">
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
        aria-label={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrAriaLabel36dfdacf',
        )}
        className={cn(
          'absolute top-2 right-2 flex size-7 items-center justify-center rounded-lg',
          'text-muted-foreground hover:bg-background hover:text-foreground transition-colors',
        )}
      >
        {copied ? <Check className="text-primary size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * The coding agents `kortix init` can wire the Kortix skill into. Each chip
 * copies the command that opens that agent in the current repo — pick whichever
 * one you configured and start building.
 */
const LAUNCHERS: { label: string; command: string }[] = [
  { label: 'Claude Code', command: 'claude' },
  { label: 'Cursor', command: 'cursor .' },
  { label: 'Codex', command: 'codex' },
  { label: 'opencode', command: 'opencode' },
];

function Launchers() {
  return (
    <div className="flex flex-wrap gap-2">
      {LAUNCHERS.map((l) => (
        <LauncherChip key={l.label} label={l.label} command={l.command} />
      ))}
    </div>
  );
}

function LauncherChip({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy "${command}"`}
      className="group border-border/60 bg-muted/40 hover:border-border hover:bg-muted flex items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-colors"
    >
      <span className="text-foreground text-sm font-medium">{label}</span>
      <code className="text-muted-foreground font-mono text-[0.7rem]">{command}</code>
      {copied ? (
        <Check className="text-primary size-3.5" />
      ) : (
        <Copy className="text-muted-foreground/60 group-hover:text-muted-foreground size-3.5 transition-colors" />
      )}
    </button>
  );
}

/**
 * Add a GitHub user as a collaborator on this project's managed repo, so they
 * can clone it. Mirrors the control in Settings → Repository — surfaced here as
 * step one of the local-dev flow, where you actually need it.
 */
function RepoAccessForm({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
    onError: (error: Error) => toast.error(error.message || 'Failed to add collaborator'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim() && !invite.isPending) invite.mutate();
  };

  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
      <div className="relative min-w-0 flex-1 basis-48">
        <GithubMark className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrPlaceholderYoure78e16b1',
          )}
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
        {tI18nHardcoded.raw('autoComponentsProjectsCustomizeSectionsDevViewJsxTextAddMedc5ab441')}
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
  const normalized = repoUrl
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!normalized) return 'git@github.com:owner/repo.git';

  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh?.[1] && ssh[2]) return `https://github.com/${ssh[1]}/${ssh[2]}.git`;

  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https?.[1] && https[2]) return `https://github.com/${https[1]}/${https[2]}.git`;

  return `${normalized}.git`;
}

/** The directory `git clone` drops you into — the repo name. */
function repoDirFor(repoUrl: string | null | undefined): string {
  const normalized = repoUrl
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!normalized) return '';
  const last = normalized.split(/[/:]/).pop() ?? '';
  return last;
}
