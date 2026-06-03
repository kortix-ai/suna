/**
 * IntegrationsTabPage — full-screen Pipedream integrations page
 * rendered as a page tab (from right drawer / command palette).
 * Same header pattern as BrowserPage and other page tabs.
 */

import React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { IntegrationsPageContent } from '@/components/settings/IntegrationsPage';

interface IntegrationsTabPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function IntegrationsTabPage({
  page,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: IntegrationsTabPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#f5f5f5' }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />
      <PageContent>
        <IntegrationsPageContent />
      </PageContent>
    </View>
  );
}
