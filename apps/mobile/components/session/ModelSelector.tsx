/**
 * ModelSelector — bottom sheet for selecting the model + provider.
 *
 * Groups models by provider, with a search bar.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { View, TouchableOpacity, FlatList, TextInput, SectionList } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import type { FlatModel } from '@/lib/opencode/hooks/use-opencode-data';

interface ModelSelectorProps {
  models: FlatModel[];
  selected: FlatModel | null;
  onSelect: (providerID: string, modelID: string) => void;
  onClose: () => void;
}

interface Section {
  title: string;
  data: FlatModel[];
}

export function ModelSelector({
  models,
  selected,
  onSelect,
  onClose,
}: ModelSelectorProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [search, setSearch] = useState('');

  const sections = useMemo(() => {
    const q = search.toLowerCase().trim();
    const filtered = q
      ? models.filter(
          (m) =>
            m.modelName.toLowerCase().includes(q) ||
            m.providerName.toLowerCase().includes(q) ||
            m.modelID.toLowerCase().includes(q),
        )
      : models;

    // Group by provider
    const groups: Record<string, FlatModel[]> = {};
    for (const m of filtered) {
      if (!groups[m.providerName]) groups[m.providerName] = [];
      groups[m.providerName].push(m);
    }

    return Object.entries(groups).map(
      ([title, data]): Section => ({ title, data }),
    );
  }, [models, search]);

  const handleSelect = useCallback(
    (m: FlatModel) => {
      onSelect(m.providerID, m.modelID);
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
          Model
        </Text>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Ionicons name="close" size={20} color={isDark ? '#a1a1aa' : '#71717a'} />
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View className="px-4 pb-2">
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search models..."
          placeholderTextColor={isDark ? '#52525b' : '#a1a1aa'}
          className={`rounded-lg px-3 py-2.5 text-sm ${
            isDark ? 'bg-zinc-800 text-white' : 'bg-zinc-100 text-zinc-900'
          }`}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* List */}
      <SectionList
        sections={sections}
        keyExtractor={(item) => `${item.providerID}/${item.modelID}`}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24 }}
        style={{ maxHeight: 400 }}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text
            className={`text-xs font-medium uppercase tracking-wider px-4 pt-3 pb-1 ${
              isDark ? 'text-zinc-500' : 'text-zinc-400'
            }`}
          >
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => {
          const isSelected =
            item.providerID === selected?.providerID &&
            item.modelID === selected?.modelID;
          const hasVariants = item.variants && Object.keys(item.variants).length > 0;

          return (
            <TouchableOpacity
              onPress={() => handleSelect(item)}
              className={`flex-row items-center rounded-xl px-4 py-3 mb-0.5 ${
                isSelected ? (isDark ? 'bg-zinc-800' : 'bg-zinc-100') : ''
              }`}
              activeOpacity={0.6}
            >
              <View className="flex-1">
                <Text
                  className={`text-sm ${
                    isSelected
                      ? isDark ? 'text-white font-semibold' : 'text-zinc-900 font-semibold'
                      : isDark ? 'text-zinc-300' : 'text-zinc-700'
                  }`}
                >
                  {item.modelName}
                </Text>
              </View>

              <View className="flex-row items-center">
                {hasVariants && (
                  <View className={`rounded px-1.5 py-0.5 mr-2 ${isDark ? 'bg-zinc-800' : 'bg-zinc-100'}`}>
                    <Text className={`text-[10px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                      Thinking
                    </Text>
                  </View>
                )}
                {isSelected && (
                  <Ionicons name="checkmark" size={18} color={isDark ? '#22c55e' : '#16a34a'} />
                )}
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View className="items-center py-8">
            <Text className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              No models found
            </Text>
          </View>
        }
      />
    </View>
  );
}
