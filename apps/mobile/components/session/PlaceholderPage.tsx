/**
 * PlaceholderPage — generic placeholder for page tabs (Files, Terminal, etc.)
 *
 * Shows the page icon, title, and a "coming soon" message.
 * Will be replaced with real implementations later.
 */

import React from 'react';
import { View, TouchableOpacity, Text as RNText } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';

interface PlaceholderPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
}

export function PlaceholderPage({ page, onBack, onOpenDrawer, onOpenRightDrawer }: PlaceholderPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#888' : '#777';

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#f5f5f5' }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
      />

      <PageContent>
      {/* Placeholder content */}
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 18,
            backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
          }}
        >
          <Ionicons name={page.icon as any} size={30} color={mutedColor} />
        </View>
        <RNText
          style={{
            fontSize: 18,
            fontFamily: 'Roobert-Medium',
            color: fgColor,
            marginBottom: 8,
            textAlign: 'center',
          }}
        >
          {page.label}
        </RNText>
        <RNText
          style={{
            fontSize: 14,
            fontFamily: 'Roobert',
            color: mutedColor,
            textAlign: 'center',
            lineHeight: 20,
          }}
        >
          Coming soon. This feature is under development.
        </RNText>
      </View>
      </PageContent>
    </View>
  );
}
