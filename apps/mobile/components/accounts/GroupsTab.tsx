import React from 'react';
import { TabPlaceholder, type AccountCaps } from './account-shared';
import type { AccountDetail } from '@/lib/accounts/accounts-client';

export function GroupsTab(_props: { account: AccountDetail; can: AccountCaps; isDark: boolean }) {
  return <TabPlaceholder text="Groups — coming soon." isDark={_props.isDark} />;
}
