/**
 * Triggers Screen Component
 *
 * Displays and manages triggers for a specific worker
 */

import React, { useState, useMemo, useCallback } from 'react';
import { View, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { Zap, Plus, Play, Pause, Settings, Trash2, Clock, Link2 } from 'lucide-react-native';
import { useAgentTriggers, useDeleteTrigger, useToggleTrigger } from '@/lib/triggers';
import { TriggerCreationDrawer } from '@/components/triggers/TriggerCreationDrawer';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import type { TriggerConfiguration } from '@/api/types';
import { useBillingContext } from '@/contexts/BillingContext';
import { FreeTierBlock } from '@/components/billing/FreeTierBlock';
import { useRouter } from 'expo-router';
import { EmptyState } from '@/components/shared/EmptyState';
import { useLanguage } from '@/contexts/LanguageContext';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TriggersScreenProps {
  agentId: string;
  onUpdate?: () => void;
  onUpgradePress?: () => void;
}

interface TriggerCardProps {
  trigger: TriggerConfiguration;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isToggling?: boolean;
  isDeleting?: boolean;
}

function TriggerCard({
  trigger,
  onToggle,
  onEdit,
  onDelete,
  isToggling = false,
  isDeleting = false,
}: TriggerCardProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1);
  };

  const isSchedule = trigger.provider_id === 'schedule' || trigger.trigger_type === 'schedule';
  const isLoading = isToggling || isDeleting;

  return (
    <AnimatedPressable
      style={[animatedStyle, { opacity: isLoading ? 0.6 : 1 }]}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      className="mb-3 rounded-2xl border border-border bg-card p-4">
      {isLoading && (
        <View
          className="absolute inset-0 z-10 items-center justify-center rounded-2xl"
          style={{
            backgroundColor:
              colorScheme === 'dark' ? 'rgba(24, 24, 27, 0.8)' : 'rgba(255, 255, 255, 0.8)',
          }}>
          <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
        </View>
      )}
      <View className="flex-row items-center justify-between">
        <View className="flex-1 flex-row items-center gap-3">
          <View className="h-12 w-12 items-center justify-center rounded-xl border border-border/50 bg-card">
            <Icon as={isSchedule ? Clock : Link2} size={20} className="text-foreground" />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="mb-1 font-roobert-medium text-base text-foreground" numberOfLines={1}>
              {trigger.name}
            </Text>
            <Text className="text-sm text-muted-foreground" numberOfLines={1}>
              {trigger.description || 'No description'}
            </Text>
          </View>
        </View>

        <View className="ml-4 flex-row items-center gap-2">
          <Pressable
            onPress={onToggle}
            disabled={isLoading}
            className="h-10 w-10 items-center justify-center rounded-xl bg-primary active:opacity-80"
            style={{ opacity: isLoading ? 0.5 : 1 }}>
            {isToggling ? (
              <ActivityIndicator
                size="small"
                color={colorScheme === 'dark' ? '#FFFFFF' : '#FFFFFF'}
              />
            ) : (
              <Icon
                as={trigger.is_active ? Pause : Play}
                size={18}
                className="text-primary-foreground"
              />
            )}
          </Pressable>

          <Pressable
            onPress={onEdit}
            disabled={isLoading}
            className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-card active:opacity-80"
            style={{ opacity: isLoading ? 0.5 : 1 }}>
            <Icon as={Settings} size={18} className="text-foreground" />
          </Pressable>

          <Pressable
            onPress={onDelete}
            disabled={isLoading}
            className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-card active:opacity-80"
            style={{ opacity: isLoading ? 0.5 : 1 }}>
            {isDeleting ? (
              <ActivityIndicator
                size="small"
                color={colorScheme === 'dark' ? '#EF4444' : '#DC2626'}
              />
            ) : (
              <Icon as={Trash2} size={18} className="text-muted-foreground" />
            )}
          </Pressable>
        </View>
      </View>
    </AnimatedPressable>
  );
}

