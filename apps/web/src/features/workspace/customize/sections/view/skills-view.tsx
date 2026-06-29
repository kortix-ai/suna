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
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { MarketplaceSectionButton } from '@/features/workspace/customize/marketplace-section-button';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
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
import { DangerTriangleSolid, ExternalLinkSolid, Pencil, Search } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { splitFrontmatter } from '../../shared/utils';

type Skill = ProjectConfigSummary['skills'][number];

export function SkillsView({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const skills = detailQuery.data?.config?.skills ?? [];
  const isForbidden =
    detailQuery.isError && /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || (s.description?.toLowerCase().includes(q) ?? false),
    );
  }, [skills, query]);

  const configure = useConfigureThread(projectId);

  return (
    <CustomizeSectionWrapper
      title="Skills"
      description={tHardcodedUi.raw(
        'appProjectsIdCustomizeSkillsPage.line591JsxAttrDescriptionPickASkillMdFromTheListTo',
      )}
      action={
        <div className="flex items-center gap-1.5">
          <MarketplaceSectionButton projectId={projectId} />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => configure.start(newConfigPrompt('skill'))}
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
              'appProjectsIdCustomizeSkillsPage.line149JsxAttrPlaceholderSearchSkills',
            )}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            variant="popover"
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
              'appProjectsIdCustomizeSkillsPage.line646JsxAttrTitleAccessRequired',
            )}
          >
            {tHardcodedUi.raw(
              'appProjectsIdCustomizeSkillsPage.line647JsxTextNoPermissionToReadThisRepo',
            )}
          </InfoBanner>
        ) : detailQuery.isError ? (
          <ErrorState
            size="sm"
            title={tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line661JsxTextFailedToLoad')}
            description={(detailQuery.error as Error)?.message ?? 'Failed to load skills'}
            action={
              <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : skills.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            size="sm"
            title={tHardcodedUi.raw(
              'appProjectsIdCustomizeSkillsPage.line168JsxAttrLabelNoSkillsYet',
            )}
            description="Create a skill to give agents reusable capabilities."
            action={
              <div className="flex flex-col items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => configure.start(newConfigPrompt('skill'))}
                  disabled={configure.pending}
                >
                  {configure.pending ? (
                    <Loading className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Plus className="size-3.5 shrink-0" />
                  )}
                  {tHardcodedUi.raw(
                    'autoComponentsProjectsCustomizeSectionsSkillsViewJsxTextCreateA722fbf3c',
                  )}
                </Button>
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <Link
                    href="https://opencode.ai/docs/skills/"
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
            {tHardcodedUi.raw('appProjectsIdCustomizeSkillsPage.line600JsxTextNoMatchesFor')}{' '}
            <span className="text-foreground font-mono">{query}</span>.
          </p>
        ) : (
          <div className="space-y-2">
            {filtered.map((skill) => (
              <SkillDisclosure key={skill.path} projectId={projectId} skill={skill} />
            ))}
          </div>
        )}
      </div>
    </CustomizeSectionWrapper>
  );
}

function SkillDisclosure({ projectId, skill }: { projectId: string; skill: Skill }) {
  const [open, setOpen] = useState(false);

  return (
    <Disclosure variant="outline" className="overflow-hidden" open={open} onOpenChange={setOpen}>
      <DisclosureTrigger variant="outline">
        <Button
          variant="popover"
          className={cn('flex w-full items-center justify-start rounded-none')}
        >
          <span className="truncate text-sm font-medium">{skill.name}</span>
        </Button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <SkillDetail projectId={projectId} skill={skill} />
      </DisclosureContent>
    </Disclosure>
  );
}

function SkillDetail({ projectId, skill }: { projectId: string; skill: Skill }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const configure = useConfigureThread(projectId);
  const fileQuery = useQuery({
    queryKey: ['project-file-source', projectId, skill.path],
    queryFn: () => readProjectFile(projectId, skill.path),
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
          onEdit={() => configure.start(editConfigPrompt('skill', skill.name, skill.path))}
          editing={configure.pending}
          copyDisabled={!fileQuery.data?.content}
        />
      </div>
      <div className="space-y-2">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">{skill.name}</h1>
        {skill.description && (
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
            {skill.description}
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
              'appProjectsIdCustomizeSkillsPage.line320JsxTextCouldnAposTLoadFiles',
            )}
            action={
              <Button variant="outline" size="sm" onClick={() => fileQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {(fileQuery.error as Error)?.message ?? 'Failed to read skill source'}
          </InfoBanner>
        ) : body.trim() ? (
          <UnifiedMarkdown content={body} />
        ) : (
          <p className="text-muted-foreground/60 text-sm italic">
            Skill body is empty. Add content below the frontmatter.
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
            'autoComponentsProjectsCustomizeSectionsSkillsViewJsxTextEditWithc3582225',
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
