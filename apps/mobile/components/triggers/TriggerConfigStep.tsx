/**
 * Trigger Config Step Component
 *
 * Configuration form for event triggers
 * Matches frontend design adapted for mobile
 * Returns content only - no ScrollView (parent handles scrolling)
 */

import React from 'react';
import { View, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Info, Plus, Check, CheckCircle2 } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { DynamicConfigForm } from './DynamicConfigForm';
import { ModelToggle } from '../models/ModelToggle';
import { useAvailableModels } from '@/lib/models/hooks';
import { useAccountState } from '@/lib/billing/hooks';
import { Loading } from '../loading/loading';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { ComposioTriggerType, TriggerApp, Model } from '@/api/types';
import type { ComposioProfile } from '@/hooks/useComposio';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TriggerConfigStepProps {
  trigger: ComposioTriggerType | null;
  app: TriggerApp | null;
  config: Record<string, any>;
  onConfigChange: (config: Record<string, any>) => void;
  profileId: string;
  onProfileChange: (profileId: string) => void;
  profiles: ComposioProfile[];
  isLoadingProfiles: boolean;
  onCreateProfile: () => void;
  triggerName: string;
  onTriggerNameChange: (name: string) => void;
  agentPrompt: string;
  onAgentPromptChange: (prompt: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  isConfigValid: boolean;
}

interface ProfileListItemProps {
  profile: ComposioProfile;
  isSelected: boolean;
  onPress: () => void;
}

function ProfileListItem({ profile, isSelected, onPress }: ProfileListItemProps) {
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

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className={`flex-row items-center rounded-2xl border p-4 mb-3 ${
        isSelected ? 'border-primary bg-primary/10' : 'border-border bg-card active:opacity-80'
      }`}>
      <View
        className={`h-10 w-10 items-center justify-center rounded-xl ${
          isSelected ? 'bg-primary' : 'bg-muted'
        }`}>
        <Icon
          as={CheckCircle2}
          size={20}
          className={isSelected ? 'text-primary-foreground' : 'text-muted-foreground'}
          strokeWidth={2.5}
        />
      </View>
      <View className="ml-3 flex-1">
        <Text className="font-roobert-medium text-base text-foreground">{profile.profile_name}</Text>
        {profile.is_connected && (
          <View className="mt-1 flex-row items-center gap-2">
            <View className="h-1.5 w-1.5 rounded-full bg-green-500" />
            <Text className="font-roobert-medium text-xs text-green-600 dark:text-green-400">
              Connected
            </Text>
          </View>
        )}
      </View>
      {isSelected && (
        <View className="h-5 w-5 items-center justify-center rounded-full bg-primary">
          <Icon as={Check} size={14} className="text-primary-foreground" strokeWidth={3} />
        </View>
      )}
    </AnimatedPressable>
  );
}

