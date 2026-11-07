'use client';

import { SettingsRowGroup } from '@kortix/ui/settings-row';
import { Label } from '@kortix/ui/label';
import type { WorkspaceAccountPane as WorkspaceAccountPaneComponent } from '@kortix/ui/workspace/admin/project-admin-dashboard';

import { AutomationsPauseCard } from '@/components/iam/automations-pause-card';
import { AccountHubContent } from '@/features/accounts/hub/account-hub-content';
import { useTranslations } from '@/i18n/use-translations';

/**
 * The account panes of Workspace settings (Security, People, Billing,
 * Branding, API keys, and the account half of Git). The dashboard has already
 * named the account and the section (`EmbeddedAccountHubProvider`), so the
 * pane reads them the way it always read the hub URL.
 */
export const WorkspaceAccountPane: WorkspaceAccountPaneComponent = ({ projectId, companion, title }) => (
  <AccountHubContent companion={companion} title={title} workspaceId={projectId} />
);

/** General, after the name and icon: Pause all triggers, one switch for this workspace. */
export function WorkspaceGeneralExtras({ accountId }: { projectId: string; accountId: string }) {
  const t = useTranslations('automationsPause');
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>{t('groupTitle')}</Label>
        <p className="text-muted-foreground text-xs">{t('groupDescription')}</p>
      </div>
      <SettingsRowGroup>
        <AutomationsPauseCard accountId={accountId} />
      </SettingsRowGroup>
    </section>
  );
}
