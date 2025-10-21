/**
 * Trigger Detail Page Component
 * 
 * Full-screen page for viewing/editing single trigger
 * Shows trigger info, configuration, and management actions
 */

import React, { useState } from 'react';
import { View, Pressable, ScrollView, Alert, Switch } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { ChevronLeft, Edit, Trash2, Copy, ExternalLink, Clock, Sparkles, Zap } from 'lucide-react-native';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { TriggerCreationDrawer } from '@/components/triggers/TriggerCreationDrawer';
import { useTrigger, useDeleteTrigger, useToggleTrigger } from '@/hooks/api';
import { getTriggerIcon, getTriggerCategory, formatCronExpression, getTriggerStatusText, formatTriggerDate, getWebhookDisplayUrl } from '@/lib/trigger-utils';
import type { TriggerConfiguration } from '@/api/types';

interface TriggerDetailPageProps {
  triggerId: string;
}

export function TriggerDetailPage({
  triggerId,
}: TriggerDetailPageProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const [isEditDrawerVisible, setIsEditDrawerVisible] = useState(false);
  
  const { data: trigger, isLoading, error, refetch } = useTrigger(triggerId);
  const deleteTriggerMutation = useDeleteTrigger();
  const toggleTriggerMutation = useToggleTrigger();

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const handleEdit = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsEditDrawerVisible(true);
  };

  const handleDelete = () => {
    if (!trigger) return;

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
              console.error('Error deleting trigger:', error);
              Alert.alert('Error', 'Failed to delete trigger. Please try again.');
            }
          },
        },
      ]
    );
  };

  const handleToggleActive = async () => {
    if (!trigger) return;

    try {
      await toggleTriggerMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        isActive: !trigger.is_active,
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (error) {
      console.error('Error toggling trigger:', error);
      Alert.alert('Error', 'Failed to update trigger status. Please try again.');
    }
  };

  const handleCopyWebhookUrl = () => {
    if (!trigger?.webhook_url) return;
    
    // TODO: Implement clipboard functionality
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert('Copied', 'Webhook URL copied to clipboard');
  };

  const handleEditDrawerClose = () => {
    setIsEditDrawerVisible(false);
  };

  const handleTriggerUpdated = (updatedTriggerId: string) => {
    console.log('🔧 Trigger updated:', updatedTriggerId);
    setIsEditDrawerVisible(false);
    refetch();
  };

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center">
          <View className="w-8 h-8 bg-muted rounded-full animate-pulse mb-4" />
          <Text className="text-gray-500 text-sm font-roobert">Loading trigger...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error || !trigger) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <View className="w-16 h-16 bg-red-100 rounded-full items-center justify-center mb-4">
            <Icon as={Zap} size={24} color="text-red-600" />
          </View>
          <Text className="text-foreground text-lg font-roobert-semibold mb-2">
            Trigger Not Found
          </Text>
          <Text className="text-gray-500 text-sm font-roobert text-center mb-6">
            This trigger may have been deleted or you don't have permission to view it.
          </Text>
          <Pressable
            onPress={handleBack}
            className="px-6 py-3 bg-primary rounded-xl"
          >
            <Text className="text-primary-foreground text-sm font-roobert-medium">
              Go Back
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const IconComponent = getTriggerIcon(trigger.trigger_type);
  const category = getTriggerCategory(trigger.trigger_type);
  const statusText = getTriggerStatusText(trigger.is_active);
  const formattedDate = formatTriggerDate(trigger.created_at);
  const webhookDisplayUrl = getWebhookDisplayUrl(trigger.webhook_url);

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between p-4 border-b border-border/30">
        <View className="flex-row items-center flex-1">
          <Pressable onPress={handleBack} className="p-2 mr-2">
            <Icon as={ChevronLeft} size={24} color="text-foreground" />
          </Pressable>
          <View className="w-10 h-10 rounded-xl bg-primary/10 items-center justify-center mr-3">
            <Icon as={IconComponent} size={20} color="#3b82f6" />
          </View>
          <View className="flex-1">
            <Text className="text-foreground text-lg font-roobert-semibold" numberOfLines={1}>
              {trigger.name}
            </Text>
            <Text className="text-muted-foreground text-sm font-roobert">
              {category === 'scheduled' ? 'Scheduled Trigger' : 'Event Trigger'}
            </Text>
          </View>
        </View>
        
        <View className="flex-row items-center">
          <Pressable onPress={handleEdit} className="p-2 mr-2">
            <Icon as={Edit} size={20} color="#666" />
          </Pressable>
          <Pressable onPress={handleDelete} className="p-2">
            <Icon as={Trash2} size={20} color="#ef4444" />
          </Pressable>
        </View>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="p-6 space-y-6">
          {/* Status Toggle */}
          <View className="p-4 bg-muted/30 rounded-2xl">
            <View className="flex-row items-center justify-between">
              <View>
                <Text className="text-foreground text-base font-roobert-medium">
                  Status
                </Text>
                <Text className="text-muted-foreground text-sm font-roobert mt-1">
                  {statusText}
                </Text>
              </View>
              <Switch
                value={trigger.is_active}
                onValueChange={handleToggleActive}
                trackColor={{ false: '#767577', true: '#81b0ff' }}
                thumbColor={trigger.is_active ? '#f5dd4b' : '#f4f3f4'}
              />
            </View>
          </View>

          {/* Trigger Info */}
          <View className="space-y-4">
            <Text className="text-foreground text-lg font-roobert-semibold">
              Trigger Information
            </Text>
            
            <View className="p-4 bg-muted/30 rounded-2xl space-y-3">
              <View>
                <Text className="text-muted-foreground text-sm font-roobert-medium">
                  Name
                </Text>
                <Text className="text-foreground text-base font-roobert mt-1">
                  {trigger.name}
                </Text>
              </View>
              
              {trigger.description && (
                <View>
                  <Text className="text-muted-foreground text-sm font-roobert-medium">
                    Description
                  </Text>
                  <Text className="text-foreground text-base font-roobert mt-1">
                    {trigger.description}
                  </Text>
                </View>
              )}
              
              <View>
                <Text className="text-muted-foreground text-sm font-roobert-medium">
                  Type
                </Text>
                <Text className="text-foreground text-base font-roobert mt-1">
                  {trigger.trigger_type}
                </Text>
              </View>
              
              <View>
                <Text className="text-muted-foreground text-sm font-roobert-medium">
                  Created
                </Text>
                <Text className="text-foreground text-base font-roobert mt-1">
                  {formattedDate}
                </Text>
              </View>
            </View>
          </View>

          {/* Schedule Configuration */}
          {category === 'scheduled' && trigger.config?.cron_expression && (
            <View className="space-y-4">
              <Text className="text-foreground text-lg font-roobert-semibold">
                Schedule Configuration
              </Text>
              
              <View className="p-4 bg-muted/30 rounded-2xl space-y-3">
                <View className="flex-row items-center">
                  <Icon as={Clock} size={16} color="#666" />
                  <Text className="text-muted-foreground text-sm font-roobert-medium ml-2">
                    Schedule
                  </Text>
                </View>
                <Text className="text-foreground text-base font-roobert">
                  {formatCronExpression(trigger.config.cron_expression)}
                </Text>
                <Text className="text-muted-foreground text-sm font-mono">
                  {trigger.config.cron_expression}
                </Text>
                
                {trigger.config.timezone && (
                  <View className="mt-2">
                    <Text className="text-muted-foreground text-sm font-roobert-medium">
                      Timezone
                    </Text>
                    <Text className="text-foreground text-base font-roobert mt-1">
                      {trigger.config.timezone}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* Agent Prompt */}
          {trigger.config?.agent_prompt && (
            <View className="space-y-4">
              <Text className="text-foreground text-lg font-roobert-semibold">
                Agent Prompt
              </Text>
              
              <View className="p-4 bg-muted/30 rounded-2xl">
                <Text className="text-foreground text-base font-roobert">
                  {trigger.config.agent_prompt}
                </Text>
              </View>
            </View>
          )}

          {/* Webhook URL */}
          {trigger.webhook_url && (
            <View className="space-y-4">
              <Text className="text-foreground text-lg font-roobert-semibold">
                Webhook URL
              </Text>
              
              <View className="p-4 bg-muted/30 rounded-2xl">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 mr-3">
                    <Text className="text-foreground text-sm font-mono" numberOfLines={2}>
                      {webhookDisplayUrl}
                    </Text>
                  </View>
                  <Pressable
                    onPress={handleCopyWebhookUrl}
                    className="p-2 bg-primary rounded-lg"
                  >
                    <Icon as={Copy} size={16} color="text-primary-foreground" />
                  </Pressable>
                </View>
              </View>
            </View>
          )}

          {/* Configuration Details */}
          {Object.keys(trigger.config || {}).length > 0 && (
            <View className="space-y-4">
              <Text className="text-foreground text-lg font-roobert-semibold">
                Configuration Details
              </Text>
              
              <View className="p-4 bg-muted/30 rounded-2xl">
                <Text className="text-foreground text-sm font-mono">
                  {JSON.stringify(trigger.config, null, 2)}
                </Text>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
