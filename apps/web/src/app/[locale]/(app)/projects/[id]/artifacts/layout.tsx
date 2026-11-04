'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { FeatureGateScreen } from '@kortix/ui/customize/shared/feature-gate-screen';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * /projects/[id]/artifacts* — the project's artifacts. They exist only with
 * the project's `artifacts` flag on: off, a deep link shows only that the flag
 * is off, and no artifact data loads.
 */
export default function ProjectArtifactsLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('artifacts');
  const artifacts = useFeatureFlag(id, 'artifacts');

  if (artifacts.isLoading) return null;
  if (!artifacts.enabled) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        <FeatureGateScreen featureKey="artifacts" featureName={t('title')} description={t('gateDescription')} />
      </div>
    );
  }
  return <>{children}</>;
}
