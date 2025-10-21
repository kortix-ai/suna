/**
 * Trigger Detail Page Component
 * 
 * Clean, modern detail view for viewing/managing a single trigger
 * Matches the app's design language with consistent spacing and typography
 */

import React, { useState } from 'react';
import { View, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useRouter } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
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
  XCircle
} from 'lucide-react-native';
import { useTrigger, useDeleteTrigger, useToggleTrigger } from '@/lib/triggers';
import { 
  getTriggerIcon, 
  getTriggerCategory, 
  formatCronExpression, 
  formatTriggerDate 
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
  disabled = false
}: { 
  icon: any; 
  label: string; 
  onPress: () => void;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
}) {
  const { colorScheme } = useColorScheme();
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

  const bgColor = variant === 'destructive' 
    ? (colorScheme === 'dark' ? '#DC2626' : '#EF4444')
    : (colorScheme === 'dark' ? '#161618' : '#FFFFFF');
  
  const borderColor = variant === 'destructive'
    ? (colorScheme === 'dark' ? '#DC2626' : '#EF4444')
    : (colorScheme === 'dark' ? '#232324' : '#DCDCDC');
  
  const textColor = variant === 'destructive'
    ? '#FFFFFF'
    : (colorScheme === 'dark' ? '#F8F8F8' : '#000000');
  
  const iconColor = variant === 'destructive'
    ? '#FFFFFF'
    : (colorScheme === 'dark' ? '#F8F8F8' : '#000000');

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      style={[
        animatedStyle,
        {
          backgroundColor: bgColor,
          borderColor: borderColor,
          borderWidth: 1.5,
          borderRadius: 16,
          padding: 16,
          opacity: disabled ? 0.5 : 1,
        }
      ]}
      className="flex-row items-center justify-center gap-2"
    >
      <Icon as={IconComponent} size={20} color={iconColor} />
      <Text style={{ color: textColor, fontSize: 16, fontWeight: '500' }}>
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
  mono = false
}: { 
  icon: any; 
  label: string; 
  value: string;
  mono?: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const iconColor = colorScheme === 'dark' ? '#F8F8F8' : '#000000';
  const labelColor = colorScheme === 'dark' ? '#F8F8F8' : '#000000';
  const valueColor = colorScheme === 'dark' ? '#F8F8F8' : '#000000';

  return (
    <View className="flex-row items-start gap-3 mb-4">
      <View 
        style={{
          backgroundColor: colorScheme === 'dark' ? '#161618' : '#F5F5F5',
          borderRadius: 12,
          width: 40,
          height: 40,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon as={IconComponent} size={20} color={iconColor} />
      </View>
      <View className="flex-1">
        <Text 
          style={{ 
            color: labelColor, 
            fontSize: 14, 
            opacity: 0.6,
            marginBottom: 4
          }}
        >
          {label}
        </Text>
        <Text 
          style={{ 
            color: valueColor, 
            fontSize: 16, 
            fontWeight: '500',
            fontFamily: mono ? 'monospace' : undefined
          }}
          numberOfLines={mono ? undefined : 3}
        >
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
  const { colorScheme } = useColorScheme();
  const textColor = colorScheme === 'dark' ? '#F8F8F8' : '#000000';

  return (
    <View className="mb-6">
      <Text 
        style={{ 
          color: textColor, 
          fontSize: 18, 
          fontWeight: '600',
          marginBottom: 16
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

export function TriggerDetailPage({ triggerId }: TriggerDetailPageProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const backScale = useSharedValue(1);
  
  const { data: trigger, isLoading, error, refetch } = useTrigger(triggerId);
  const deleteTriggerMutation = useDeleteTrigger();
  const toggleTriggerMutation = useToggleTrigger();

  const backAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: backScale.value }],
  }));

  const handleBack = () => {
    backScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
    setTimeout(() => {
      backScale.value = withSpring(1, { damping: 15, stiffness: 400 });
    }, 100);
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
      refetch();
    } catch (error) {
      console.error('Error toggling trigger:', error);
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
              console.error('Error deleting trigger:', error);
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
      <SafeAreaView 
        edges={['top']} 
        style={{ 
          flex: 1, 
          backgroundColor: colorScheme === 'dark' ? '#121215' : '#F8F8F8' 
        }}
      >
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'} />
          <Text 
            style={{ 
              color: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
              fontSize: 14,
              opacity: 0.6,
              marginTop: 16
            }}
          >
            Loading trigger...
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Error State
  if (error || !trigger) {
    return (
      <SafeAreaView 
        edges={['top']} 
        style={{ 
          flex: 1, 
          backgroundColor: colorScheme === 'dark' ? '#121215' : '#F8F8F8' 
        }}
      >
        <View className="flex-1 items-center justify-center p-6">
          <View 
            style={{
              width: 64,
              height: 64,
              backgroundColor: colorScheme === 'dark' ? '#DC2626' : '#FEE2E2',
              borderRadius: 32,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16
            }}
          >
            <Icon as={XCircle} size={32} color={colorScheme === 'dark' ? '#FFFFFF' : '#DC2626'} />
          </View>
          <Text 
            style={{ 
              color: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
              fontSize: 20,
              fontWeight: '600',
              marginBottom: 8
            }}
          >
            Trigger Not Found
          </Text>
          <Text 
            style={{ 
              color: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
              fontSize: 14,
              opacity: 0.6,
              textAlign: 'center',
              marginBottom: 24
            }}
          >
            This trigger may have been deleted or you don't have permission to view it.
          </Text>
          <ActionButton
            icon={ChevronLeft}
            label="Go Back"
            onPress={handleBack}
          />
        </View>
      </SafeAreaView>
    );
  }

  const IconComponent = getTriggerIcon(trigger.trigger_type);
  const category = getTriggerCategory(trigger.trigger_type);
  const formattedDate = formatTriggerDate(trigger.created_at);

  return (
    <SafeAreaView 
      edges={['top']} 
      style={{ 
        flex: 1, 
        backgroundColor: colorScheme === 'dark' ? '#121215' : '#F8F8F8' 
      }}
    >
      {/* Header */}
      <View 
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: 16,
          paddingBottom: 12,
        }}
      >
        <AnimatedPressable
          onPress={handleBack}
          onPressIn={() => { backScale.value = withSpring(0.9); }}
          onPressOut={() => { backScale.value = withSpring(1); }}
          style={[
            backAnimatedStyle,
            {
              width: 40,
              height: 40,
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 8,
            }
          ]}
        >
          <Icon 
            as={ChevronLeft} 
            size={24} 
            color={colorScheme === 'dark' ? '#F8F8F8' : '#000000'} 
          />
        </AnimatedPressable>

        <View className="flex-1">
          <Text 
            style={{ 
              color: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
              fontSize: 20,
              fontWeight: '600'
            }}
            numberOfLines={1}
          >
            Trigger Details
          </Text>
        </View>
      </View>

      {/* Scrollable Content */}
      <ScrollView 
        className="flex-1 px-6"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        {/* Trigger Icon & Name */}
        <View className="items-center mb-6 mt-2">
          <View 
            style={{
              backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
              borderColor: colorScheme === 'dark' ? '#232324' : '#DCDCDC',
              borderWidth: 2,
              borderRadius: 24,
              width: 80,
              height: 80,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            <Icon 
              as={IconComponent} 
              size={36} 
              color={colorScheme === 'dark' ? '#F8F8F8' : '#000000'} 
            />
          </View>
          <Text 
            style={{ 
              color: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
              fontSize: 24,
              fontWeight: '600',
              textAlign: 'center',
              marginBottom: 8
            }}
          >
            {trigger.name}
          </Text>
          {trigger.description && (
            <Text 
              style={{ 
                color: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
                fontSize: 16,
                opacity: 0.6,
                textAlign: 'center'
              }}
            >
              {trigger.description}
            </Text>
          )}
        </View>

        {/* Status Toggle */}
        <View className="mb-6">
          <ActionButton
            icon={trigger.is_active ? CheckCircle2 : XCircle}
            label={trigger.is_active ? 'Active - Tap to Disable' : 'Inactive - Tap to Enable'}
            onPress={handleToggleActive}
            variant={trigger.is_active ? 'default' : 'default'}
            disabled={toggleTriggerMutation.isPending}
          />
        </View>

        {/* Basic Information */}
        <Section title="Information">
          <InfoRow
            icon={Zap}
            label="Type"
            value={category === 'scheduled' ? 'Scheduled Trigger' : 'Event Trigger'}
          />
          <InfoRow
            icon={Calendar}
            label="Created"
            value={formattedDate}
          />
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
              <InfoRow
                icon={Globe}
                label="Timezone"
                value={trigger.config.timezone}
              />
            )}
          </Section>
        )}

        {/* Agent Prompt */}
        {trigger.config?.agent_prompt && (
          <Section title="Agent Prompt">
            <InfoRow
              icon={MessageSquare}
              label="Instruction"
              value={trigger.config.agent_prompt}
            />
          </Section>
        )}

        {/* Webhook URL */}
        {trigger.webhook_url && (
          <Section title="Webhook">
            <View className="mb-4">
              <Pressable
                onPress={handleCopyWebhookUrl}
                style={{
                  backgroundColor: colorScheme === 'dark' ? '#161618' : '#F5F5F5',
                  borderRadius: 12,
                  padding: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <View className="flex-1">
                  <Text 
                    style={{ 
                      color: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
                      fontSize: 12,
                      fontFamily: 'monospace'
                    }}
                    numberOfLines={2}
                  >
                    {trigger.webhook_url}
                  </Text>
                </View>
                <Icon as={Copy} size={20} color={colorScheme === 'dark' ? '#F8F8F8' : '#000000'} />
              </Pressable>
            </View>
          </Section>
        )}

        {/* Actions */}
        <Section title="Actions">
          <View className="gap-3">
            {/* <ActionButton
              icon={Edit}
              label="Edit Trigger"
              onPress={() => {}}
              disabled
            /> */}
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
    </SafeAreaView>
  );
}
