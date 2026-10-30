'use client';

import { useParams } from 'next/navigation';

import { useTranslations } from '@/i18n/use-translations';
import { useFeatureFlag } from '@kortix/sdk/react';
import { FeatureGateScreen } from '@kortix/ui/customize/shared/feature-gate-screen';
import { CompanyMemoryPage } from '@kortix/ui/workspace';

/**
 * /projects/[id]/memory — the Company memory: what every agent in the project
 * knows. It exists only with the project's `project_channels` flag on: off, a
 * deep link shows only that the flag is off, and no memory loads.
 */
export default function ProjectMemoryPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('spaces.memory.company');
  const tFlag = useTranslations('settings.featureFlags.flags.project_channels');
  const channels = useFeatureFlag(id, 'project_channels');

  if (channels.isLoading) return null;
  if (!channels.enabled) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        <FeatureGateScreen
          featureKey="project_channels"
          featureName={tFlag('name')}
          description={t('gateDescription')}
        />
      </div>
    );
  }
  return <CompanyMemoryPage projectId={id} />;
}
