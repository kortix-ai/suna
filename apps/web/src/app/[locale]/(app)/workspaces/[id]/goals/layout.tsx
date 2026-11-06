'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { FeatureGateScreen } from '@kortix/ui/customize/shared/feature-gate-screen';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * /projects/[id]/goals* — the project's goals. It exists only with the
 * project's `goals` flag on: off, a deep link shows only that the flag is off,
 * and no goal data loads.
 */
export default function ProjectGoalsLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('goals');
  const goals = useFeatureFlag(id, 'goals');

  if (goals.isLoading) return null;
  if (!goals.enabled) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        <FeatureGateScreen featureKey="goals" featureName={t('title')} description={t('gateDescription')} />
      </div>
    );
  }
  return <>{children}</>;
}
