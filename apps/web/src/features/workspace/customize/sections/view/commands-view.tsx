'use client';

import { useTranslations } from 'next-intl';

import { UnifiedMarkdown } from '@/components/markdown';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { MarketplaceSectionButton } from '@/features/workspace/customize/marketplace-section-button';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { splitFrontmatter } from '@/features/workspace/customize/shared/utils';
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
import { cn } from '@/lib/utils';
import { Command, DangerTriangleSolid, Pencil, Search } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

type Command = ProjectConfigSummary['commands'][number];

export function CommandsView({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const commands = detailQuery.data?.config?.commands ?? [];
  const isForbidden =
    detailQuery.isError && /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false),
    );
  }, [commands, query]);

  const configure = useConfigureThread(projectId);

  return (
    <CustomizeSectionWrapper
      title="Commands"
      description={tHardcodedUi.raw(
        'appProjectsIdCustomizeCommandsPage.line394JsxAttrDescriptionPickACommandFromTheListToPreview',
      )}
      action={
        <div className="flex items-center gap-1.5">
          <MarketplaceSectionButton projectId={projectId} />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => configure.start(newConfigPrompt('command'))}
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
              'appProjectsIdCustomizeCommandsPage.line107JsxAttrPlaceholderSearchCommands',
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
              'appProjectsIdCustomizeCommandsPage.line465JsxAttrTitleAccessRequired',
            )}
          >
            {tHardcodedUi.raw(
              'appProjectsIdCustomizeCommandsPage.line466JsxTextNoPermissionToReadThisRepo',
            )}
          </InfoBanner>
        ) : detailQuery.isError ? (
          <ErrorState
            size="sm"
            title={tHardcodedUi.raw(
              'appProjectsIdCustomizeCommandsPage.line480JsxTextFailedToLoad',
            )}
            description={(detailQuery.error as Error)?.message ?? 'Failed to load commands'}
            action={
              <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : commands.length === 0 ? (
          <EmptyState
            icon={Command}
            size="sm"
            title={tHardcodedUi.raw(
              'appProjectsIdCustomizeCommandsPage.line415JsxAttrTitleNoCommandsYet',
            )}
            action={
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => configure.start(newConfigPrompt('command'))}
                disabled={configure.pending}
              >
                {configure.pending ? (
                  <Loading className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <Icon.Plus className="size-3.5 shrink-0" />
                )}
                {tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsCommandsViewJsxTextCreateA28cc596f',
                )}
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tHardcodedUi.raw('appProjectsIdCustomizeCommandsPage.line403JsxTextNoMatchesFor')}{' '}
            <span className="text-foreground font-mono">{query}</span>.
          </p>
        ) : (
          <div className="space-y-2">
            {filtered.map((command) => (
              <CommandDisclosure key={command.path} projectId={projectId} command={command} />
            ))}
          </div>
        )}
      </div>
    </CustomizeSectionWrapper>
  );
}

function CommandDisclosure({ projectId, command }: { projectId: string; command: Command }) {
  const [open, setOpen] = useState(false);

  return (
    <Disclosure variant="outline" className="overflow-hidden" open={open} onOpenChange={setOpen}>
      <DisclosureTrigger variant="outline">
        <Button
          variant="accent"
          className={cn('flex w-full items-center justify-start rounded-none')}
        >
          <span className="truncate text-sm font-medium">/{command.name}</span>
        </Button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <CommandDetail projectId={projectId} command={command} />
      </DisclosureContent>
    </Disclosure>
  );
}

function CommandDetail({ projectId, command }: { projectId: string; command: Command }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const configure = useConfigureThread(projectId);
  const fileQuery = useQuery({
    queryKey: ['project-file-source', projectId, command.path],
    queryFn: () => readProjectFile(projectId, command.path),
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

  return (
    <div className="relative px-4 py-5">
      <div className="absolute top-4 right-4">
        <DetailToolbarActions
          onCopy={onCopy}
          onEdit={() => configure.start(editConfigPrompt('command', command.name, command.path))}
          editing={configure.pending}
          copyDisabled={!fileQuery.data?.content}
        />
      </div>
      <div className="space-y-2">
        <h1 className="text-foreground flex items-center gap-1 text-2xl font-semibold tracking-tight">
          <span className="text-muted-foreground/40">/</span>
          {command.name}
        </h1>
        {command.description && (
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
            {command.description}
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
              'appProjectsIdCustomizeCommandsPage.line451JsxAttrTitleCouldnTLoadSource',
            )}
            action={
              <Button variant="outline" size="sm" onClick={() => fileQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {(fileQuery.error as Error)?.message ?? 'Failed to read command source'}
          </InfoBanner>
        ) : body.trim() ? (
          <UnifiedMarkdown content={body} />
        ) : (
          <p className="text-muted-foreground/60 text-sm italic">
            {tHardcodedUi.raw(
              'appProjectsIdCustomizeCommandsPage.line276JsxTextCommandBodyIsEmptyAddThePromptContent',
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
            'autoComponentsProjectsCustomizeSectionsCommandsViewJsxTextEditWithec0f2ca8',
          )}
        </Button>
      </Hint>
      <Hint label={tHardcodedUi.raw('appProjectsIdCustomizeCommandsPage.line326JsxTextCopySource')}>
        <Button variant="outline" size="icon" onClick={onCopy} disabled={copyDisabled}>
          <Copy className="size-3.5 shrink-0" />
        </Button>
      </Hint>
    </ButtonGroup>
  );
}
