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
    const isEditable = restrictions.system_prompt_editable !== false && !isSunaAgent;

    if (!isEditable) {
      if (isSunaAgent) {
        Alert.alert('Cannot Edit', "Suna's system prompt is managed centrally.");
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
  const isEditable = restrictions.system_prompt_editable !== false && !isSunaAgent;

  return (
    <View className="flex-1" style={{ flex: 1, position: 'relative' }}>
      {/* Header content */}
      <View className="mb-4 flex flex-col">
        <Text className="mb-2 font-roobert-semibold text-base text-foreground">System Prompt</Text>
        <Text className="mb-1 font-roobert text-sm text-muted-foreground">
          Define how your worker should behave and what it should do
        </Text>

        {!isEditable && (
          <View className="flex-row items-start gap-2 rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-3">
            <Icon
              as={AlertCircle}
              size={16}
              className="mt-0.5 text-yellow-600 dark:text-yellow-400"
            />
            <Text className="flex-1 font-roobert text-sm text-yellow-600 dark:text-yellow-400">
              {isSunaAgent
                ? "Suna's system prompt is managed centrally and cannot be edited."
                : 'This system prompt cannot be edited.'}
            </Text>
          </View>
        )}
      </View>

      {/* TextInput with fixed height based on available space */}
      <View style={{ flex: 1, marginBottom: isEditable ? 84 : 0 }}>
        <TextInput
          value={systemPrompt}
          onChangeText={handleTextChange}
          placeholder="Define how your agent should behave..."
          placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
          multiline
          scrollEnabled
          editable={isEditable}
          style={{
            flex: 1,
            padding: 16,
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
            backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
            fontSize: 16,
            color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            textAlignVertical: 'top',
            opacity: isEditable ? 1 : 0.6,
          }}
        />
      </View>

      {/* Sticky button at bottom */}
      {isEditable && (
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            paddingBottom: 16,
            zIndex: 10,
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
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Icon as={Save} size={18} className="text-primary-foreground" />
            )}
            <Text className="font-roobert-semibold text-base text-primary-foreground">
              {updateAgentMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
