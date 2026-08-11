import { SettingsSectionHeader } from '@/components/ui/settings-section-header';

import { railItemForTab } from './rail';
import type { SettingsTab } from './settings-tabs';

export function SettingsTabHeader({ tab, action }: { tab: SettingsTab; action?: React.ReactNode }) {
  const item = railItemForTab(tab);
  if (!item) return null;

  return (
    <SettingsSectionHeader
      title={item.label}
      description={item.description}
      action={action}
      className="pb-1"
    />
  );
}
