/**
 * PlaceholderPage — generic placeholder for page tabs (Files, Terminal, etc.)
 *
 * Shows the page icon, title, and a "coming soon" message.
 * Will be replaced with real implementations later.
 */

import React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface PlaceholderPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function PlaceholderPage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen }: PlaceholderPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
      {/* Placeholder content */}
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 18,
            backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.04),
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
          }}
        >
          <Ionicons name={page.icon as any} size={30} color={mutedColor} />
        </View>
        <Text
          className="text-foreground text-center"
          style={{
            fontSize: 18,
            fontFamily: 'Roobert-Medium',
            marginBottom: 8,
          }}
        >
          {page.label}
        </Text>
        <Text
          className="text-muted-foreground text-center"
          style={{
            fontSize: 14,
            fontFamily: 'Roobert',
            lineHeight: 20,
          }}
        >
          Coming soon. This feature is under development.
        </Text>
      </View>
      </PageContent>
    </View>
  );
}