export function TriggerConfigStep({
  trigger,
  app,
  config,
  onConfigChange,
  profileId,
  onProfileChange,
  profiles,
  isLoadingProfiles,
  onCreateProfile,
  triggerName,
  onTriggerNameChange,
  agentPrompt,
  onAgentPromptChange,
  model,
  onModelChange,
  isConfigValid,
}: TriggerConfigStepProps) {
  const { colorScheme } = useColorScheme();
  const { data: modelsData } = useAvailableModels();
  const { data: accountState } = useAccountState();

  if (!trigger || !app) {
    return null;
  }

  const connectedProfiles = profiles.filter((p) => p.is_connected && p.toolkit_slug === app.slug);

  // Helper to check if user can access a model
  const canAccessModel = (modelItem: Model): boolean => {
    if (!accountState) return false;
    const modelState = accountState.models?.find((m) => m.id === modelItem.id);
    return modelState?.allowed || false;
  };

  return (
    <View className="space-y-6">
      {/* Instructions */}
      {trigger.instructions && (
        <View className="rounded-xl bg-muted p-4">
          <Text className="font-roobert text-sm leading-5 text-muted-foreground">
            {trigger.instructions}
          </Text>
        </View>
      )}

      {/* No Connected Profiles */}
      {!isLoadingProfiles && connectedProfiles.length === 0 && (
        <View className="items-center py-12">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
            <Icon as={Info} size={24} className="text-muted-foreground" />
          </View>
          <Text className="mb-2 font-roobert-semibold text-base text-foreground">
            No Connected Profile
          </Text>
          <Text className="mb-4 text-center text-sm text-muted-foreground">
            Connect {app.name} first to create triggers.
          </Text>
        </View>
      )}

      {/* Configuration Form */}
      {connectedProfiles.length > 0 && (
        <>
          {/* Trigger Config */}
          <View className="rounded-2xl border border-border bg-card p-4">
            <View className="mb-4">
              <Text className="mb-1 font-roobert-semibold text-base text-foreground">
                {trigger.name}
              </Text>
              <Text className="font-roobert text-sm text-muted-foreground">
                Configure this trigger
              </Text>
            </View>
            <DynamicConfigForm schema={trigger.config as any} value={config} onChange={onConfigChange} />
          </View>

          {/* Execution Settings */}
          <View className="rounded-2xl border border-border bg-card p-4">
            <View className="mb-4">
              <Text className="mb-1 font-roobert-semibold text-base text-foreground">
                Execution Settings
              </Text>
              <Text className="font-roobert text-sm text-muted-foreground">
                Choose how to handle this event
              </Text>
            </View>

            <View className="space-y-6">
              {/* Profile Selector */}
              <View className="space-y-3">
                <Text className="font-roobert-semibold text-sm text-foreground">
                  Connection Profile *
                </Text>
                {isLoadingProfiles ? (
                  <View className="items-center py-4">
                    <ActivityIndicator size="small" className="text-muted-foreground" />
                  </View>
                ) : (
                  <>
                    {connectedProfiles.map((profile) => (
                      <ProfileListItem
                        key={profile.profile_id}
                        profile={profile}
                        isSelected={profileId === profile.profile_id}
                        onPress={() => onProfileChange(profile.profile_id)}
                      />
                    ))}
                    <Pressable
                      onPress={onCreateProfile}
                      className="flex-row items-center rounded-2xl border border-dashed border-primary bg-primary/5 p-4 active:opacity-80">
                      <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary">
                        <Icon as={Plus} size={20} className="text-primary-foreground" strokeWidth={2.5} />
                      </View>
                      <View className="ml-3 flex-1">
                        <Text className="font-roobert-semibold text-base text-primary">
                          Create New Connection
                        </Text>
                      </View>
                    </Pressable>
                  </>
                )}
              </View>

              {/* Trigger Name */}
              <View className="space-y-3">
                <Text className="font-roobert-semibold text-sm text-foreground">Trigger Name *</Text>
                <TextInput
                  value={triggerName}
                  onChangeText={onTriggerNameChange}
                  placeholder={`${app.name} → Agent`}
                  placeholderTextColor="hsl(var(--muted-foreground))"
                  className="rounded-xl border border-border bg-card px-4 py-4 font-roobert text-base text-foreground"
                />
              </View>

              {/* Agent Instructions */}
              <View className="space-y-3">
                <Text className="font-roobert-semibold text-sm text-foreground">
                  Agent Instructions *
                </Text>
                <TextInput
                  value={agentPrompt}
                  onChangeText={onAgentPromptChange}
                  placeholder="What should the agent do when this event occurs?"
                  placeholderTextColor="hsl(var(--muted-foreground))"
                  multiline
                  numberOfLines={4}
                  className="rounded-xl border border-border bg-card px-4 py-4 font-roobert text-base text-foreground"
                  style={{ textAlignVertical: 'top', minHeight: 120 }}
                />
                <Text className="font-roobert text-xs text-muted-foreground">
                  Use {'{{variable_name}}'} to add variables to the prompt
                </Text>
              </View>

              {/* Model Selector */}
              {modelsData && (
                <View className="space-y-3">
                  <Text className="font-roobert-semibold text-sm text-foreground">Model</Text>
                  <ModelToggle
                    models={modelsData.models}
                    selectedModelId={model}
                    onModelChange={onModelChange}
                    canAccessModel={canAccessModel}
                  />
                  <Text className="font-roobert text-xs text-muted-foreground">
                    Choose which model to use when this event triggers
                  </Text>
                </View>
              )}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

