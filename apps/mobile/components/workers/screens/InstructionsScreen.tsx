/**
 * Instructions Screen Component
 *
 * Allows editing the system prompt/instructions for a worker
 */

import React, { useState, useEffect } from 'react';
import { View, TextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { useAgent, useUpdateAgent } from '@/lib/agents/hooks';
import { Save, AlertCircle } from 'lucide-react-native';
import { Pressable, ActivityIndicator, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';

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
    const isEditable = (restrictions.system_prompt_editable !== false) && !isSunaAgent;

    if (!isEditable) {
      if (isSunaAgent) {
        Alert.alert(
          'Cannot Edit',
          "Suna's system prompt is managed centrally."
        );
      }
      return;
    }

    try {
      await updateAgentMutation.mutateAsync({
        agentId,
        data: {
          system_prompt: systemPrompt,
        },
      });
      setHasChanges(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onUpdate?.();
    } catch (error: any) {
      console.error('Failed to update system prompt:', error);
      Alert.alert('Error', error?.message || 'Failed to update system prompt');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (isLoading) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
        <Text className="mt-4 font-roobert text-sm text-muted-foreground">
          Loading instructions...
        </Text>
      </View>
    );
  }

  const isSunaAgent = agent?.metadata?.is_suna_default || false;
  const restrictions = agent?.metadata?.restrictions || {};
  const isEditable = (restrictions.system_prompt_editable !== false) && !isSunaAgent;

  return (
    <View className="space-y-4">
      <View>
        <Text className="mb-2 font-roobert-semibold text-base text-foreground">
          System Prompt
        </Text>
        <Text className="mb-4 font-roobert text-sm text-muted-foreground">
          Define how your worker should behave and what it should do
        </Text>
      </View>

      {!isEditable && (
        <View className="mb-4 flex-row items-start gap-2 rounded-xl bg-yellow-500/10 border border-yellow-500/20 p-3">
          <Icon as={AlertCircle} size={16} className="mt-0.5 text-yellow-600 dark:text-yellow-400" />
          <Text className="flex-1 font-roobert text-sm text-yellow-600 dark:text-yellow-400">
            {isSunaAgent
              ? "Suna's system prompt is managed centrally and cannot be edited."
              : 'This system prompt cannot be edited.'}
          </Text>
        </View>
      )}

      <View>
        <TextInput
          value={systemPrompt}
          onChangeText={handleTextChange}
          placeholder="Define how your agent should behave..."
          placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
          multiline
          numberOfLines={12}
          editable={isEditable}
          style={{
            padding: 16,
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
            backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
            fontSize: 16,
            color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            textAlignVertical: 'top',
            minHeight: 200,
            opacity: isEditable ? 1 : 0.6,
          }}
        />
      </View>

      {isEditable && hasChanges && (
        <Pressable
          onPress={handleSave}
          disabled={updateAgentMutation.isPending}
          className={`flex-row items-center justify-center gap-2 rounded-xl p-4 ${
            updateAgentMutation.isPending
              ? 'bg-muted opacity-50'
              : 'bg-primary active:opacity-80'
          }`}>
          {updateAgentMutation.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Icon as={Save} size={18} className="text-primary-foreground" />
          )}
          <Text className="font-roobert-semibold text-base text-primary-foreground">
            {updateAgentMutation.isPending ? 'Saving...' : 'Save Changes'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

