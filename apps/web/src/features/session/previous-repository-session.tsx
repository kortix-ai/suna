'use client';

import { GitBranchIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useTranslations } from '@/i18n/use-translations';
import { isSessionStartError } from '@kortix/sdk';

export function isPreviousRepositorySessionError(error: unknown): boolean {
  return isSessionStartError(error) && error.code === 'session_repository_changed';
}

export function isPreviousRepositoryRuntimeUnavailableError(error: unknown): boolean {
  return isSessionStartError(error) && error.code === 'previous_repository_runtime_unavailable';
}

export function PreviousRepositorySession({
  projectId,
  canResume,
  isResuming,
  onResume,
  onDelete,
}: {
  projectId: string;
  canResume: boolean;
  isResuming: boolean;
  onResume: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('sessionPage.previousRepository');

  return (
    <EmptyState
      icon={GitBranchIcon}
      title={t('title')}
      description={canResume ? t('message') : t('unavailable')}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canResume ? (
            <Button size="sm" onClick={onResume} disabled={isResuming} aria-busy={isResuming}>
              {isResuming ? <Loading className="size-3.5 shrink-0" /> : null}
              {isResuming ? t('resuming') : t('resume')}
            </Button>
          ) : null}
          <Button asChild size="sm" variant={canResume ? 'outline' : 'default'}>
            <Link href={`/projects/${projectId}`}>{t('newSession')}</Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            {t('delete')}
          </Button>
        </div>
      }
    />
  );
}
