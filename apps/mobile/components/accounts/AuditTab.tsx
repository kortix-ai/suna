import React from 'react';
import { TabPlaceholder } from './account-shared';
import type { AccountDetail } from '@/lib/accounts/accounts-client';

export function AuditTab(_props: { account: AccountDetail; isDark: boolean }) {
  return <TabPlaceholder text="Audit — coming soon." isDark={_props.isDark} />;
}
