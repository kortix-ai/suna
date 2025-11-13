/**
 * Credits Card Component
 * 
 * Displays user's credit balance with breakdown
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Coins, ChevronRight } from 'lucide-react-native';
import type { CreditBalance } from '@/lib/billing/api';
import { formatCredits } from '@/lib/utils/credit-formatter';

interface CreditsCardProps {
  creditBalance: CreditBalance | null;
  totalCredits: number;
  onPress: () => void;
  t: (key: string) => string;
}

export function CreditsCard({
  creditBalance,
  totalCredits,
  onPress,
  t,
}: CreditsCardProps) {
  return (
    <Pressable
      onPress={onPress}
      className="bg-card border-[1.5px] border-border rounded-2xl p-4 mb-3"
    >
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row items-center gap-2">
          <Icon as={Coins} size={18} className="text-primary" strokeWidth={2} />
          <Text className="text-sm font-roobert-medium text-muted-foreground">
            {t('billing.credits')}
          </Text>
        </View>
        <Icon as={ChevronRight} size={16} className="text-foreground/40" strokeWidth={2} />
      </View>
      
      <View className="flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="text-lg font-roobert-semibold text-foreground">
            {formatCredits(creditBalance?.balance || 0)}
          </Text>
          {creditBalance && (creditBalance.expiring_credits > 0 || creditBalance.non_expiring_credits > 0) && (
            <Text className="text-xs font-roobert text-muted-foreground mt-0.5">
              {formatCredits(creditBalance.expiring_credits)} plan • {formatCredits(creditBalance.non_expiring_credits)} purchased
            </Text>
          )}
        </View>
        
        <View className="bg-primary/10 px-3 py-1.5 rounded-full border border-primary/30">
          <Text className="text-xs font-roobert-medium text-primary">
            {t('billing.buyCredits')}
          </Text>
        </View>
      </View>
      
      {/* Low credit warning */}
      {totalCredits < 1 && totalCredits >= 0 && (
        <View className="mt-3 pt-3 border-t border-border">
          <Text className="text-xs font-roobert text-destructive">
            {t('billing.lowCreditsWarning')}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

