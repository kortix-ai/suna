'use client';

import { useParams } from 'next/navigation';

import { useTranslations } from '@/i18n/use-translations';
import { useFeatureFlag } from '@kortix/sdk/react';
import { FeatureGateScreen } from '@kortix/ui/customize/shared/feature-gate-screen';
import { CompanyMemoryPage } from '@kortix/ui/workspace';

/**
 * /projects/[id]/memory — the Company memory (what every agent in the project
 * knows, with `project_channels` on) and the viewer's My Kortix memory (what
 * My Kortix remembers about them, `?layer=mykortix`, with Files on). With
 * both off, a deep link shows only that Channels is off, and no memory loads.
 */
export default function ProjectMemoryPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('spaces.memory.company');
  const tFlag = useTranslations('settings.featureFlags.flags.project_channels');
  const channels = useFeatureFlag(id, 'project_channels');
  const files = useFeatureFlag(id, 'drives');

  if (channels.isLoading || files.isLoading) return null;
  if (!channels.enabled && files.enabled) return <CompanyMemoryPage projectId={id} company={false} />;
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
