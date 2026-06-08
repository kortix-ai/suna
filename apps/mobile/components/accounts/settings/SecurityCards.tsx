import React from 'react';
import { Text } from '@/components/ui/text';
import { Card, accountColors } from '../account-shared';

export function SecurityCards({ canManage: _canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  const c = accountColors(isDark);
  return (
    <Card isDark={isDark}>
      <Text style={{ fontSize: 13, color: c.muted }}>Security controls — coming soon.</Text>
    </Card>
  );
}
