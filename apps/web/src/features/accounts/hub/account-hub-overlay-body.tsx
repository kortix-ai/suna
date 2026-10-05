'use client';

/**
 * What the account hub renders inside its modal: the settings shell — sidebar,
 * breadcrumb bar, content column — around the hub's body.
 *
 * Its own module because it is the LAZY boundary (`account-hub-entry.tsx`).
 */

import { AccountHubContent } from './account-hub-content';
import { useAccountPanelId } from './account-hub-location';
import { AccountListContent } from './account-list-content';
import { AccountSettingsShell } from './account-settings-shell';

export function AccountHubOverlayBody() {
  // The URL is the ONE thing that decides which pane shows. `?accountId=` with
  // no value is the account list — the modal is open, no account chosen.
  const accountId = useAccountPanelId();
  return (
    <AccountSettingsShell>
      {accountId ? <AccountHubContent /> : <AccountListContent />}
    </AccountSettingsShell>
  );
}
