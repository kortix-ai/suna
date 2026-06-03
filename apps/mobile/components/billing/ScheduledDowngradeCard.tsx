/**
 * Scheduled Change Card Component
 * 
 * Shows scheduled tier changes.
 */

import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CalendarClock, ArrowRight, Calendar } from 'lucide-react-native';
import { PricingTierBadge } from './PricingTierBadge';
import { useColorScheme } from 'nativewind';

interface ScheduledChangeProps {
  type?: 'upgrade' | 'downgrade' | 'change';
    current_tier: {
      name: string;
      display_name: string;
      monthly_credits?: number;
    };
    target_tier: {
      name: string;
      display_name: string;
      monthly_credits?: number;
    };
    effective_date: string;
}

interface ScheduledDowngradeCardProps {
  scheduledChange: ScheduledChangeProps;
  variant?: 'default' | 'compact';
}

export function ScheduledDowngradeCard({ 
  scheduledChange,
  variant = 'default'
}: ScheduledDowngradeCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const effectiveDate = new Date(scheduledChange.effective_date);
  const currentTierName = scheduledChange.current_tier.display_name || scheduledChange.current_tier.name;
  const targetTierName = scheduledChange.target_tier.display_name || scheduledChange.target_tier.name;

  const formatDate = (date: Date) => date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

  const daysRemaining = Math.max(0, Math.ceil(
    (effectiveDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  ));

  if (variant === 'compact') {
    return (
      <View className="flex-row items-center gap-3 p-3 rounded-xl border border-amber-500/20 bg-amber-500/5">
        <Icon as={CalendarClock} size={16} className="text-amber-500" strokeWidth={2} />
        <View className="flex-1 flex-row items-center gap-2 flex-wrap">
          <PricingTierBadge planName={currentTierName} size="sm" />
          <Icon as={ArrowRight} size={12} className="text-muted-foreground" strokeWidth={2} />
          <View className="opacity-60">
            <PricingTierBadge planName={targetTierName} size="sm" />
          </View>
          <Text className="text-xs text-muted-foreground">
            on {formatDate(effectiveDate)}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="border border-amber-500/20 bg-amber-500/5 rounded-[18px] p-4">
        {/* Header */}
        <View className="flex-row items-start justify-between gap-3 mb-4">
          <View className="flex-row items-center gap-2">
            <Icon as={CalendarClock} size={20} className="text-amber-500" strokeWidth={2} />
            <Text className="text-sm font-roobert-semibold text-foreground">
              Scheduled Plan Change
            </Text>
          </View>
          <View className="px-2 py-0.5 rounded-full bg-amber-500/10">
            <Text className={`text-xs font-roobert-medium ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              {daysRemaining === 0 ? 'Today' : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`}
            </Text>
          </View>
        </View>

        {/* Plan Change */}
        <View className="flex-row items-center gap-3 mb-4">
          <PricingTierBadge planName={currentTierName} size="md" />
          <Icon as={ArrowRight} size={16} className="text-muted-foreground" strokeWidth={2} />
          <View className="opacity-60">
            <PricingTierBadge planName={targetTierName} size="md" />
          </View>
        </View>
        
        {/* Date and Action */}
        <View className="flex-row items-center justify-between pt-3 border-t border-border/50">
          <View className="flex-row items-center gap-2">
            <Icon as={Calendar} size={16} className="text-muted-foreground" strokeWidth={2} />
            <Text className="text-sm text-muted-foreground">
              {formatDate(effectiveDate)}
            </Text>
          </View>
        </View>
      </View>
  );
}
