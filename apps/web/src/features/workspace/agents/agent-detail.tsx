'use client';

/**
 * The detail half of the Agents master-detail split: one agent's identity, its
 * always-visible controls, the single Advanced disclosure, and its prompt
 * source.
 *
 * Previously this was TWO panes — a middle scroller for the source and a third
 * fixed rail for the cards. One column instead: the rail-inside-rail is gone,
 * the split is not.
 */

import { UnifiedMarkdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { splitFrontmatter } from '@/features/workspace/customize/shared/utils';
import {
  editConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { readProjectFile } from '@kortix/sdk';
import { Pencil } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

export interface AgentDetailEntry {
  name: string;
  path: string;
  description: string | null;
}

export function AgentDetail({
  projectId,
  agent,
  canWrite,
  meta,
  emptyBodyLabel = 'Agent body is empty. Add prompt content below the frontmatter.',
  children,
}: {
  projectId: string;
  agent: AgentDetailEntry;
  /** Read-only viewers (READ leaf, no WRITE) hide the "Edit" control. */
  canWrite: boolean;
  /** Badges rendered above the name — mode, source, default, disabled. */
  meta?: ReactNode;
  emptyBodyLabel?: string;
  /** The always-visible controls plus the single Advanced disclosure. */
  children?: ReactNode;
}) {
  const configure = useConfigureThread(projectId);
  const fileQuery = useQuery({
    queryKey: ['project-file-source', projectId, agent.path],
    queryFn: () => readProjectFile(projectId, agent.path),
    staleTime: 30_000,
  });

  const onCopy = async () => {
    if (!fileQuery.data?.content) return;
    try {
      await navigator.clipboard.writeText(fileQuery.data.content);
      successToast('Source copied');
    } catch {
      errorToast('Copy failed');
    }
  };

  const { body } = useMemo(
    () => splitFrontmatter(fileQuery.data?.content ?? ''),
    [fileQuery.data?.content],
  );

  const source = fileQuery.isLoading ? (
    <div className="space-y-2.5">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-10/12" />
      <Skeleton className="h-4 w-9/12" />
    </div>
  ) : fileQuery.isError ? (
    <InfoBanner
      tone="destructive"
      title="Couldn't load source"
      action={
        <Button variant="outline" size="sm" onClick={() => fileQuery.refetch()}>
          Retry
        </Button>
      }
    >
      {(fileQuery.error as Error)?.message ?? 'Failed to read source'}
    </InfoBanner>
  ) : body.trim() ? (
    <UnifiedMarkdown content={body} />
  ) : (
    <p className="text-muted-foreground/60 text-sm italic">{emptyBodyLabel}</p>
  );

  return (
    <div className="min-w-0 lg:h-full lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-8 lg:py-10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            {meta ? <div className="flex flex-wrap items-center gap-1.5">{meta}</div> : null}
            {/* h2: the screen's single h1 belongs to ProjectSectionPage. */}
            <h2 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
              {agent.name}
            </h2>
            {agent.description ? (
              <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed text-pretty">
                {agent.description}
              </p>
            ) : null}
            <p className="text-muted-foreground/50 truncate font-mono text-xs">{agent.path}</p>
          </div>
          <ButtonGroup className="shrink-0">
            {canWrite ? (
              <Hint label="Edit">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => configure.start(editConfigPrompt('agent', agent.name, agent.path))}
                  disabled={configure.pending}
                >
                  {configure.pending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <Pencil className="size-3.5 shrink-0" />
                  )}
                  Edit
                </Button>
              </Hint>
            ) : null}
            <Hint label="Copy source">
              <Button
                variant="outline"
                size="icon"
                onClick={onCopy}
                disabled={!fileQuery.data?.content}
              >
                <Copy className="size-3.5 shrink-0" />
              </Button>
            </Hint>
          </ButtonGroup>
        </div>

        {children ? <div className="space-y-3">{children}</div> : null}

        <div className="pt-2">{source}</div>
      </div>
    </div>
  );
}

export default AgentDetail;
