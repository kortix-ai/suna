/**
 * Trigger Selection Step Component
 *
 * Displays available triggers for a selected app
 * Matches frontend design adapted for mobile
 * Returns content only - no ScrollView (parent handles scrolling)
 */

import React from 'react';
import { View, Image } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Zap, ChevronRight } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Loading } from '../loading/loading';
import { Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { ComposioTriggerType, TriggerApp } from '@/api/types';
import { SvgUri } from 'react-native-svg';
import { useLanguage } from '@/contexts/LanguageContext';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TriggerSelectionStepProps {
  app: TriggerApp | null;
  triggers: ComposioTriggerType[];
  isLoading: boolean;
  onTriggerSelect: (trigger: ComposioTriggerType) => void;
}

interface TriggerCardProps {
  trigger: ComposioTriggerType;
  app: TriggerApp;
  onPress: () => void;
}

function TriggerCard({ trigger, app, onPress }: TriggerCardProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handlePressOut = () => {
    scale.value = withSpring(1);
  };

  const isSvg = (url: string) =>
    url.toLowerCase().endsWith('.svg') || url.includes('composio.dev/api');

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="mb-3 rounded-2xl border border-border bg-card p-4 active:opacity-80">
      <View className="space-y-3">
        {/* Header with logo and badge */}
        <View className="flex-row items-start justify-between">
          {app.logo ? (
            <View className="h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
              {isSvg(app.logo) ? (
                <SvgUri uri={app.logo} width={24} height={24} />
              ) : (
                <Image
                  source={{ uri: app.logo }}
                  style={{ width: 24, height: 24 }}
                  resizeMode="contain"
                />
              )}
            </View>
          ) : (
            <View className="h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
              <Icon as={Zap} size={20} className="text-muted-foreground" />
            </View>
          )}
          <View className="rounded-lg bg-muted px-2 py-1">
            <Text className="font-roobert-semibold text-xs uppercase tracking-wide text-foreground">
              {trigger.type}
            </Text>
          </View>
        </View>

        {/* Trigger name and description */}
        <View className="space-y-2">
          <Text className="font-roobert-medium text-base text-foreground">{trigger.name}</Text>
          {trigger.description && (
            <Text
              className="mb-2 mt-1 text-xs leading-relaxed text-muted-foreground"
              numberOfLines={2}>
              {trigger.description}
            </Text>
          )}
        </View>

        {/* Trigger slug */}
        <View className="flex-row items-center justify-between border-t border-border pt-2">
          <View className="rounded-md bg-muted px-2 py-1">
            <Text className="font-mono text-xs text-muted-foreground" numberOfLines={1}>
              {trigger.slug.length > 25 ? `${trigger.slug.substring(0, 25)}...` : trigger.slug}
            </Text>
          </View>
          <Icon as={ChevronRight} size={16} className="text-muted-foreground" />
        </View>
      </View>
    </AnimatedPressable>
  );
}

export function TriggerSelectionStep({
  app,
  triggers,
  isLoading,
  onTriggerSelect,
}: TriggerSelectionStepProps) {
  const { t } = useLanguage();

  if (!app) {
    return null;
  }

  if (isLoading) {
    return <Loading title={t('triggers.loadingTriggers')} />;
  }

  if (triggers.length === 0) {
    return (
      <View className="items-center justify-center py-16">
        <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
          <Icon as={Zap} size={24} className="text-muted-foreground" />
        </View>
        <Text className="mb-1 font-roobert-semibold text-base text-foreground">
          {t('triggers.noTriggersAvailable')}
        </Text>
        <Text className="text-center text-sm text-muted-foreground">
          {t('triggers.noTriggersYet')}
        </Text>
      </View>
    );
  }

  const isSvg = (url: string) =>
    url.toLowerCase().endsWith('.svg') || url.includes('composio.dev/api');

  return (
    <View className="space-y-6">
      {/* Header */}
      <View className="mb-6 flex-row items-center gap-3">
        {app.logo && (
          <View className="h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
            {isSvg(app.logo) ? (
              <SvgUri uri={app.logo} width={24} height={24} />
            ) : (
              <Image
                source={{ uri: app.logo }}
                style={{ width: 24, height: 24 }}
                resizeMode="contain"
              />
            )}
          </View>
        )}
        <View className="flex-1">
          <Text className="font-roobert-semibold text-lg text-foreground">
            {app.name} {t('triggers.triggers')}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {t('triggers.chooseEventToMonitor')}
          </Text>
        </View>
      </View>

      {/* Triggers List */}
      <View>
        {triggers.map((trigger) => (
          <TriggerCard
            key={trigger.slug}
            trigger={trigger}
            app={app}
            onPress={() => onTriggerSelect(trigger)}
          />
        ))}
      </View>
    </View>
  );
}