export function TriggersScreen({ agentId, onUpdate, onUpgradePress }: TriggersScreenProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const { data: triggers = [], isLoading, refetch } = useAgentTriggers(agentId);
  const deleteTriggerMutation = useDeleteTrigger();
  const toggleTriggerMutation = useToggleTrigger();
  const { hasFreeTier } = useBillingContext();

  const [isCreateDrawerVisible, setIsCreateDrawerVisible] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<TriggerConfiguration | null>(null);
  const [deleteDialogTrigger, setDeleteDialogTrigger] = useState<TriggerConfiguration | null>(null);
  const [togglingTriggerId, setTogglingTriggerId] = useState<string | null>(null);
  const [deletingTriggerId, setDeletingTriggerId] = useState<string | null>(null);

  // Handle upgrade press - use provided callback or navigate to plans
  const handleUpgradePress = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if (onUpgradePress) {
      onUpgradePress();
    } else {
      router.push('/plans');
    }
  }, [onUpgradePress, router]);

  const runningTriggers = useMemo(
    () => triggers.filter((trigger) => trigger.is_active),
    [triggers]
  );

  const pausedTriggers = useMemo(
    () => triggers.filter((trigger) => !trigger.is_active),
    [triggers]
  );

  const handleToggleTrigger = async (trigger: TriggerConfiguration) => {
    setTogglingTriggerId(trigger.trigger_id);
    try {
      await toggleTriggerMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        isActive: !trigger.is_active,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      refetch();
      onUpdate?.();
    } catch (error: any) {
      Alert.alert('Error', error?.message || 'Failed to toggle trigger');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setTogglingTriggerId(null);
    }
  };

  const handleEditTrigger = (trigger: TriggerConfiguration) => {
    setEditingTrigger(trigger);
    setIsCreateDrawerVisible(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleDeleteClick = (trigger: TriggerConfiguration) => {
    setDeleteDialogTrigger(trigger);
    Alert.alert(
      'Delete Trigger',
      `Are you sure you want to delete "${trigger.name}"? This action cannot be undone and will stop all automated runs from this trigger.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => confirmDelete(trigger),
        },
      ]
    );
  };

  const confirmDelete = async (trigger: TriggerConfiguration) => {
    setDeletingTriggerId(trigger.trigger_id);
    try {
      await deleteTriggerMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        agentId: trigger.agent_id,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      refetch();
      onUpdate?.();
    } catch (error: any) {
      Alert.alert('Error', error?.message || 'Failed to delete trigger');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setDeleteDialogTrigger(null);
      setDeletingTriggerId(null);
    }
  };

  const handleTriggerCreated = (triggerId: string) => {
    setIsCreateDrawerVisible(false);
    setEditingTrigger(null);
    refetch();
    onUpdate?.();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleTriggerUpdated = (triggerId: string) => {
    setIsCreateDrawerVisible(false);
    setEditingTrigger(null);
    refetch();
    onUpdate?.();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  if (isLoading) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
        <Text className="mt-4 font-roobert text-sm text-muted-foreground">Loading triggers...</Text>
      </View>
    );
  }

  // Show free tier block if user is on free tier
  if (hasFreeTier) {
    return (
      <View className="flex-1 items-center justify-center px-4 py-8">
        <FreeTierBlock variant="triggers" onUpgradePress={handleUpgradePress} style="card" />
      </View>
    );
  }

  return (
    <View className="space-y-4">
      <View className="mb-2 flex-row items-center justify-between">
        <View className="flex-1 pr-3">
          <Text className="mb-2 font-roobert-semibold text-base text-foreground">Triggers</Text>
          <Text className="font-roobert text-sm text-muted-foreground">
            Automate your worker with scheduled or event-based triggers
          </Text>
        </View>
      </View>

      {/* Create Trigger Button - only show when there are triggers */}
      {!(runningTriggers.length === 0 && pausedTriggers.length === 0) && (
        <View className="mb-4 flex-row gap-3">
          <Pressable
            onPress={() => {
              setEditingTrigger(null);
              setIsCreateDrawerVisible(true);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 active:opacity-80">
            <Icon as={Plus} size={18} className="text-foreground" />
            <Text className="font-roobert-semibold text-base text-foreground">
              {t('triggers.createTrigger')}
            </Text>
          </Pressable>
        </View>
      )}

      {runningTriggers.length === 0 && pausedTriggers.length === 0 ? (
        <EmptyState
          icon={Zap}
          title={t('triggers.noTriggersConfigured')}
          description={t('triggers.setupTriggersToAutomate')}
          actionLabel={t('triggers.createTrigger')}
          onActionPress={() => {
            setEditingTrigger(null);
            setIsCreateDrawerVisible(true);
          }}
        />
      ) : (
        <>
          {/* Running Section */}
          {runningTriggers.length > 0 && (
            <View className="mb-4">
              <Text className="mb-3 font-roobert-medium text-sm text-foreground">Running</Text>
              <View>
                {runningTriggers.map((trigger) => (
                  <TriggerCard
                    key={trigger.trigger_id}
                    trigger={trigger}
                    onToggle={() => handleToggleTrigger(trigger)}
                    onEdit={() => handleEditTrigger(trigger)}
                    onDelete={() => handleDeleteClick(trigger)}
                    isToggling={togglingTriggerId === trigger.trigger_id}
                    isDeleting={deletingTriggerId === trigger.trigger_id}
                  />
                ))}
              </View>
            </View>
          )}

          {/* Paused Section */}
          {pausedTriggers.length > 0 && (
            <View>
              <Text className="mb-3 font-roobert-medium text-sm text-foreground">Paused</Text>
              <View>
                {pausedTriggers.map((trigger) => (
                  <TriggerCard
                    key={trigger.trigger_id}
                    trigger={trigger}
                    onToggle={() => handleToggleTrigger(trigger)}
                    onEdit={() => handleEditTrigger(trigger)}
                    onDelete={() => handleDeleteClick(trigger)}
                    isToggling={togglingTriggerId === trigger.trigger_id}
                    isDeleting={deletingTriggerId === trigger.trigger_id}
                  />
                ))}
              </View>
            </View>
          )}
        </>
      )}

      {/* Trigger Creation/Edit Drawer */}
      <TriggerCreationDrawer
        visible={isCreateDrawerVisible}
        agentId={agentId}
        onClose={() => {
          setIsCreateDrawerVisible(false);
          setEditingTrigger(null);
        }}
        onTriggerCreated={handleTriggerCreated}
        onTriggerUpdated={handleTriggerUpdated}
        isEditMode={!!editingTrigger}
        existingTrigger={editingTrigger}
        onUpgradePress={onUpgradePress}
      />
    </View>
  );
}
