/**
 * Instructions Screen Component
 *
 * Allows editing the system prompt/instructions for a worker
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, TextInput, ScrollView, Keyboard } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { useAgent, useUpdateAgent } from '@/lib/agents/hooks';
import { Save, AlertCircle } from 'lucide-react-native';
import { Pressable, ActivityIndicator, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useLanguage } from '@/contexts/LanguageContext';
import { log } from '@/lib/logger';
import { THEME } from '@/lib/utils/theme';

interface InstructionsScreenProps {
  agentId: string;
  onUpdate?: () => void;
}

export function InstructionsScreen({ agentId, onUpdate }: InstructionsScreenProps) {
  const { colorScheme } = useColorScheme();
  const { data: agent, isLoading } = useAgent(agentId);
  const updateAgentMutation = useUpdateAgent();
  const [systemPrompt, setSystemPrompt] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const { t } = useLanguage();

  // TextInput ref to control focus manually
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (agent?.system_prompt !== undefined) {
      setSystemPrompt(agent.system_prompt || '');
      setHasChanges(false);
    }
  }, [agent?.system_prompt]);

  const handleTextChange = (text: string) => {
    setSystemPrompt(text);
    setHasChanges(text !== (agent?.system_prompt || ''));
  };

  const handleSave = async () => {
    if (!hasChanges) return;

    const isSunaAgent = agent?.metadata?.is_suna_default || false;
    const restrictions = agent?.metadata?.restrictions || {};
    const isEditable = restrictions.system_prompt_editable !== false && !isSunaAgent;

    if (!isEditable) {
      if (isSunaAgent) {
        Alert.alert(
          t('workers.instructions.cannotEditAlert'),
          t('workers.instructions.sunaManaged')
        );
      }
      return;
    }

    try {
      await updateAgentMutation.mutateAsync({
        agentId,
        data: { system_prompt: systemPrompt },
      });

      setHasChanges(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onUpdate?.();
    } catch (error: any) {
      log.error('Failed to update system prompt:', error);
      Alert.alert(t('common.error'), error?.message || t('workers.instructions.errorUpdatePrompt'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (isLoading) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator size="small" color={colorScheme === 'dark' ? THEME.dark.foreground : THEME.light.foreground} />
        <Text className="mt-4 font-roobert text-sm text-muted-foreground">
          {t('workers.instructions.loading')}
        </Text>
      </View>
    );
  }

  const isSunaAgent = agent?.metadata?.is_suna_default || false;
  const restrictions = agent?.metadata?.restrictions || {};
  const isEditable = restrictions.system_prompt_editable !== false && !isSunaAgent;

  return (
    <View className="flex-1" style={{ flex: 1, position: 'relative' }}>
      {/* Header */}
      <View className="mb-4 flex flex-col">
        <Text className="mb-2 font-roobert-semibold text-base text-foreground">
          {t('workers.instructions.title')}
        </Text>
        <Text className="mb-1 font-roobert text-sm text-muted-foreground">
          {t('workers.instructions.description')}
        </Text>

        {!isEditable && (
          <View className="flex-row items-start gap-2 rounded-xl border border-kortix-orange/20 bg-kortix-orange/10 p-3">
            <Icon
              as={AlertCircle}
              size={16}
              className="mt-0.5 text-kortix-orange"
            />
            <Text className="flex-1 font-roobert text-sm text-kortix-orange">
              {isSunaAgent
                ? t('workers.instructions.cannotEditSuna')
                : t('workers.instructions.cannotEdit')}
            </Text>
          </View>
        )}
      </View>

      {/* Scrollable text input */}
      <View style={{ flex: 1, marginBottom: isEditable ? 84 : 0 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={true}
          style={{
            flex: 1,
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: colorScheme === 'dark' ? THEME.dark.border : THEME.light.border,
            backgroundColor: colorScheme === 'dark' ? THEME.dark.card : THEME.light.card,
            opacity: isEditable ? 1 : 0.6,
          }}
          contentContainerStyle={{
            padding: 16,
          }}>
          <TextInput
            ref={inputRef}
            value={systemPrompt}
            onChangeText={handleTextChange}
            placeholder={t('workers.instructions.placeholder')}
            placeholderTextColor={colorScheme === 'dark' ? THEME.dark.mutedForeground : THEME.light.mutedForeground}
            multiline
            scrollEnabled={false}
            editable={isEditable}
            style={{
              fontSize: 16,
              color: colorScheme === 'dark' ? THEME.dark.foreground : THEME.light.foreground,
              textAlignVertical: 'top',
              minHeight: 300,
            }}
          />
        </ScrollView>
      </View>

      {/* Sticky Save Button */}
      {isEditable && (
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            paddingBottom: 16,
          }}>
          <Pressable
            onPress={handleSave}
            disabled={!hasChanges || updateAgentMutation.isPending}
            className={`flex-row items-center justify-center gap-2 rounded-xl p-4 ${
              !hasChanges || updateAgentMutation.isPending
                ? 'bg-primary/50 opacity-50'
                : 'bg-primary active:opacity-80'
            }`}>
            {updateAgentMutation.isPending ? (
              <ActivityIndicator
                size="small"
                color={colorScheme === 'dark' ? THEME.dark.primaryForeground : THEME.light.primaryForeground}
              />
            ) : (
              <Icon as={Save} size={18} className="text-primary-foreground" />
            )}

            <Text className="font-roobert-semibold text-base text-primary-foreground">
              {updateAgentMutation.isPending
                ? t('workers.instructions.saving')
                : t('workers.instructions.saveChanges')}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
