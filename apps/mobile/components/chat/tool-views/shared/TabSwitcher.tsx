import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Code, Eye, LucideIcon } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface Tab {
  id: string;
  label: string;
  icon?: LucideIcon;
}

interface TabSwitcherProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
  iconOnly?: boolean;
}

export function TabSwitcher({
  tabs,
  activeTab,
  onTabChange,
  className = '',
  iconOnly = false,
}: TabSwitcherProps) {
  const handleTabPress = (tabId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onTabChange(tabId);
  };

  return (
    <View
      className={`flex-row items-center gap-1 bg-card border border-border rounded-full p-1 ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <Pressable
            key={tab.id}
            onPress={() => handleTabPress(tab.id)}
            className={`flex-row items-center justify-center gap-1.5 ${iconOnly ? 'px-2' : 'px-3'} py-1.5 rounded-full ${tabs.length > 2 && !iconOnly ? 'flex-1 min-w-0' : iconOnly ? '' : 'flex-1'
              } ${isActive
                ? 'bg-primary'
                : 'bg-transparent'
              }`}
          >
            {tab.icon && (
              <Icon
                as={tab.icon}
                size={15}
                className={
                  isActive
                    ? 'text-background'
                    : 'text-primary'
                }
              />
            )}
            {!iconOnly && (
              <Text
                className={`text-xs font-roobert-medium ${isActive
                  ? 'text-background'
                  : 'text-primary'
                  }`}
                numberOfLines={1}
              >
                {tab.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

