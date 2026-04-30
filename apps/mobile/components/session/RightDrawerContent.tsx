/**
 * RightDrawerContent — settings & services menu for the right-side drawer.
 *
 * Tapping an item opens it as a page tab in the main area and closes the drawer.
 */

import React from 'react';
import { View, TouchableOpacity, ScrollView, Text as RNText } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTabStore } from '@/stores/tab-store';
import { useGlobalSandboxUpdate } from '@/hooks/useSandboxUpdate';

interface MenuItem {
  icon: string;
  label: string;
  pageId: string;
}

interface MenuSection {
  title: string;
  items: MenuItem[];
}

interface RightDrawerContentProps {
  onClose: () => void;
}

const sections: MenuSection[] = [
  {
    title: 'QUICK ACTIONS',
    items: [
      { icon: 'folder-open-outline', label: 'Files', pageId: 'page:files' },
      { icon: 'terminal-outline', label: 'Terminal', pageId: 'page:terminal' },
      { icon: 'grid-outline', label: 'Workspace', pageId: 'page:workspace' },
    ],
  },
  {
    title: 'SECURITY',
    items: [
      { icon: 'key-outline', label: 'Secrets Manager', pageId: 'page:secrets' },
      { icon: 'cube-outline', label: 'LLM Providers', pageId: 'page:llm-providers' },
      { icon: 'link-outline', label: 'SSH', pageId: 'page:ssh' },
      { icon: 'code-slash-outline', label: 'API', pageId: 'page:api' },
    ],
  },
  {
    title: 'SERVICES',
    items: [
      { icon: 'calendar-outline', label: 'Triggers', pageId: 'page:triggers' },
      { icon: 'chatbox-outline', label: 'Channels', pageId: 'page:channels' },
      { icon: 'swap-horizontal-outline', label: 'Tunnel', pageId: 'page:tunnel' },
      { icon: 'git-branch-outline', label: 'Connectors', pageId: 'page:integrations' },
      { icon: 'pulse-outline', label: 'Service Manager', pageId: 'page:running-services' },
      { icon: 'compass-outline', label: 'Internal Browser', pageId: 'page:browser' },
      { icon: 'globe-outline', label: 'Agent Browser', pageId: 'page:agent-browser' },
    ],
  },
];

export function RightDrawerContent({ onClose }: RightDrawerContentProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { updateAvailable } = useGlobalSandboxUpdate();

  // Colors aligned with the left drawer (home.tsx renderDrawerContent + global.css tokens).
  // Use the same pattern: derive from isDark rather than raw hex.
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const iconColor = isDark ? '#F8F8F8' : '#121215'; // primary items — same as left drawer
  const mutedColor = isDark ? '#999999' : '#6e6e6e'; // secondary items only
  // Section label — lighter than muted, wider tracking, matches web sidebar section headers
  const sectionColor = isDark ? '#555555' : '#AAAAAA';

  const handleItemPress = (pageId: string) => {
    useTabStore.getState().navigateToPage(pageId);
    onClose();
  };

  const handleUpdatesPress = () => {
    useTabStore.getState().navigateToPage('page:updates');
    onClose();
  };

  return (
    // bg-chrome-background via NativeWind — no raw hex
    <View
      className="flex-1 bg-chrome-background"
      style={{ paddingTop: insets.top }}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        {sections.map((section) => (
          <View key={section.title} style={{ marginBottom: 4 }}>
            {/* Section header — lowercase, lighter weight, wider tracking; matches web sidebar labels */}
            <RNText
              style={{
                fontSize: 11,
                fontFamily: 'Roobert',
                color: sectionColor,
                letterSpacing: 1.2,
                textTransform: 'uppercase',
                paddingHorizontal: 20,
                paddingTop: 20,
                paddingBottom: 6,
              }}
            >
              {section.title.toLowerCase()}
            </RNText>

            {section.items.map((item) => (
              <TouchableOpacity
                key={item.label}
                onPress={() => handleItemPress(item.pageId)}
                activeOpacity={0.6}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 16,
                  paddingVertical: 11,
                  gap: 13,
                  marginHorizontal: 4,
                  borderRadius: 10,
                }}
              >
                {/* Primary items use iconColor (full opacity), not mutedColor */}
                <Ionicons name={item.icon as any} size={18} color={iconColor} />
                <RNText
                  style={{
                    fontSize: 15,
                    fontFamily: 'Roobert',
                    color: fgColor,
                  }}
                >
                  {item.label}
                </RNText>
              </TouchableOpacity>
            ))}
          </View>
        ))}

        {/* Updates / System section */}
        <View style={{ marginBottom: 4 }}>
          <RNText
            style={{
              fontSize: 11,
              fontFamily: 'Roobert',
              color: sectionColor,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              paddingHorizontal: 20,
              paddingTop: 20,
              paddingBottom: 6,
            }}
          >
            system
          </RNText>

          <TouchableOpacity
            onPress={handleUpdatesPress}
            activeOpacity={0.6}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 11,
              gap: 13,
              marginHorizontal: 4,
              borderRadius: 10,
            }}
          >
            <View style={{ position: 'relative' }}>
              <Ionicons name="arrow-down-circle-outline" size={18} color={iconColor} />
              {updateAvailable && (
                <View
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -2,
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: '#EF4444',
                    // Border matches the new bg-chrome-background — use semi-transparent
                    borderWidth: 1.5,
                    borderColor: isDark ? '#0A0A0A' : '#F3F3F3',
                  }}
                />
              )}
            </View>
            <RNText
              style={{
                fontSize: 15,
                fontFamily: 'Roobert',
                color: fgColor,
                flex: 1,
              }}
            >
              Updates
            </RNText>
            {updateAvailable && (
              <View
                style={{
                  backgroundColor: isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)',
                  borderRadius: 10,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                }}
              >
                <RNText
                  style={{
                    fontSize: 10,
                    fontFamily: 'Roobert-Medium',
                    color: '#EF4444',
                  }}
                >
                  New
                </RNText>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}
