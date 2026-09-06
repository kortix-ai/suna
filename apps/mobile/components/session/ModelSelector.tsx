/**
 * ModelSelector — bottom sheet for selecting the model + provider.
 *
 * Groups models by provider, with a search bar.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { View, FlatList, SectionList } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { THEME } from '@/lib/utils/theme';
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
    <View className="rounded-t-2xl bg-popover">
      {/* Handle */}
      <View className="items-center pt-3 pb-1">
        <View className="h-1 w-10 rounded-full bg-border" />
      </View>

      {/* Header */}
      <View className="flex-row items-center justify-between px-5 py-3">
        <Text className="text-base font-semibold text-foreground">
          Model
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

      {/* Search */}
      <View className="px-4 pb-2">
        <Input
          value={search}
          onChangeText={setSearch}
          placeholder="Search models..."
          className="rounded-lg"
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
          <Text className="text-xs font-medium uppercase tracking-wider px-4 pt-3 pb-1 text-muted-foreground">
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => {
          const isSelected =
            item.providerID === selected?.providerID &&
            item.modelID === selected?.modelID;
          const hasVariants = item.variants && Object.keys(item.variants).length > 0;

          return (
            <Button
              variant="ghost"
              onPress={() => handleSelect(item)}
              className={`h-auto flex-row items-center justify-start rounded-xl px-4 py-3 mb-0.5 active:opacity-60 ${
                isSelected ? 'bg-accent' : ''
              }`}
            >
              <View className="flex-1">
                <Text
                  className={`text-sm ${
                    isSelected ? 'text-foreground font-semibold' : 'text-muted-foreground'
                  }`}
                >
                  {item.modelName}
                </Text>
              </View>

              <View className="flex-row items-center">
                {hasVariants && (
                  <View className="rounded px-1.5 py-0.5 mr-2 bg-muted">
                    <Text className="text-[10px] text-muted-foreground">
                      Thinking
                    </Text>
                  </View>
                )}
                {isSelected && (
                  <Ionicons name="checkmark" size={18} color={THEME.accent.green} />
                )}
              </View>
            </Button>
          );
        }}
        ListEmptyComponent={
          <View className="items-center py-8">
            <Text className="text-sm text-muted-foreground">
              No models found
            </Text>
          </View>
        }
      />
    </View>
  );
}
