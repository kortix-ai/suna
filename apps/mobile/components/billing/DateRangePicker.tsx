/**
 * Mobile Date Range Picker Component
 * 
 * Matches web's DateRangePicker functionality with mobile-friendly UX
 */

import React, { useState } from 'react';
import { View, Pressable, Modal, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Calendar, X, ChevronDown } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface DateRange {
  from: Date | null;
  to: Date | null;
}

interface DateRangePickerProps {
  initialDateFrom?: Date;
  initialDateTo?: Date;
  onUpdate?: (values: { range: DateRange }) => void;
  t: (key: string, defaultValue?: string) => string;
}

interface Preset {
  name: string;
  label: string;
  getRange: () => DateRange;
}

const PRESETS: Preset[] = [
  {
    name: 'today',
    label: 'Today',
    getRange: () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date();
      to.setHours(23, 59, 59, 999);
      return { from, to };
    },
  },
  {
    name: 'yesterday',
    label: 'Yesterday',
    getRange: () => {
      const from = new Date();
      from.setDate(from.getDate() - 1);
      from.setHours(0, 0, 0, 0);
      const to = new Date();
      to.setDate(to.getDate() - 1);
      to.setHours(23, 59, 59, 999);
      return { from, to };
    },
  },
  {
    name: 'last7',
    label: 'Last 7 days',
    getRange: () => {
      const to = new Date();
      to.setHours(23, 59, 59, 999);
      const from = new Date();
      from.setDate(from.getDate() - 6);
      from.setHours(0, 0, 0, 0);
      return { from, to };
    },
  },
  {
    name: 'last30',
    label: 'Last 30 days',
    getRange: () => {
      const to = new Date();
      to.setHours(23, 59, 59, 999);
      const from = new Date();
      from.setDate(from.getDate() - 29);
      from.setHours(0, 0, 0, 0);
      return { from, to };
    },
  },
  {
    name: 'thisMonth',
    label: 'This Month',
    getRange: () => {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      from.setHours(0, 0, 0, 0);
      const to = new Date();
      to.setHours(23, 59, 59, 999);
      return { from, to };
    },
  },
  {
    name: 'lastMonth',
    label: 'Last Month',
    getRange: () => {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      from.setHours(0, 0, 0, 0);
      const to = new Date(now.getFullYear(), now.getMonth(), 0);
      to.setHours(23, 59, 59, 999);
      return { from, to };
    },
  },
];

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function DateRangePicker({
  initialDateFrom,
  initialDateTo,
  onUpdate,
  t,
}: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [range, setRange] = useState<DateRange>({
    from: initialDateFrom || null,
    to: initialDateTo || null,
  });
  const insets = useSafeAreaInsets();

  const handlePresetSelect = (preset: Preset) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const newRange = preset.getRange();
    setRange(newRange);
    setIsOpen(false);
    onUpdate?.({ range: newRange });
  };

  const handleOpen = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsOpen(true);
  };

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsOpen(false);
  };

  const displayText = range.from && range.to
    ? `${formatDate(range.from)} - ${formatDate(range.to)}`
    : t('usage.selectPeriod', 'Select period');

  return (
    <>
      <Pressable
        onPress={handleOpen}
        className="bg-muted/30 rounded-xl px-3 py-2 flex-row items-center gap-2"
      >
        <Icon as={Calendar} size={14} className="text-foreground" strokeWidth={2} />
        <Text className="text-xs font-roobert-medium text-foreground flex-1">
          {displayText}
        </Text>
        <Icon as={ChevronDown} size={14} className="text-muted-foreground" strokeWidth={2} />
      </Pressable>

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
      >
        <Pressable
          onPress={handleClose}
          className="flex-1 bg-black/50 items-center justify-end"
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="w-full bg-background rounded-t-3xl"
            style={{ paddingBottom: insets.bottom + 20 }}
          >
            <View className="px-6 pt-4 pb-2">
              <View className="flex-row items-center justify-between mb-4">
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {t('usage.selectPeriod', 'Select Period')}
                </Text>
                <Pressable onPress={handleClose}>
                  <Icon as={X} size={20} className="text-muted-foreground" strokeWidth={2} />
                </Pressable>
              </View>
            </View>

            <ScrollView className="px-6" showsVerticalScrollIndicator={false}>
              <View className="gap-2 pb-4">
                {PRESETS.map((preset) => (
                  <Pressable
                    key={preset.name}
                    onPress={() => handlePresetSelect(preset)}
                    className="bg-card border border-border rounded-2xl p-4 active:opacity-80"
                  >
                    <Text className="text-base font-roobert-medium text-foreground">
                      {preset.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
