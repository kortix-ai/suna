/**
 * Worker Configuration Page
 *
 * Full page view for configuring workers
 * Supports: Instructions, Tools, Integrations, Triggers
 */

import React, { useState, useEffect } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Brain, Wrench, Server, Zap, ChevronLeft } from 'lucide-react-native';
import { useAgent, useUpdateAgent } from '@/lib/agents/hooks';
import { Loading } from '../loading/loading';
import { InstructionsScreen } from '../workers/screens/InstructionsScreen';
import { ToolsScreen } from '../workers/screens/ToolsScreen';
import { IntegrationsScreen } from '../workers/screens/IntegrationsScreen';
import { TriggersScreen } from '../workers/screens/TriggersScreen';

interface WorkerConfigPageProps {
  workerId: string;
  initialView?: 'instructions' | 'tools' | 'integrations' | 'triggers';
}

type ConfigView = 'instructions' | 'tools' | 'integrations' | 'triggers';

const menuItems = [
  { id: 'instructions' as const, label: 'Instructions', icon: Brain },
  { id: 'tools' as const, label: 'Tools', icon: Wrench },
  { id: 'integrations' as const, label: 'Integrations', icon: Server },
  { id: 'triggers' as const, label: 'Triggers', icon: Zap },
];

export function WorkerConfigPage({
  workerId: propWorkerId,
  initialView: propInitialView,
}: WorkerConfigPageProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  // Read params directly from route to react to changes
  const { workerId: routeWorkerId, view: routeView } = useLocalSearchParams<{
    workerId?: string;
    view?: 'instructions' | 'tools' | 'integrations' | 'triggers';
  }>();

  // Use route params if available, otherwise fall back to props
  const workerId = routeWorkerId || propWorkerId;
  const initialView = routeView || propInitialView || 'instructions';

  const [activeView, setActiveView] = useState<ConfigView>(initialView);

  const { data: agent, isLoading } = useAgent(workerId);

  // Update activeView when route params change (but only update state, don't navigate)
  useEffect(() => {
    if (initialView && initialView !== activeView) {
      setActiveView(initialView);
    }
  }, [initialView]); // Removed activeView from deps to prevent loops

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      // If no previous screen, navigate to home
      router.replace('/home');
    }
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View
        className="flex-row items-center justify-between border-b border-border px-4 pb-3"
        style={{ paddingTop: insets.top + 8 }}>
        <View className="flex-1 flex-row items-center gap-3">
          <Pressable
            onPress={handleBack}
            className="h-10 w-10 items-center justify-center rounded-xl active:opacity-80">
            <Icon as={ChevronLeft} size={24} className="text-foreground" />
          </Pressable>
          <View className="flex-1">
            {isLoading || !agent ? (
              <>
                <View className="h-5 w-32 animate-pulse rounded bg-muted" />
                <View className="mt-1.5 h-3 w-24 animate-pulse rounded bg-muted" />
              </>
            ) : (
              <>
                <Text className="font-roobert-semibold text-lg text-foreground">{agent.name}</Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">Worker Configuration</Text>
              </>
            )}
          </View>
        </View>
      </View>

      {/* Tab Menu */}
      <View className="border-b border-border bg-background">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16 }}
          className="flex-row">
          {menuItems.map((item) => {
            const IconComponent = item.icon;
            const isActive = activeView === item.id;

            return (
              <Pressable
                key={item.id}
                onPress={() => {
                  // Only update local state, don't navigate to avoid creating new instances
                  setActiveView(item.id);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                className={`items-center justify-center border-b-2 px-4 py-3 ${
                  isActive ? 'border-primary' : 'border-transparent'
                }`}>
                <View className="flex-row items-center gap-2">
                  <Icon
                    as={IconComponent}
                    size={18}
                    className={isActive ? 'text-primary' : 'text-muted-foreground'}
                  />
                  <Text
                    className={`font-roobert-medium text-sm ${
                      isActive ? 'text-primary' : 'text-muted-foreground'
                    }`}>
                    {item.label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <View className="flex-1" style={{ padding: 16 }}>
        {/* Content */}
        {isLoading || !agent ? (
          <View className="flex-1 items-center justify-center p-8">
            <Loading title="Loading worker..." />
          </View>
        ) : activeView === 'instructions' ? (
          <InstructionsScreen agentId={workerId} onUpdate={() => {}} />
        ) : activeView === 'tools' ? (
          <ToolsScreen agentId={workerId} onUpdate={() => {}} />
        ) : activeView === 'integrations' ? (
          <IntegrationsScreen agentId={workerId} onUpdate={() => {}} />
        ) : (
          <TriggersScreen agentId={workerId} onUpdate={() => {}} />
        )}
      </View>
    </View>
  );
}
