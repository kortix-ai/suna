/**
 * Triggers Screen Component
 *
 * Displays and manages triggers for a specific worker
 */

import React, { useState, useMemo } from 'react';
import { View, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import {
  Zap,
  Plus,
  Play,
  Pause,
  Settings,
  Trash2,
  Clock,
  Link2,
} from 'lucide-react-native';
import {
  useAgentTriggers,
  useDeleteTrigger,
  useToggleTrigger,
} from '@/lib/triggers';
import { TriggerCreationDrawer } from '@/components/triggers/TriggerCreationDrawer';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import type { TriggerConfiguration } from '@/api/types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TriggersScreenProps {
  agentId: string;
  onUpdate?: () => void;
}

interface TriggerCardProps {
  trigger: TriggerConfiguration;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function TriggerCard({ trigger, onToggle, onEdit, onDelete }: TriggerCardProps) {
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

  return (
    <AnimatedPressable
      style={animatedStyle}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      className="mb-3 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-3 flex-1">
          <View className="h-12 w-12 items-center justify-center rounded-xl bg-card border border-border/50">
            <Icon
              as={isSchedule ? Clock : Link2}
              size={20}
              className="text-foreground"
            />
          </View>
          <View className="flex-1 min-w-0">
            <Text className="mb-1 font-roobert-medium text-base text-foreground" numberOfLines={1}>
              {trigger.name}
            </Text>
            <Text className="text-sm text-muted-foreground" numberOfLines={1}>
              {trigger.description || 'No description'}
            </Text>
          </View>
        </View>

        <View className="flex-row items-center gap-2 ml-4">
          <Pressable
            onPress={onToggle}
            className="h-10 w-10 items-center justify-center rounded-xl bg-primary active:opacity-80">
            <Icon
              as={trigger.is_active ? Pause : Play}
              size={18}
              className="text-primary-foreground"
            />
          </Pressable>

          <Pressable
            onPress={onEdit}
            className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-card active:opacity-80">
            <Icon as={Settings} size={18} className="text-foreground" />
          </Pressable>

          <Pressable
            onPress={onDelete}
            className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-card active:opacity-80">
            <Icon as={Trash2} size={18} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>
    </AnimatedPressable>
  );
}

export function TriggersScreen({ agentId, onUpdate }: TriggersScreenProps) {
  const { colorScheme } = useColorScheme();
  const { data: triggers = [], isLoading, refetch } = useAgentTriggers(agentId);
  const deleteTriggerMutation = useDeleteTrigger();
  const toggleTriggerMutation = useToggleTrigger();

  const [isCreateDrawerVisible, setIsCreateDrawerVisible] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<TriggerConfiguration | null>(null);
  const [deleteDialogTrigger, setDeleteDialogTrigger] = useState<TriggerConfiguration | null>(null);

  const runningTriggers = useMemo(
    () => triggers.filter((trigger) => trigger.is_active),
    [triggers]
  );

  const pausedTriggers = useMemo(
    () => triggers.filter((trigger) => !trigger.is_active),
    [triggers]
  );

  const handleToggleTrigger = async (trigger: TriggerConfiguration) => {
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
        <Text className="mt-4 font-roobert text-sm text-muted-foreground">
          Loading triggers...
        </Text>
      </View>
    );
  }

  return (
    <View className="space-y-4">
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="mb-2 font-roobert-semibold text-base text-foreground">
            Triggers
          </Text>
          <Text className="font-roobert text-sm text-muted-foreground">
            Automate your worker with scheduled or event-based triggers
          </Text>
        </View>
        <Pressable
          onPress={() => {
            setEditingTrigger(null);
            setIsCreateDrawerVisible(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }}
          className="h-10 w-10 items-center justify-center rounded-xl bg-primary active:opacity-80">
          <Icon as={Plus} size={20} className="text-primary-foreground" />
        </Pressable>
      </View>

      {runningTriggers.length === 0 && pausedTriggers.length === 0 ? (
        <View className="items-center justify-center rounded-2xl border border-border bg-card p-8">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
            <Icon as={Zap} size={24} className="text-muted-foreground" />
          </View>
          <Text className="mb-1 font-roobert-semibold text-base text-foreground">
            No triggers configured
          </Text>
          <Text className="mb-4 text-center text-sm text-muted-foreground">
            Set up triggers to automate this worker
          </Text>
          <Pressable
            onPress={() => {
              setEditingTrigger(null);
              setIsCreateDrawerVisible(true);
            }}
            className="rounded-xl bg-primary px-4 py-2 active:opacity-80">
            <Text className="font-roobert-semibold text-sm text-primary-foreground">
              Create Trigger
            </Text>
          </Pressable>
        </View>
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
      />
    </View>
  );
}

