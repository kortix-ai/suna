'use client';

import { useTranslations } from 'next-intl';

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { MarketplaceSectionButton } from '@/features/workspace/customize/marketplace-section-button';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { formatMode, splitFrontmatter } from '@/features/workspace/customize/shared/utils';
import {
  editConfigPrompt,
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import {
  getProjectDetail,
  readProjectFile,
  type ProjectConfigSummary,
} from '@/lib/projects-client';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  DangerTriangleSolid,
  ExternalLinkSolid,
  Pencil,
  Search,
  StarSolid,
} from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Copy, Plus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

type Agent = ProjectConfigSummary['agents'][number];

export function AgentsView({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const agents = detailQuery.data?.config?.agents ?? [];
  const defaultAgent = detailQuery.data?.config?.open_code_default_agent ?? null;
  const isForbidden =
    detailQuery.isError && /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) || (a.description?.toLowerCase().includes(q) ?? false),
    );
  }, [agents, query]);

  const configure = useConfigureThread(projectId);

  return (
    <CustomizeSectionWrapper
      title="Agents"
      description={tHardcodedUi.raw(
        'appProjectsIdCustomizeAgentsPage.line431JsxAttrDescriptionPickAnAgentFromTheListToPreview',
      )}
      docs="https://kortix.com/docs/concepts/agents"
      action={
        <div className="flex items-center gap-1.5">
          <MarketplaceSectionButton projectId={projectId} />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => configure.start(newConfigPrompt('agent'))}
            disabled={configure.pending}
          >
            {configure.pending ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <Plus className="size-4" />
            )}
            New
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <Search />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={tHardcodedUi.raw(
              'appProjectsIdCustomizeAgentsPage.line118JsxAttrPlaceholderSearchAgents',
            )}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>

        {detailQuery.isLoading ? (
          <div className="space-y-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-7 rounded-md" />
            ))}
          </div>
        ) : isForbidden ? (
          <InfoBanner
            icon={DangerTriangleSolid}
            title={tHardcodedUi.raw(
              'appProjectsIdCustomizeAgentsPage.line502JsxAttrTitleAccessRequired',
            )}
          >
            {tHardcodedUi.raw(
              'appProjectsIdCustomizeAgentsPage.line503JsxTextNoPermissionToReadThisRepo',
            )}
          </InfoBanner>
        ) : detailQuery.isError ? (
          <ErrorState
            size="sm"
            title={tHardcodedUi.raw('appProjectsIdCustomizeAgentsPage.line517JsxTextFailedToLoad')}
            description={(detailQuery.error as Error)?.message ?? 'Failed to load agents'}
            action={
              <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : agents.length === 0 ? (
          <EmptyState
            icon={Bot}
            size="sm"
            title={tHardcodedUi.raw(
              'appProjectsIdCustomizeAgentsPage.line452JsxAttrTitleNoAgentsYet',
            )}
            description="Create an agent to customize how sessions run."
            action={
              <div className="flex flex-col items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => configure.start(newConfigPrompt('agent'))}
                  disabled={configure.pending}
                >
                  {configure.pending ? (
                    <Loading className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Plus className="size-3.5 shrink-0" />
                  )}
                  {tHardcodedUi.raw(
                    'autoComponentsProjectsCustomizeSectionsAgentsViewJsxTextCreateAn48a275ca',
                  )}
                </Button>
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <Link
                    href="https://opencode.ai/docs/agents/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLinkSolid className="size-3.5 shrink-0" />
                    Docs
                  </Link>
                </Button>
              </div>
            }
          />
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tHardcodedUi.raw('appProjectsIdCustomizeAgentsPage.line440JsxTextNoMatchesFor')}{' '}
            <span className="text-foreground font-mono">{query}</span>.
          </p>
        ) : (
          <div className="space-y-2">
            {filtered.map((agent) => (
              <AgentDisclosure
                key={agent.path}
                projectId={projectId}
                agent={agent}
                isDefault={defaultAgent === agent.name}
              />
            ))}
          </div>
        )}
      </div>
    </CustomizeSectionWrapper>
  );
}

