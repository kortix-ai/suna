import React from 'react';
import { TabPlaceholder, type AccountCaps } from './account-shared';
import type { AccountDetail } from '@/lib/accounts/accounts-client';

export function AccountSettingsTab(_props: { account: AccountDetail; can: AccountCaps; isDark: boolean }) {
  return <TabPlaceholder text="Settings — coming soon." isDark={_props.isDark} />;
}
