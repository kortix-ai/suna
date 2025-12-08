/**
 * Tools Screen Component
 *
 * Allows configuring agentpress tools for a worker
 * Simplified version - full granular tool configuration can be added later
 */

import React, { useState, useEffect } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { useAgent, useUpdateAgent } from '@/lib/agents/hooks';
import { Wrench, Save, AlertCircle, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface ToolsScreenProps {
  agentId: string;
  onUpdate?: () => void;
}

export function ToolsScreen({ agentId, onUpdate }: ToolsScreenProps) {
  const { colorScheme } = useColorScheme();
  const { data: agent, isLoading } = useAgent(agentId);
  const updateAgentMutation = useUpdateAgent();
  const [tools, setTools] = useState<Record<string, any>>({});
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (agent?.agentpress_tools) {
      setTools(agent.agentpress_tools);
      setHasChanges(false);
    }
  }, [agent?.agentpress_tools]);

  const handleSave = async () => {
    if (!hasChanges) return;

    const isSunaAgent = agent?.metadata?.is_suna_default || false;
    const restrictions = agent?.metadata?.restrictions || {};
    const areToolsEditable = (restrictions.tools_editable !== false) && !isSunaAgent;

    if (!areToolsEditable) {
      if (isSunaAgent) {
        Alert.alert('Cannot Edit', "Suna's tools are managed centrally.");
      }
      return;
    }

    try {
      await updateAgentMutation.mutateAsync({
        agentId,
        data: {
          agentpress_tools: tools,
        },
      });
      setHasChanges(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onUpdate?.();
    } catch (error: any) {
      console.error('Failed to update tools:', error);
      Alert.alert('Error', error?.message || 'Failed to update tools');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (isLoading) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
        <Text className="mt-4 font-roobert text-sm text-muted-foreground">
          Loading tools...
        </Text>
      </View>
    );
  }

  const isSunaAgent = agent?.metadata?.is_suna_default || false;
  const restrictions = agent?.metadata?.restrictions || {};
  const areToolsEditable = (restrictions.tools_editable !== false) && !isSunaAgent;

  const toolEntries = Object.entries(tools || {});

  return (
    <View className="space-y-4">
      <View>
        <Text className="mb-2 font-roobert-semibold text-base text-foreground">
          Agentpress Tools
        </Text>
        <Text className="mb-4 font-roobert text-sm text-muted-foreground">
          Configure which tools your worker can use
        </Text>
      </View>

      {!areToolsEditable && (
        <View className="mb-4 flex-row items-start gap-2 rounded-xl bg-yellow-500/10 border border-yellow-500/20 p-3">
          <Icon as={AlertCircle} size={16} className="mt-0.5 text-yellow-600 dark:text-yellow-400" />
          <Text className="flex-1 font-roobert text-sm text-yellow-600 dark:text-yellow-400">
            {isSunaAgent
              ? "Suna's tools are managed centrally and cannot be edited."
              : 'These tools cannot be edited.'}
          </Text>
        </View>
      )}

      {toolEntries.length === 0 ? (
        <View className="items-center justify-center rounded-2xl border border-border bg-card p-8">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
            <Icon as={Wrench} size={24} className="text-muted-foreground" />
          </View>
          <Text className="mb-1 font-roobert-semibold text-base text-foreground">
            No tools configured
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            Tools will appear here once you add integrations
          </Text>
        </View>
      ) : (
        <View className="space-y-2">
          {toolEntries.map(([toolName, toolConfig]) => {
            const isEnabled =
              typeof toolConfig === 'boolean' ? toolConfig : toolConfig?.enabled !== false;

            return (
              <View
                key={toolName}
                className="flex-row items-center justify-between rounded-2xl border border-border bg-card p-4">
                <View className="flex-1">
                  <Text className="font-roobert-medium text-base text-foreground">
                    {toolName}
                  </Text>
                  {typeof toolConfig === 'object' && toolConfig.description && (
                    <Text className="mt-1 font-roobert text-sm text-muted-foreground">
                      {toolConfig.description}
                    </Text>
                  )}
                </View>
                <View
                  className={`h-6 w-6 items-center justify-center rounded-full ${
                    isEnabled ? 'bg-green-500' : 'bg-muted'
                  }`}>
                  {isEnabled && <Icon as={Check} size={14} className="text-white" />}
                </View>
              </View>
            );
          })}
        </View>
      )}

      {areToolsEditable && hasChanges && (
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

