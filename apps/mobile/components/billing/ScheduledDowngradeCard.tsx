/**
 * Scheduled Change Card Component
 * 
 * Matches frontend's scheduled-downgrade-card.tsx exactly
 * Shows scheduled tier changes with cancel option
 */

import React, { useState } from 'react';
import { View, Pressable, Modal } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CalendarClock, ArrowRight, Undo2, Calendar } from 'lucide-react-native';
import { useCancelScheduledChange } from '@/lib/billing';
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
  onCancel?: () => void;
  variant?: 'default' | 'compact';
}

export function ScheduledDowngradeCard({ 
  scheduledChange,
  onCancel,
  variant = 'default'
}: ScheduledDowngradeCardProps) {
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const cancelScheduledChangeMutation = useCancelScheduledChange();
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

  const handleCancelChange = () => {
    cancelScheduledChangeMutation.mutate(undefined, {
      onSuccess: () => {
        setShowConfirmDialog(false);
        onCancel?.();
      }
    });
  };

  // Compact variant - matches frontend exactly
  if (variant === 'compact') {
  return (
    <>
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
            <Pressable
              onPress={() => setShowConfirmDialog(true)}
            className="h-7 px-2 rounded-lg flex-row items-center"
            >
            <Icon as={Undo2} size={12} className={isDark ? 'text-amber-400' : 'text-amber-600'} strokeWidth={2} />
            <Text className={`text-xs font-roobert-medium ml-1 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              Undo
            </Text>
            </Pressable>
          </View>
          
        <ConfirmDialog
          visible={showConfirmDialog}
          onClose={() => setShowConfirmDialog(false)}
          onConfirm={handleCancelChange}
          isPending={cancelScheduledChangeMutation.isPending}
          currentTierName={currentTierName}
          targetTierName={targetTierName}
          isDark={isDark}
        />
      </>
    );
  }

  // Default variant - matches frontend exactly
  return (
    <>
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
          <Pressable
            onPress={() => setShowConfirmDialog(true)}
            className={`h-8 px-3 rounded-xl flex-row items-center border ${
              isDark ? 'border-amber-500/30' : 'border-amber-500/30'
            }`}
          >
            <Icon as={Undo2} size={14} className={isDark ? 'text-amber-400' : 'text-amber-600'} strokeWidth={2} />
            <Text className={`text-xs font-roobert-medium ml-1.5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              Keep Current Plan
            </Text>
          </Pressable>
        </View>
      </View>

      <ConfirmDialog
        visible={showConfirmDialog}
        onClose={() => setShowConfirmDialog(false)}
        onConfirm={handleCancelChange}
        isPending={cancelScheduledChangeMutation.isPending}
        currentTierName={currentTierName}
        targetTierName={targetTierName}
        isDark={isDark}
      />
    </>
  );
}

// Extracted confirm dialog for cleaner code
function ConfirmDialog({
  visible,
  onClose,
  onConfirm,
  isPending,
  currentTierName,
  targetTierName,
  isDark,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
  currentTierName: string;
  targetTierName: string;
  isDark: boolean;
}) {
  return (
    <Modal
      visible={visible}
        transparent
        animationType="fade"
      onRequestClose={onClose}
      >
        <View className="flex-1 bg-black/50 items-center justify-center px-6">
          <View className="bg-card rounded-2xl p-6 w-full max-w-md">
          {/* Header */}
          <View className="flex-row items-center gap-2 mb-3">
            <Icon as={Undo2} size={20} className="text-primary" strokeWidth={2} />
            <Text className="text-lg font-roobert-semibold text-foreground">
              Keep Your Current Plan?
            </Text>
          </View>
          
          {/* Description */}
          <View className="mb-6">
            <Text className="text-sm text-muted-foreground leading-relaxed mb-2">
              Your scheduled change from{' '}
              <Text className="font-roobert-medium text-foreground">{currentTierName}</Text> to{' '}
              <Text className="font-roobert-medium text-foreground">{targetTierName}</Text> will be cancelled.
            </Text>
            <Text className="text-sm text-muted-foreground leading-relaxed">
              You'll continue on your{' '}
              <Text className="font-roobert-medium text-foreground">{currentTierName}</Text> plan with all its benefits.
            </Text>
          </View>
            
          {/* Actions */}
            <View className="flex-row gap-3">
              <Pressable
              onPress={onClose}
              disabled={isPending}
                className="flex-1 h-10 border border-border rounded-xl items-center justify-center"
              >
                <Text className="text-sm font-roobert-medium text-foreground">
                Never Mind
                </Text>
              </Pressable>
              <Pressable
              onPress={onConfirm}
              disabled={isPending}
                className="flex-1 h-10 bg-primary rounded-xl items-center justify-center"
              >
                <Text className="text-sm font-roobert-medium text-primary-foreground">
                {isPending ? 'Cancelling...' : 'Keep Current Plan'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
  );
}
