/**
 * Trigger Config Step Component
 *
 * Configuration form for event triggers
 * Matches frontend design adapted for mobile
 * Returns content only - no ScrollView (parent handles scrolling)
 */

import React from 'react';
import { View, TextInput, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Info, Plus, Check, CheckCircle2 } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { DynamicConfigForm } from './DynamicConfigForm';
import { ModelToggle } from '../models/ModelToggle';
import { useAvailableModels } from '@/lib/models/hooks';
import { useAccountState } from '@/lib/billing/hooks';
import { Loading } from '../loading/loading';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { ComposioTriggerType, TriggerApp, Model } from '@/api/types';
import type { ComposioProfile } from '@/hooks/useComposio';
import { useLanguage } from '@/contexts/LanguageContext';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Normalizes instructions text to proper markdown format
 * Converts plain text bullet points to markdown lists
 * Preserves existing markdown formatting (bold, italic, etc.)
 */
function normalizeInstructions(instructions: string): string {
  if (!instructions) return instructions;

  // Split into lines while preserving original structure
  const lines = instructions.split('\n');
  const normalized: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    const trimmed = originalLine.trim();

    // Skip empty lines but preserve them
    if (trimmed.length === 0) {
      normalized.push('');
      continue;
    }

    // Check if line already starts with markdown list syntax
    const isMarkdownList = /^[\s]*[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed);

    if (isMarkdownList) {
      // Already in markdown format, preserve as-is
      normalized.push(trimmed);
    } else if (trimmed.startsWith('-')) {
      // Plain text dash - convert to markdown list item
      // Remove leading dash and any extra spaces, then add proper markdown format
      const content = trimmed.replace(/^-\s*/, '').trim();
      normalized.push(`- ${content}`);
    } else {
      // Regular text line - preserve as-is (may contain markdown like **bold**)
      normalized.push(trimmed);
    }
  }

  return normalized.join('\n');
}

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
  const { t } = useLanguage();
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
      className={`mb-3 flex-row items-center rounded-2xl border p-4 ${
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
        <Text className="font-roobert-medium text-base text-foreground">
          {profile.profile_name}
        </Text>
        {profile.is_connected && (
          <View className="mt-1 flex-row items-center gap-2">
            <View className="h-1.5 w-1.5 rounded-full bg-green-500" />
            <Text className="font-roobert-medium text-xs text-green-600 dark:text-green-400">
              {t('triggers.connected')}
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
  const isDark = colorScheme === 'dark';
  const { t } = useLanguage();

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
    <View className="space-y-1">
      {/* Instructions */}
      {trigger.instructions && (
        <View
          className="rounded-xl bg-muted p-4"
          style={{
            backgroundColor: isDark ? '#27272A' : '#F4F4F5',
            borderWidth: 0,
          }}>
          <SelectableMarkdownText
            isDark={isDark}
            style={{
              fontSize: 14,
              lineHeight: 20,
              color: isDark ? '#A1A1AA' : '#71717A',
            }}>
            {normalizeInstructions(trigger.instructions)}
          </SelectableMarkdownText>
        </View>
      )}

      {/* Loading Profiles */}
      {isLoadingProfiles && (
        <View className="items-center justify-center py-12">
          <ActivityIndicator size="small" color={isDark ? '#FFFFFF' : '#121215'} />
          <Text className="mt-4 font-roobert text-sm text-muted-foreground">
            {t('triggers.loadingProfiles')}
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
            {t('triggers.noConnectedProfile')}
          </Text>
          <Text className="mb-4 text-center text-sm text-muted-foreground">
            {t('triggers.connectAppFirst', { app: app.name })}
          </Text>
        </View>
      )}

      {/* Configuration Form */}
      {connectedProfiles.length > 0 && (
        <>
          {/* Trigger Config */}
          <View className="mt-4 rounded-2xl border border-border bg-card p-4">
            <View className="mb-4">
              <Text className="mb-1 font-roobert-semibold text-base text-foreground">
                {trigger.name}
              </Text>
              <Text className="font-roobert text-sm text-muted-foreground">
                {t('triggers.configureThisTrigger')}
              </Text>
            </View>
            <DynamicConfigForm
              schema={trigger.config as any}
              value={config}
              onChange={onConfigChange}
            />
          </View>

          {/* Execution Settings */}
          <View className="mt-4 rounded-2xl border border-border bg-card p-4">
            <View className="mb-4">
              <Text className="mb-1 font-roobert-semibold text-base text-foreground">
                {t('triggers.executionSettings')}
              </Text>
              <Text className="font-roobert text-sm text-muted-foreground">
                {t('triggers.chooseHowToHandle')}
              </Text>
            </View>

            <View className="space-y-6">
              {/* Profile Selector */}
              <View className="space-y-3">
                <Text className="font-roobert-semibold text-sm text-foreground">
                  {t('triggers.connectionProfile')} *
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
                        <Icon
                          as={Plus}
                          size={20}
                          className="text-primary-foreground"
                          strokeWidth={2.5}
                        />
                      </View>
                      <View className="ml-3 flex-1">
                        <Text className="font-roobert-semibold text-base text-primary">
                          {t('triggers.createNewConnection')}
                        </Text>
                      </View>
                    </Pressable>
                  </>
                )}
              </View>

              {/* Trigger Name */}
              <View style={{ marginBottom: 16 }}>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                    marginBottom: 8,
                    marginTop: 16,
                  }}>
                  {t('triggers.triggerName')} *
                </Text>
                <TextInput
                  value={triggerName}
                  onChangeText={onTriggerNameChange}
                  placeholder={`${app.name} → Worker`}
                  placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    borderWidth: 1.5,
                    borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
                    backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
                    fontSize: 16,
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                  }}
                />
              </View>

              {/* Agent Instructions */}
              <View style={{ marginBottom: 16 }}>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                    marginBottom: 8,
                  }}>
                  {t('triggers.agentInstructions')} *
                </Text>
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="on-drag"
                  showsVerticalScrollIndicator={true}
                  style={{
                    borderRadius: 12,
                    borderWidth: 1.5,
                    borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
                    backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
                    maxHeight: 200,
                  }}
                  contentContainerStyle={{
                    padding: 12,
                  }}>
                  <TextInput
                    value={agentPrompt}
                    onChangeText={onAgentPromptChange}
                    placeholder={t('triggers.instructionsPlaceholder')}
                    placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                    multiline
                    scrollEnabled={false}
                    style={{
                      minHeight: 120,
                      fontSize: 16,
                      color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                      textAlignVertical: 'top',
                    }}
                  />
                </ScrollView>
                <Text
                  className="font-roobert text-xs text-muted-foreground"
                  style={{ marginTop: 8 }}>
                  {t('triggers.variableHint')}
                </Text>
              </View>

              {/* Model Selector */}
              {modelsData && (
                <View className="space-y-3">
                  <Text className="font-roobert-semibold text-sm text-foreground">
                    {t('triggers.modelSelector')}
                  </Text>
                  <ModelToggle
                    models={modelsData.models}
                    selectedModelId={model}
                    onModelChange={onModelChange}
                    canAccessModel={canAccessModel}
                  />
                  <Text className="font-roobert text-xs text-muted-foreground">
                    {t('triggers.modelHint')}
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
