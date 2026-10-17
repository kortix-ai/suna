'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import type { UiTranslator } from '@/i18n/translator';
import { EntityFilePane } from '@/features/workspace/capabilities/shared/entity/entity-modal';
import { getProjectDetail, readProjectFile } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

import { skillBySegment } from './skill-resolve';

/**
 * `/projects/<id>/customize/skills/<name>` — one skill, as a page.
 *
 * The skills list opens its card in a modal; this page is the URL the REST
 * layer, the CLI and a shared link resolve. They read the same
 * `qk.project.detail(id)` scan, so a skill the page lists is exactly the
 * skill this resolves (KRTX-2543: before the route existed the URL answered
 * 404 while the list showed the card).
 */
export function SkillDetailPage({ projectId, segment }: { projectId: string; segment: string }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });

  const skills = detailQuery.data?.config.skills ?? [];
  const skill = detailQuery.isSuccess ? skillBySegment(skills, segment) : undefined;

  const fileQuery = useQuery({
    queryKey: ['skill-detail-file', projectId, skill?.path],
    queryFn: () => readProjectFile(projectId, skill!.path),
    enabled: skill !== undefined,
    staleTime: 30_000,
  });

  if (detailQuery.isPending) return <SkillDetailSkeleton />;

  if (!skill) {
    return <SkillDetailNotFound tI18nComplete={tI18nComplete} projectId={projectId} />;
  }

  return (
    <div className="bg-popover flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 space-y-1.5 border-b px-6 py-4">
        <BackToList tI18nComplete={tI18nComplete} projectId={projectId} />
        <h1 className="text-foreground truncate text-lg font-semibold">{skill.name}</h1>
        <p className="text-muted-foreground font-mono text-xs">{skill.path}</p>
        {skill.description ? <p className="text-muted-foreground text-sm">{skill.description}</p> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EntityFilePane
          key={skill.path}
          path={skill.path}
          content={fileQuery.data?.content}
          isLoading={fileQuery.isLoading}
          isError={fileQuery.isError}
          error={fileQuery.error}
          onRetry={() => void fileQuery.refetch()}
        />
      </div>
    </div>
  );
}

function BackToList({ tI18nComplete, projectId }: { tI18nComplete: UiTranslator; projectId: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="text-muted-foreground -ml-2 px-2">
      <Link href={`/projects/${projectId}/customize/skills`}>
        <ArrowLeftIcon className="size-3.5" />
        {tI18nComplete.raw('text76900f1bfd16')}
      </Link>
    </Button>
  );
}

function SkillDetailNotFound({ tI18nComplete, projectId }: { tI18nComplete: UiTranslator; projectId: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6">
      <p className="text-foreground font-medium">{tI18nComplete.raw('texte3ebaa16dd9d')}</p>
      <p className="text-muted-foreground text-sm">{tI18nComplete.raw('textf7571d57f984')}</p>
      <BackToList tI18nComplete={tI18nComplete} projectId={projectId} />
    </div>
  );
}

function SkillDetailSkeleton() {
  return (
    <div className="space-y-3 p-6">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
