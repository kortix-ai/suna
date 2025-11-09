/**
 * Scheduled Downgrade Card Component
 * 
 * Matches frontend's ScheduledDowngradeCard design
 * Shows scheduled tier changes with cancel option
 */

import React, { useState } from 'react';
import { View, Pressable, Modal, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Calendar, ArrowRight, X } from 'lucide-react-native';
import { useCancelScheduledChange } from '@/lib/billing';
import { PRICING_TIERS } from '@/lib/billing/pricing';
import { TierBadge } from '@/components/menu/TierBadge';
import type { TierType } from '@/components/menu/types';

interface ScheduledDowngradeCardProps {
  scheduledChange: {
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
  };
  onCancel?: () => void;
}

function getFrontendTierName(tierKey: string): string {
  const tier = PRICING_TIERS.find(p => p.id === tierKey);
  return tier?.displayName || tier?.name || 'Basic';
}

export function ScheduledDowngradeCard({ 
  scheduledChange,
  onCancel
}: ScheduledDowngradeCardProps) {
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const cancelScheduledChangeMutation = useCancelScheduledChange();

  const effectiveDate = new Date(scheduledChange.effective_date);

  const currentTierName = getFrontendTierName(scheduledChange.current_tier.name);
  const targetTierName = getFrontendTierName(scheduledChange.target_tier.name);
  
  // Get TierType for badges
  const getTierType = (tierName: string): TierType => {
    const name = tierName.toLowerCase();
    if (name === 'plus') return 'Plus';
    if (name === 'pro' || name === 'business') return 'Pro';
    if (name === 'ultra') return 'Ultra';
    return 'Basic'; // Default to Basic
  };
  
  const currentTierType = getTierType(currentTierName);
  const targetTierType = getTierType(targetTierName);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const daysRemaining = Math.ceil(
    (effectiveDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const handleCancelChange = () => {
    setShowConfirmDialog(false);
    cancelScheduledChangeMutation.mutate(undefined, {
      onSuccess: () => {
        if (onCancel) {
          onCancel();
        }
      }
    });
  };

  return (
    <>
      <View className="bg-card border border-border rounded-[18px] p-4">
        <View className="gap-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3">
              <TierBadge tier={currentTierType} size="small" />
              <Icon as={ArrowRight} size={16} className="text-muted-foreground" strokeWidth={2} />
              <View className="opacity-60">
                <TierBadge tier={targetTierType} size="small" />
              </View>
            </View>
            <Pressable
              onPress={() => setShowConfirmDialog(true)}
              className="p-1"
            >
              <Icon as={X} size={16} className="text-muted-foreground" strokeWidth={2} />
            </Pressable>
          </View>
          
          <View className="flex-row items-center gap-2">
            <Icon as={Calendar} size={16} className="text-muted-foreground" strokeWidth={2} />
            <Text className="text-sm font-roobert text-muted-foreground">
              {formatDate(effectiveDate)}
            </Text>
            {daysRemaining > 0 && (
              <Text className="text-xs font-roobert text-muted-foreground">
                ({daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} remaining)
              </Text>
            )}
          </View>
        </View>
      </View>

      {/* Confirm Dialog */}
      <Modal
        visible={showConfirmDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setShowConfirmDialog(false)}
      >
        <View className="flex-1 bg-black/50 items-center justify-center px-6">
          <View className="bg-card rounded-2xl p-6 w-full max-w-md">
            <Text className="text-lg font-roobert-semibold text-foreground mb-2">
              Cancel Scheduled Change
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground mb-6">
              Your current plan will continue without any changes.
            </Text>
            
            <View className="flex-row gap-3">
              <Pressable
                onPress={() => setShowConfirmDialog(false)}
                className="flex-1 h-10 border border-border rounded-xl items-center justify-center"
              >
                <Text className="text-sm font-roobert-medium text-foreground">
                  Keep Scheduled
                </Text>
              </Pressable>
              <Pressable
                onPress={handleCancelChange}
                disabled={cancelScheduledChangeMutation.isPending}
                className="flex-1 h-10 bg-primary rounded-xl items-center justify-center"
              >
                <Text className="text-sm font-roobert-medium text-primary-foreground">
                  {cancelScheduledChangeMutation.isPending ? 'Cancelling...' : 'Cancel Change'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