function AgentDisclosure({
  projectId,
  agent,
  isDefault,
}: {
  projectId: string;
  agent: Agent;
  isDefault: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Disclosure variant="outline" className="overflow-hidden" open={open} onOpenChange={setOpen}>
      <DisclosureTrigger variant="outline">
        <Button
          variant="ghost-input"
          className={cn('flex w-full items-center justify-start rounded-none')}
        >
          <span className="truncate text-sm font-medium">{agent.name}</span>
          {isDefault && (
            <StarSolid
              className={cn('ml-auto size-4 shrink-0 fill-current', 'text-kortix-orange')}
            />
          )}
        </Button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <AgentDetail projectId={projectId} agent={agent} isDefault={isDefault} />
      </DisclosureContent>
    </Disclosure>
  );
}

function AgentDetail({
  projectId,
  agent,
  isDefault,
}: {
  projectId: string;
  agent: Agent;
  isDefault: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const configure = useConfigureThread(projectId);
  const fileQuery = useQuery({
    queryKey: ['project-file-source', projectId, agent.path],
    queryFn: () => readProjectFile(projectId, agent.path),
    staleTime: 30_000,
  });

  const modeLabel = agent.mode ? formatMode(agent.mode) : null;

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

  return (
    <div className="relative px-4 py-5">
      <div className="absolute top-4 right-4">
        <DetailToolbarActions
          onCopy={onCopy}
          onEdit={() => configure.start(editConfigPrompt('agent', agent.name, agent.path))}
          editing={configure.pending}
          copyDisabled={!fileQuery.data?.content}
        />
      </div>
      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          {modeLabel && (
            <Badge
              variant="outline"
              size="sm"
              className="text-muted-foreground font-medium tracking-normal normal-case"
            >
              {modeLabel}
            </Badge>
          )}
          {isDefault && (
            <Badge
              variant="outline"
              size="sm"
              className="text-muted-foreground gap-1 font-medium tracking-normal normal-case"
            >
              <StarSolid className="text-kortix-orange size-4 shrink-0" />
              Default
            </Badge>
          )}
        </div>
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">{agent.name}</h1>
        {agent.description && (
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
            {agent.description}
          </p>
        )}
      </div>

      <div className="mt-8">
        {fileQuery.isLoading ? (
          <div className="space-y-2.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-10/12" />
            <Skeleton className="h-4 w-9/12" />
          </div>
        ) : fileQuery.isError ? (
          <InfoBanner
            tone="destructive"
            title={tHardcodedUi.raw(
              'appProjectsIdCustomizeAgentsPage.line488JsxAttrTitleCouldnTLoadSource',
            )}
            action={
              <Button variant="outline" size="sm" onClick={() => fileQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {(fileQuery.error as Error)?.message ?? 'Failed to read agent source'}
          </InfoBanner>
        ) : body.trim() ? (
          <UnifiedMarkdown content={body} />
        ) : (
          <p className="text-muted-foreground/60 text-sm italic">
            {tHardcodedUi.raw(
              'appProjectsIdCustomizeAgentsPage.line314JsxTextAgentBodyIsEmptyAddPromptContentBelow',
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function DetailToolbarActions({
  onCopy,
  onEdit,
  editing,
  copyDisabled,
}: {
  onCopy: () => void;
  onEdit: () => void;
  editing: boolean;
  copyDisabled: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <ButtonGroup>
      <Hint label={'Edit'}>
        <Button variant="outline" size="sm" onClick={onEdit} disabled={editing}>
          {editing ? (
            <Loading className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <Pencil className="size-3.5 shrink-0" />
          )}
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsAgentsViewJsxTextEditWith8e645034',
          )}
        </Button>
      </Hint>
      <Hint label={tHardcodedUi.raw('appProjectsIdCustomizeAgentsPage.line363JsxTextCopySource')}>
        <Button variant="outline" size="icon" onClick={onCopy} disabled={copyDisabled}>
          <Copy className="size-3.5 shrink-0" />
        </Button>
      </Hint>
    </ButtonGroup>
  );
}
