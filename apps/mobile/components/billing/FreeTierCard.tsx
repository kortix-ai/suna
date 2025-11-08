/**
 * Free Tier Card Component
 *
 * Showcases the free tier value proposition
 * Encourages exploration and highlights capabilities
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Sparkles, CheckCircle, ArrowRight } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface FreeTierCardProps {
  onGetStarted?: () => void;
  showGetStarted?: boolean;
  t: (key: string, defaultValue?: string) => string;
}

export function FreeTierCard({ onGetStarted, showGetStarted = true, t }: FreeTierCardProps) {
  const handleGetStarted = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onGetStarted?.();
  };

  return (
    <View className="bg-card border-[1.5px] border-border rounded-2xl p-6 mb-4">
      {/* Header */}
      <View className="flex-row items-center gap-2 mb-4">
        <View className="w-8 h-8 rounded-full bg-primary/10 items-center justify-center">
          <Icon as={Sparkles} size={16} className="text-primary" strokeWidth={2} />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground">
          {t('billing.freeTier.title', 'Free Forever')}
        </Text>
      </View>

      {/* Description */}
      <Text className="text-muted-foreground mb-6 leading-relaxed">
        {t('billing.freeTier.description', 'Start building amazing automations with our generous free tier. No credit card required.')}
      </Text>

      {/* Key Benefits */}
      <View className="space-y-3 mb-6">
        <View className="flex-row items-center gap-3">
          <Icon as={CheckCircle} size={18} className="text-primary" strokeWidth={2} />
          <Text className="text-foreground font-roobert-medium">
            {t('billing.freeTier.benefit1', '1,000 credits per month')}
          </Text>
        </View>
        <View className="flex-row items-center gap-3">
          <Icon as={CheckCircle} size={18} className="text-primary" strokeWidth={2} />
          <Text className="text-foreground font-roobert-medium">
            {t('billing.freeTier.benefit2', '5 custom agents')}
          </Text>
        </View>
        <View className="flex-row items-center gap-3">
          <Icon as={CheckCircle} size={18} className="text-primary" strokeWidth={2} />
          <Text className="text-foreground font-roobert-medium">
            {t('billing.freeTier.benefit3', '3 private projects')}
          </Text>
        </View>
        <View className="flex-row items-center gap-3">
          <Icon as={CheckCircle} size={18} className="text-primary" strokeWidth={2} />
          <Text className="text-foreground font-roobert-medium">
            {t('billing.freeTier.benefit4', 'Access to basic AI models')}
          </Text>
        </View>
      </View>

      {/* What you can build */}
      <View className="bg-primary/5 rounded-xl p-4 mb-6">
        <Text className="text-sm font-roobert-medium text-foreground mb-2">
          {t('billing.freeTier.examples', 'What you can build:')}
        </Text>
        <View className="space-y-1">
          <Text className="text-xs text-muted-foreground">• Social media automation</Text>
          <Text className="text-xs text-muted-foreground">• Email marketing workflows</Text>
          <Text className="text-xs text-muted-foreground">• Data processing agents</Text>
          <Text className="text-xs text-muted-foreground">• Content generation tools</Text>
        </View>
      </View>

      {/* CTA */}
      {showGetStarted && (
        <Pressable
          onPress={handleGetStarted}
          className="bg-primary h-12 rounded-xl items-center justify-center flex-row gap-2"
        >
          <Text className="text-primary-foreground font-roobert-medium">
            {t('billing.freeTier.getStarted', 'Start Building')}
          </Text>
          <Icon as={ArrowRight} size={16} className="text-primary-foreground" strokeWidth={2} />
        </Pressable>
      )}
    </View>
  );
}
