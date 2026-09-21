'use client';

import { GitBranchIcon } from '@phosphor-icons/react';

import { InfoBanner } from '@/components/ui/info-banner';
import { useTranslations } from '@/i18n/use-translations';
import { isSessionStartError } from '@kortix/sdk';

function repositoryGeneration(metadata: Record<string, unknown> | null | undefined): string | null {
  const generation = metadata?.repository_generation;
  return typeof generation === 'string' && generation.length > 0 ? generation : null;
}

export function sessionUsesPreviousRepository(
  projectMetadata: Record<string, unknown> | null | undefined,
  sessionMetadata: Record<string, unknown> | null | undefined,
): boolean {
  const current = repositoryGeneration(projectMetadata);
  return current !== null && repositoryGeneration(sessionMetadata) !== current;
}

export function isPreviousRepositorySessionError(error: unknown): boolean {
  return isSessionStartError(error) && error.code === 'session_repository_changed';
}

export function isPreviousRepositoryRuntimeUnavailableError(error: unknown): boolean {
  return isSessionStartError(error) && error.code === 'previous_repository_runtime_unavailable';
}

export function PreviousRepositoryNotice() {
  const t = useTranslations('sessionPage.previousRepository');

  return (
    <InfoBanner
      tone="warning"
      icon={GitBranchIcon}
      className="rounded-none border-x-0 border-t-0"
    >
      {t('message')}
    </InfoBanner>
  );
}
