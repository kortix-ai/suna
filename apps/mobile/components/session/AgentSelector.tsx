/**
 * AgentSelector — bottom sheet for selecting the active agent.
 */

import React, { useCallback, useMemo } from 'react';
import { View, FlatList } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { THEME } from '@/lib/utils/theme';
import type { Agent } from '@/lib/opencode/hooks/use-opencode-data';

interface AgentSelectorProps {
  agents: Agent[];
  selected: Agent | null;
  onSelect: (name: string) => void;
  onClose: () => void;
}

export function AgentSelector({
  agents,
  selected,
  onSelect,
  onClose,
}: AgentSelectorProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const handleSelect = useCallback(
    (name: string) => {
      onSelect(name);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <View className="rounded-t-2xl bg-popover">
      {/* Handle */}
      <View className="items-center pt-3 pb-1">
        <View className="h-1 w-10 rounded-full bg-border" />
      </View>

      {/* Header */}
      <View className="flex-row items-center justify-between px-5 py-3">
        <Text className="text-base font-semibold text-foreground">
          Agent
        </Text>
        <Button
          variant="ghost"
          size="icon"
          onPress={onClose}
          hitSlop={12}
          className="h-auto w-auto p-0 active:bg-transparent active:opacity-70"
        >
          <Ionicons name="close" size={20} color={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />
        </Button>
      </View>

      {/* List */}
      <FlatList
        data={agents}
        keyExtractor={(item) => item.name}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24 }}
        style={{ maxHeight: 320 }}
        renderItem={({ item }) => {
          const isSelected = item.name === selected?.name;
          return (
            <Button
              variant="ghost"
              onPress={() => handleSelect(item.name)}
              className={`h-auto flex-row items-center justify-start rounded-xl px-4 py-3 mb-1 active:opacity-60 ${
                isSelected ? 'bg-accent' : ''
              }`}
            >
              <View className="flex-1">
                <Text
                  className={`text-sm capitalize ${
                    isSelected ? 'text-foreground font-semibold' : 'text-muted-foreground'
                  }`}
                >
                  {item.name}
                </Text>
                {item.description && (
                  <Text
                    className="text-xs mt-0.5 text-muted-foreground"
                    numberOfLines={1}
                  >
                    {item.description}
                  </Text>
                )}
              </View>
              {isSelected && (
                <Ionicons name="checkmark" size={18} color={THEME.accent.green} />
              )}
            </Button>
          );
        }}
      />
    </View>
  );
}
