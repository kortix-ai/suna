import React from 'react';
import { Text } from '@/components/ui/text';
import { Card, accountColors } from '../account-shared';

export function ObservabilityCards({ canManage: _canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  const c = accountColors(isDark);
  return (
    <Card isDark={isDark}>
      <Text style={{ fontSize: 13, color: c.muted }}>Audit webhooks — coming soon.</Text>
    </Card>
  );
}
