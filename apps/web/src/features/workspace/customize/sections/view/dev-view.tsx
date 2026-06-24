'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FormEvent, useState, type ComponentType, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { ErrorState } from '@/features/layout/section/error-state';
import { useCopy } from '@/hooks/use-copy';
import { getProject, inviteRepoCollaborator, isManagedGithubProject } from '@/lib/projects-client';
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
        <div className="space-y-5">
          <Skeleton className="h-40 rounded-md" />
          <Skeleton className="h-40 rounded-md" />
        </div>
      )}

      {projectQuery.isError && (
        <ErrorState
          size="sm"
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleCouldnfd7978fb',
          )}
          description={(projectQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => projectQuery.refetch()}>
              Retry
            </Button>
          }
        />
      )}

      {project && <DevSteps project={project} />}
    </CustomizeSectionWrapper>
  );
}

type DevStep = {
  title: string;
  hint?: string;
  content: ReactNode;
};

function DevSteps({ project }: { project: Awaited<ReturnType<typeof getProject>> }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const cloneUrl = cloneUrlFor(project.repo_url);
  const repoDir = repoDirFor(project.repo_url) || 'my-project';
  const managed = isManagedGithubProject(project);
  const branch = project.default_branch || 'main';

  const steps: DevStep[] = [];

  if (managed) {
    steps.push({
      title: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleGetd1e11afa',
      ),
      hint: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintThiseeeaf15f',
      ),
      content: <RepoAccessForm projectId={project.project_id} />,
    });
  }

  steps.push(
    {
      title: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleCloneeed535b5',
      ),
      hint: managed
        ? 'Once your invite is accepted, clone it like any other repo.'
        : 'You need read access to the repo to clone it.',
      content: <CommandBlock lines={[`git clone ${cloneUrl}`, `cd ${repoDir}`]} />,
    },
    {
      title: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleInstall5ee6d4a5',
      ),
      hint: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintManages9608753c',
      ),
      content: (
        <CommandBlock lines={['curl -fsSL https://kortix.com/install | bash', 'kortix login']} />
      ),
    },
    {
      title: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleSet0eb61991',
      ),
      hint: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintWires03f7d392',
      ),
      content: <CommandBlock lines={['kortix init --force']} />,
    },
    {
      title: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitlePull407b0e0e',
      ),
      hint: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintWritese14f4d88',
      ),
      content: <CommandBlock lines={['kortix env pull']} />,
    },
    {
      title: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleBuild28ec472e',
      ),
      hint: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintThisc4b92026',
      ),
      content: <Launchers />,
    },
    {
      title: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleShip32cd936f',
      ),
      hint: tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintOpen4938bb8e',
      ),
      content: (
        <>
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
            <code className="bg-muted text-foreground rounded-sm px-1 py-0.5 font-mono text-xs">
              {branch}
            </code>{' '}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsDevViewJsxTextThroughChange0501ea03',
            )}
          </p>
        </>
      ),
    },
  );

  return (
    <Stepper orientation="vertical" count={steps.length} className="flex w-full flex-col">
      {steps.map((step, index) => (
        <div key={step.title} className="flex gap-3.5">
          <StepperItem step={index + 1} completed className="items-center">
            <StepperTrigger asChild>
              <span className="flex shrink-0">
                <StepperIndicator className="size-7 text-sm font-semibold tabular-nums">
                  {index + 1}
                </StepperIndicator>
              </span>
            </StepperTrigger>
            <StepperSeparator className="bg-secondary m-0" />
          </StepperItem>
          <div className="min-w-0 flex-1 space-y-4 pt-0.5 pb-10">
            <div className="space-y-0">
              <StepperTitle className="text-foreground font-semibold">{step.title}</StepperTitle>
              {step.hint && (
                <StepperDescription className="text-sm leading-relaxed">
                  {step.hint}
                </StepperDescription>
              )}
            </div>
            {step.content}
          </div>
        </div>
      ))}
    </Stepper>
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
      successToast('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="group border-border bg-muted relative overflow-hidden rounded-md border">
      <pre className="scrollbar-hide overflow-x-auto px-3.5 py-3 pr-12 text-sm leading-relaxed">
        <code className="text-foreground font-mono">
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="min-w-0 break-all">{line}</span>
            </div>
          ))}
        </code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={copy}
        aria-label={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrAriaLabel36dfdacf',
        )}
        className="absolute top-1.5 right-1.5 size-8"
      >
        {copied ? <Check className="text-primary size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

type LauncherIcon = ComponentType<{ className?: string }>;

const LAUNCHERS: { label: string; command: string; icon: LauncherIcon }[] = [
  { label: 'Claude Code', command: 'claude', icon: Icon.Claude },
  { label: 'Cursor', command: 'cursor .', icon: Icon.Cursor },
  { label: 'Codex', command: 'codex', icon: Icon.Codex },
  { label: 'opencode', command: 'opencode', icon: Icon.OpenCode },
];

function Launchers() {
  const { copy } = useCopy();

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {LAUNCHERS.map(({ label, command, icon: LauncherIcon }) => (
        <button
          key={command}
          type="button"
          onClick={() => copy(command)}
          title={`Copy "${command}"`}
          aria-label={label}
          className="group border-border bg-popover hover:bg-muted flex aspect-square items-center justify-center rounded-md border transition-colors"
        >
          <LauncherIcon className="size-12 shrink-0" />
        </button>
      ))}
    </div>
  );
}

function RepoAccessForm({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [username, setUsername] = useState('');

  const invite = useMutation({
    mutationFn: () => inviteRepoCollaborator(projectId, username.trim(), 'write'),
    onSuccess: (res) => {
      if (res.alreadyCollaborator) {
        successToast(`@${res.username} already has access to this repo`);
      } else {
        successToast(`Invite sent to @${res.username} — accept it on GitHub`);
      }
      setUsername('');
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add collaborator'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim() && !invite.isPending) invite.mutate();
  };

  return (
    <form className="space-y-2" onSubmit={submit}>
      <Label htmlFor="dev-github-username" className="sr-only">
        GitHub username
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <GithubMark className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            id="dev-github-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsDevViewJsxAttrPlaceholderYoure78e16b1',
            )}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="pl-9"
            variant="popover"
          />
        </div>
        <Button type="submit" className="shrink-0" disabled={!username.trim() || invite.isPending}>
          {invite.isPending ? <Loading className="size-3.5 animate-spin" /> : null}
          {tI18nHardcoded.raw('autoComponentsProjectsCustomizeSectionsDevViewJsxTextAddMedc5ab441')}
        </Button>
      </div>
    </form>
  );
}

function GithubMark({ className }: { className?: string }) {
  return (
    <img
      src="https://www.google.com/s2/favicons?domain=github.com&sz=64"
      alt=""
      aria-hidden
      className={cn('rounded-sm', className)}
    />
  );
}

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

function repoDirFor(repoUrl: string | null | undefined): string {
  const normalized = repoUrl
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!normalized) return '';
  const last = normalized.split(/[/:]/).pop() ?? '';
  return last;
}
