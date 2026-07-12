/**
 * AgentSelector — bottom sheet for selecting the active agent.
 */

import React, { useCallback, useMemo } from 'react';
import { View, TouchableOpacity, FlatList } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
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
    <View className={`rounded-t-2xl ${isDark ? 'bg-zinc-900' : 'bg-white'}`}>
      {/* Handle */}
      <View className="items-center pt-3 pb-1">
        <View className={`h-1 w-10 rounded-full ${isDark ? 'bg-zinc-700' : 'bg-zinc-300'}`} />
      </View>

      {/* Header */}
      <View className="flex-row items-center justify-between px-5 py-3">
        <Text className={`text-base font-semibold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
          Agent
        </Text>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Ionicons name="close" size={20} color={isDark ? '#a1a1aa' : '#71717a'} />
        </TouchableOpacity>
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
            <TouchableOpacity
              onPress={() => handleSelect(item.name)}
              className={`flex-row items-center rounded-xl px-4 py-3 mb-1 ${
                isSelected ? (isDark ? 'bg-zinc-800' : 'bg-zinc-100') : ''
              }`}
              activeOpacity={0.6}
            >
              <View className="flex-1">
                <Text
                  className={`text-sm capitalize ${
                    isSelected
                      ? isDark ? 'text-white font-semibold' : 'text-zinc-900 font-semibold'
                      : isDark ? 'text-zinc-300' : 'text-zinc-700'
                  }`}
                >
                  {item.name}
                </Text>
                {item.description && (
                  <Text
                    className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                    numberOfLines={1}
                  >
                    {item.description}
                  </Text>
                )}
              </View>
              {isSelected && (
                <Ionicons name="checkmark" size={18} color={isDark ? '#22c55e' : '#16a34a'} />
              )}
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}
