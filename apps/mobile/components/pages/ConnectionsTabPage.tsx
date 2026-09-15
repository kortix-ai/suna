/**
 * ConnectionsTabPage — full-screen Pipedream connections page
 * rendered as a page tab (from right drawer / command palette).
 * Same header pattern as SSHPage, BrowserPage, etc.
 */

import React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { ConnectionsPageContent } from '@/components/settings/ConnectionsPage';
import { THEME } from '@/lib/utils/theme';

interface ConnectionsTabPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function ConnectionsTabPage({
  page,
  onBack,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: ConnectionsTabPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const bgColor = isDark ? THEME.dark.background : THEME.light.background;

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />
      <PageContent>
        <ConnectionsPageContent />
      </PageContent>
    </View>
  );
}
