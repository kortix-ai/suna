'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { getEnv } from '@/lib/env-config';
import { getKortixCliInstallCommand } from '@/lib/kortix-cli';
import { getProjectDetail, type KortixProject, type ProjectGitConnection } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, GitBranch, GitFork, Github, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import CustomizeSectionWrapper from '../component/section-wrapper';
import { providerLabel, repositoryWebUrl } from './git-view-helpers';

type ProjectWithOrigin = KortixProject & { git_origin_url?: string };

function proxyUrl(project: ProjectWithOrigin): string {
  if (project.git_origin_url) return project.git_origin_url;
  const configured = getEnv().BACKEND_URL.replace(/\/+$/, '');
  const base = configured.startsWith('http')
    ? configured
    : `${typeof window === 'undefined' ? '' : window.location.origin}${configured}`;
  const versioned = base.endsWith('/v1') ? base : `${base}/v1`;
  return `${versioned}/git/${project.project_id}.git`;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      successToast(`${label} copied`);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      errorToast(`Could not copy ${label.toLowerCase()}`);
    }
  };

  return (
    <div className="border-border bg-muted/40 flex min-w-0 items-center gap-2 rounded-md border px-3 py-2.5">
      <code className="text-foreground min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
        {value}
      </code>
      <Hint label={copied ? 'Copied' : `Copy ${label}`}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 shrink-0 transition-transform active:scale-[0.96]"
          onClick={copy}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
        >
          <span className="relative inline-flex size-3.5 items-center justify-center">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={copied ? 'check' : 'copy'}
                initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="absolute inset-0 inline-flex items-center justify-center"
              >
                {copied ? (
                  <Check className="text-kortix-green size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </motion.span>
            </AnimatePresence>
          </span>
        </Button>
      </Hint>
    </div>
  );
}

function ConnectionSummary({
  connection,
}: {
  connection: ProjectGitConnection | null | undefined;
}) {
  const connected = connection?.status === 'connected';
  const webUrl = connection?.repo_url
    ? repositoryWebUrl(connection.provider, connection.repo_url)
    : null;
  return (
    <div className="divide-border divide-y overflow-hidden rounded-md border">
      <SummaryRow
        label="Provider"
        value={providerLabel(connection?.provider)}
        icon={<GitFork className="size-4" />}
      />
      <SummaryRow
        label="Repository"
        value={
          connection?.repo_owner && connection.repo_name
            ? `${connection.repo_owner}/${connection.repo_name}`
            : connection?.repo_url || 'Repository'
        }
        icon={
          connection?.provider === 'github' ? (
            <Github className="size-4" />
          ) : (
            <GitFork className="size-4" />
          )
        }
        href={webUrl}
      />
      <SummaryRow
        label="Default branch"
        value={connection?.default_branch || 'main'}
        icon={<GitBranch className="size-4" />}
      />
      <div className="flex items-center justify-between gap-4 px-3.5 py-3">
        <span className="text-muted-foreground text-sm">Connection health</span>
        <Badge variant={connected ? 'success' : 'secondary'} size="sm">
          {connected ? 'Connected' : connection?.status || 'Unknown'}
        </Badge>
      </div>
      {connection?.last_error_message ? (
        <div className="bg-destructive/5 text-destructive px-3.5 py-3 text-sm">
          {connection.last_error_message}
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow({
  label,
  value,
  icon,
  href,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  href?: string | null;
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground w-28 shrink-0 text-sm">{label}</span>
      {href?.startsWith('http') ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-foreground ml-auto flex min-w-0 items-center gap-1.5 truncate text-sm font-medium hover:underline"
        >
          <span className="truncate">{value}</span>
          <ExternalLink className="size-3.5 shrink-0" />
        </a>
      ) : (
        <span className="text-foreground ml-auto min-w-0 truncate text-sm font-medium">
          {value}
        </span>
      )}
    </div>
  );
}

export function GitView({ projectId }: { projectId: string }) {
  const installCommand = getKortixCliInstallCommand(getEnv().VERSION);
  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 30_000,
  });

  return (
    <CustomizeSectionWrapper
      title="Git"
      description="Repository hosting, authenticated local development, and synchronization."
    >
      {detail.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : null}
      {detail.isError ? (
        <ErrorState
          size="sm"
          title="Could not load Git settings"
          description={(detail.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => detail.refetch()}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          }
        />
      ) : null}
      {detail.data ? (
        <div className="space-y-8">
          <section className="space-y-3">
            <div>
              <h3 className="text-foreground text-sm font-medium">Repository</h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                The provider and repository backing every project session.
              </p>
            </div>
            <ConnectionSummary connection={detail.data.git_connection} />
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="text-foreground text-sm font-medium">Develop locally</h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Install the CLI, then clone through the authenticated Kortix proxy. Tokens are never
                saved in the URL or Git config.
              </p>
            </div>
            <CopyValue value={installCommand} label="Install command" />
            <CopyValue value={`kortix projects clone ${projectId}`} label="Clone command" />
            <p className="text-muted-foreground text-xs">
              Then run <code className="text-foreground font-mono">kortix init --force</code> and{' '}
              <code className="text-foreground font-mono">kortix env pull</code> inside the cloned
              directory.
            </p>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="text-foreground text-sm font-medium">Kortix proxy origin</h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Sessions and the Kortix CLI use this stable URL; Kortix resolves the current
                provider credential just in time.
              </p>
            </div>
            <CopyValue
              value={proxyUrl(detail.data.project as ProjectWithOrigin)}
              label="Proxy URL"
            />
          </section>

          <section className="border-border rounded-md border border-dashed px-4 py-3.5">
            <div className="flex items-start gap-3">
              <RefreshCw className="text-muted-foreground mt-0.5 size-4" />
              <div>
                <h3 className="text-foreground text-sm font-medium">Repository synchronization</h3>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  Continuous mirroring to another Git provider will be configured here. Your current
                  repository remains the source of truth.
                </p>
              </div>
              <Badge variant="secondary" size="sm" className="ml-auto shrink-0">
                Coming soon
              </Badge>
            </div>
          </section>
        </div>
      ) : null}
    </CustomizeSectionWrapper>
  );
}
