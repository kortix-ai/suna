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
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#999999' : '#6e6e6e';
  const sectionColor = isDark ? '#666' : '#999';
  const bgColor = isDark ? '#090909' : '#F5F5F5'; // matches --chrome-background

  const handleItemPress = (pageId: string) => {
    useTabStore.getState().navigateToPage(pageId);
    onClose();
  };

  const handleUpdatesPress = () => {
    useTabStore.getState().navigateToPage('page:updates');
    onClose();
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: bgColor,
        paddingTop: insets.top,
      }}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        {sections.map((section) => (
          <View key={section.title} style={{ marginBottom: 8 }}>
            <RNText
              style={{
                fontSize: 11,
                fontFamily: 'Roobert-Medium',
                color: sectionColor,
                letterSpacing: 1,
                paddingHorizontal: 16,
                paddingTop: 16,
                paddingBottom: 8,
              }}
            >
              {section.title}
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
                  gap: 12,
                }}
              >
                <Ionicons name={item.icon as any} size={18} color={mutedColor} />
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

        {/* Updates */}
        <View style={{ marginBottom: 8 }}>
          <RNText
            style={{
              fontSize: 11,
              fontFamily: 'Roobert-Medium',
              color: sectionColor,
              letterSpacing: 1,
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 8,
            }}
          >
            SYSTEM
          </RNText>

          <TouchableOpacity
            onPress={handleUpdatesPress}
            activeOpacity={0.6}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 11,
              gap: 12,
            }}
          >
            <View style={{ position: 'relative' }}>
              <Ionicons name="arrow-down-circle-outline" size={18} color={mutedColor} />
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
                    borderWidth: 1.5,
                    borderColor: bgColor,
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
