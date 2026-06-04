/**
 * Trigger Detail Page Component
 *
 * Clean, modern detail view for viewing/managing a single trigger
 * Matches the ThreadPage design language with consistent spacing and typography
 */

import React, { useState } from 'react';
import { View, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/ui/Avatar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import {
  ChevronLeft,
  Edit,
  Trash2,
  Copy,
  Clock,
  Zap,
  Calendar,
  MessageSquare,
  Globe,
  CheckCircle2,
  XCircle,
} from 'lucide-react-native';
import { useTrigger, useDeleteTrigger, useToggleTrigger } from '@/lib/triggers';
import { TriggerCreationDrawer } from '@/components/triggers/TriggerCreationDrawer';
import { log } from '@/lib/logger';
import {
  getTriggerIcon,
  getTriggerCategory,
  formatCronExpression,
  formatTriggerDate,
} from '@/lib/utils/trigger-utils';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TriggerDetailPageProps {
  triggerId: string;
}

/**
 * Action Button Component
 * Consistent button style matching the app's design system
 */
function ActionButton({
  icon: IconComponent,
  label,
  onPress,
  variant = 'default',
  disabled = false,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
}) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      style={animatedStyle}
      className={`flex-row items-center justify-center gap-2 rounded-2xl px-4 py-4 ${
        variant === 'destructive' ? 'bg-destructive' : 'border border-border bg-secondary'
      } ${disabled ? 'opacity-50' : ''}`}>
      <Icon
        as={IconComponent}
        size={20}
        className={variant === 'destructive' ? 'text-white' : 'text-foreground'}
      />
      <Text
        className={`font-roobert-medium text-base ${
          variant === 'destructive' ? 'text-white' : 'text-foreground'
        }`}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

/**
 * Info Row Component
 * Consistent info display with icon, label, and value
 */
function InfoRow({
  icon: IconComponent,
  label,
  value,
  mono = false,
}: {
  icon: any;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View className="mb-4 flex-row items-start gap-3">
      <Avatar variant="custom" icon={IconComponent} size={40} />
      <View className="flex-1">
        <Text className="mb-1 font-roobert text-sm text-muted-foreground">{label}</Text>
        <Text
          className="font-roobert-medium text-base text-foreground"
          style={mono ? { fontFamily: 'monospace' } : undefined}
          numberOfLines={mono ? undefined : 3}>
          {value}
        </Text>
      </View>
    </View>
  );
}

/**
 * Section Component
 * Consistent section container
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-8">
      <Text className="mb-4 font-roobert-semibold text-lg text-foreground">{title}</Text>
      {children}
    </View>
  );
}

export function TriggerDetailPage({ triggerId }: TriggerDetailPageProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const backScale = useSharedValue(1);

  const { data: trigger, isLoading, error, refetch } = useTrigger(triggerId);
  const deleteTriggerMutation = useDeleteTrigger();
  const toggleTriggerMutation = useToggleTrigger();
  const [showEditDrawer, setShowEditDrawer] = useState(false);

  const backAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: backScale.value }],
  }));

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const handleToggleActive = async () => {
    if (!trigger) return;

    try {
      await toggleTriggerMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        isActive: !trigger.is_active,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      log.log('🔄 Trigger toggled successfully:', trigger.trigger_id);
      refetch();
    } catch (error) {
      log.error('Error toggling trigger:', error);
      Alert.alert('Error', 'Failed to update trigger status. Please try again.');
    }
  };

  const handleDelete = () => {
    if (!trigger) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Delete Trigger',
      `Are you sure you want to delete "${trigger.name}"? This action cannot be undone.`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteTriggerMutation.mutateAsync({
                triggerId: trigger.trigger_id,
                agentId: trigger.agent_id,
              });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              router.back();
            } catch (error) {
              log.error('Error deleting trigger:', error);
              Alert.alert('Error', 'Failed to delete trigger. Please try again.');
            }
          },
        },
      ]
    );
  };

  const handleCopyWebhookUrl = async () => {
    if (!trigger?.webhook_url) return;

    // TODO: Implement clipboard functionality with Expo Clipboard
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert('Copied!', 'Webhook URL copied to clipboard');
  };

  // Loading State
  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-8">
          <View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-secondary/30">
            <ActivityIndicator
              size="large"
              color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'}
            />
          </View>
          <Text className="text-center font-roobert-semibold text-lg text-foreground">
            Loading trigger...
          </Text>
          <Text className="mt-2 text-center font-roobert text-sm text-muted-foreground">
            Fetching trigger details
          </Text>
        </View>
      </View>
    );
  }

  // Error State
  if (error || !trigger) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <View className="mb-4 h-20 w-20 items-center justify-center rounded-full bg-destructive/20">
            <Icon as={XCircle} size={40} className="text-destructive" />
          </View>
          <Text className="mb-2 text-center font-roobert-semibold text-lg text-foreground">
            Trigger Not Found
          </Text>
          <Text className="mb-6 text-center font-roobert text-sm text-muted-foreground">
            This trigger may have been deleted or you don't have permission to view it.
          </Text>
          <ActionButton icon={ChevronLeft} label="Go Back" onPress={handleBack} />
        </View>
      </View>
    );
  }

  const IconComponent = getTriggerIcon(trigger.trigger_type);
  const category = getTriggerCategory(trigger.trigger_type);
  const formattedDate = formatTriggerDate(trigger.created_at);

  return (
    <View className="flex-1 bg-background">
      {/* Header - Fixed at top, matching ThreadHeader style */}
      <View
        className="absolute left-0 right-0 top-0 z-50 border-b border-border/20 bg-background"
        style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center justify-between px-6 py-3">
          {/* Left - Back Button */}
          <AnimatedPressable
            onPressIn={() => {
              backScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              backScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            onPress={handleBack}
            style={backAnimatedStyle}
            className="-ml-2 h-8 w-8 items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel="Go back">
            <Icon as={ChevronLeft} size={20} className="text-foreground/70" strokeWidth={2} />
          </AnimatedPressable>

          {/* Center - Title */}
          <View className="mx-4 flex-1">
            <Text
              className="text-center font-roobert-semibold text-sm text-foreground"
              numberOfLines={1}>
              Trigger Details
            </Text>
          </View>

          {/* Right - Placeholder for symmetry */}
          <View className="h-8 w-8" />
        </View>
      </View>

      {/* Scrollable Content */}
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={true}
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 80, // Safe area + header height
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        bounces={true}
        alwaysBounceVertical={false}>
        {/* Trigger Icon & Name */}
        <View className="mb-8 items-center">
          <View className="mb-4 h-20 w-20 items-center justify-center rounded-full bg-secondary">
            <Icon as={IconComponent} size={36} className="text-foreground" />
          </View>
          <Text className="mb-2 text-center font-roobert-semibold text-2xl text-foreground">
            {trigger.name}
          </Text>
          {trigger.description && (
            <Text className="text-center font-roobert text-base text-muted-foreground">
              {trigger.description}
            </Text>
          )}
        </View>

        {/* Status Toggle */}
        <View className="mb-8">
          <Pressable
            onPress={handleToggleActive}
            disabled={toggleTriggerMutation.isPending}
            className={`flex-row items-center justify-between rounded-2xl p-4 ${
              trigger.is_active
                ? 'border border-green-500/30 bg-green-500/10'
                : 'border border-border bg-secondary'
            } ${toggleTriggerMutation.isPending ? 'opacity-50' : ''}`}>
            <View className="flex-row items-center gap-3">
              <View
                className={`h-3 w-3 rounded-full ${trigger.is_active ? 'bg-green-500' : 'bg-muted-foreground'}`}
              />
              <Text
                className={`font-roobert-medium text-base ${
                  trigger.is_active ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'
                }`}>
                {trigger.is_active ? 'Active' : 'Inactive'}
              </Text>
            </View>
            <Text className="font-roobert text-sm text-muted-foreground">
              Tap to {trigger.is_active ? 'disable' : 'enable'}
            </Text>
          </Pressable>
        </View>

        {/* Basic Information */}
        <Section title="Information">
          <InfoRow
            icon={Zap}
            label="Type"
            value={category === 'scheduled' ? 'Scheduled Trigger' : 'Event Trigger'}
          />
          <InfoRow icon={Calendar} label="Created" value={formattedDate} />
        </Section>

        {/* Schedule Configuration */}
        {category === 'scheduled' && trigger.config?.cron_expression && (
          <Section title="Schedule">
            <InfoRow
              icon={Clock}
              label="Schedule"
              value={formatCronExpression(trigger.config.cron_expression)}
            />
            <InfoRow
              icon={Globe}
              label="Cron Expression"
              value={trigger.config.cron_expression}
              mono
            />
            {trigger.config.timezone && (
              <InfoRow icon={Globe} label="Timezone" value={trigger.config.timezone} />
            )}
          </Section>
        )}

        {/* Agent Prompt */}
        {trigger.config?.agent_prompt && (
          <Section title="Worker Prompt">
            <InfoRow icon={MessageSquare} label="Instruction" value={trigger.config.agent_prompt} />
          </Section>
        )}

        {/* Webhook URL */}
        {trigger.webhook_url && (
          <Section title="Webhook">
            <Pressable
              onPress={handleCopyWebhookUrl}
              className="flex-row items-center gap-3 rounded-2xl bg-secondary p-4 active:bg-secondary/80">
              <View className="flex-1">
                <Text className="font-mono text-xs text-foreground" numberOfLines={2}>
                  {trigger.webhook_url}
                </Text>
              </View>
              <Icon as={Copy} size={20} className="text-foreground/70" />
            </Pressable>
          </Section>
        )}

        {/* Actions */}
        <Section title="Actions">
          <View className="gap-3">
            <ActionButton
              icon={Edit}
              label="Edit Trigger"
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setShowEditDrawer(true);
              }}
            />
            <ActionButton
              icon={Trash2}
              label="Delete Trigger"
              onPress={handleDelete}
              variant="destructive"
              disabled={deleteTriggerMutation.isPending}
            />
          </View>
        </Section>
      </ScrollView>

      {/* Edit Drawer */}
      <TriggerCreationDrawer
        visible={showEditDrawer}
        onClose={() => setShowEditDrawer(false)}
        onTriggerUpdated={(triggerId) => {
          refetch();
          setShowEditDrawer(false);
        }}
        isEditMode={true}
        existingTrigger={trigger || null}
      />
    </View>
  );
}
