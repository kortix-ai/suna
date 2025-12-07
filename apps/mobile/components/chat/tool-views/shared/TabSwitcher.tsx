import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Code, Eye, LucideIcon } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
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
}

export function TabSwitcher({
  tabs,
  activeTab,
  onTabChange,
  className = '',
}: TabSwitcherProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const handleTabPress = (tabId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onTabChange(tabId);
  };

  return (
    <View
      className={`flex-row items-center gap-1 bg-muted/50 border border-border/50 rounded-lg p-0.5 ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <Pressable
            key={tab.id}
            onPress={() => handleTabPress(tab.id)}
            className={`flex-row items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md ${
              tabs.length > 2 ? 'flex-1 min-w-0' : 'flex-1'
            } ${
              isActive
                ? 'bg-background dark:bg-primary/10'
                : 'bg-transparent'
            }`}
          >
            {tab.icon && (
              <Icon
                as={tab.icon}
                size={13}
                className={
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground'
                }
              />
            )}
            <Text
              className={`text-[11px] font-roobert-medium ${
                isActive
                  ? 'text-foreground'
                  : 'text-muted-foreground'
              }`}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

