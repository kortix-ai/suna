'use client';

import { useMarketplaceEnabled } from '@/components/projects/marketplace/marketplace-nav';
import { Button } from '@/components/ui/button';
import { useSettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { StorefrontIcon as Store } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

export function MarketplaceSectionButton({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const enabled = useMarketplaceEnabled(projectId);
  const { navigate } = useSettingsNav();

  if (!enabled) return null;

  return (
    <Button size="sm" variant="secondary" onClick={() => navigate('marketplace')}>
      <Store className="shrink-0" />
      {tI18nComplete.raw('textc608981d8d68')}
    </Button>
  );
}
