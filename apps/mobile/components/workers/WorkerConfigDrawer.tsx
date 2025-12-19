/**
 * Worker Configuration Drawer
 *
 * Uses @gorhom/bottom-sheet for configuring workers
 * Supports: Instructions, Tools, Integrations
 * Excludes: Knowledge (as per requirements)
 */

import React, { useState, useEffect } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { Brain, Wrench, Server, Zap, X, ArrowLeft } from 'lucide-react-native';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useAgent, useUpdateAgent } from '@/lib/agents/hooks';
import { Loading } from '../loading/loading';
import { InstructionsScreen } from './screens/InstructionsScreen';
import { ToolsScreen } from './screens/ToolsScreen';
import { IntegrationsScreen } from './screens/IntegrationsScreen';
import { TriggersScreen } from './screens/TriggersScreen';

interface WorkerConfigDrawerProps {
  visible: boolean;
  workerId: string | null;
  onClose: () => void;
  onWorkerUpdated?: () => void;
  initialView?: 'instructions' | 'tools' | 'integrations' | 'triggers';
  onUpgradePress?: () => void;
}

type ConfigView = 'instructions' | 'tools' | 'integrations' | 'triggers';

const menuItems = [
  { id: 'instructions' as const, label: 'Instructions', icon: Brain },
  { id: 'tools' as const, label: 'Tools', icon: Wrench },
  { id: 'integrations' as const, label: 'Integrations', icon: Server },
  { id: 'triggers' as const, label: 'Triggers', icon: Zap },
];

export function WorkerConfigDrawer({
  visible,
  workerId,
  onClose,
  onWorkerUpdated,
  initialView = 'instructions',
  onUpgradePress,
}: WorkerConfigDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const { colorScheme } = useColorScheme();
  // Initialize activeView with initialView, and update it whenever initialView changes
  const [activeView, setActiveView] = useState<ConfigView>(initialView);

  const { data: agent, isLoading } = useAgent(workerId || undefined);

  // Snap points for bottom sheet
  const snapPoints = React.useMemo(() => ['95%'], []);

  // Update activeView when initialView changes (e.g., switching tabs)
  // This ensures the correct tab is shown when the drawer opens or when switching tabs
  useEffect(() => {
    if (initialView && initialView !== activeView) {
      setActiveView(initialView);
    }
  }, [initialView, activeView]);

  // Handle visibility changes
  useEffect(() => {
    if (visible && workerId) {
      // Ensure activeView matches initialView when opening
      if (initialView && initialView !== activeView) {
        setActiveView(initialView);
      }
      bottomSheetRef.current?.present();
    } else if (!visible) {
      bottomSheetRef.current?.dismiss();
    }
  }, [visible, workerId, initialView, activeView]);

  // Handle dismiss
  const handleDismiss = React.useCallback(() => {
    onClose();
  }, [onClose]);

  // Backdrop component
  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    []
  );

  // Use BottomSheetModal to render above everything (hamburger menu, credits, etc.)
  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={snapPoints}
      onDismiss={handleDismiss}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: colorScheme === 'dark' ? '#18181B' : '#FFFFFF',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={{
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}>
      <View className="flex-1">
        {/* Header */}
        <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={onClose}
              className="h-10 w-10 items-center justify-center rounded-xl active:opacity-80">
              <Icon as={ArrowLeft} size={20} className="text-foreground" />
            </Pressable>
            <View>
              {isLoading || !agent ? (
                <>
                  <View className="h-5 w-32 animate-pulse rounded bg-muted" />
                  <View className="mt-1 h-3 w-24 animate-pulse rounded bg-muted" />
                </>
              ) : (
                <>
                  <Text className="font-roobert-semibold text-lg text-foreground">
                    {agent.name}
                  </Text>
                  <Text className="text-xs text-muted-foreground">Worker Configuration</Text>
                </>
              )}
            </View>
          </View>
          <Pressable
            onPress={onClose}
            className="h-10 w-10 items-center justify-center rounded-xl active:opacity-80">
            <Icon as={X} size={20} className="text-muted-foreground" />
          </Pressable>
        </View>

        {/* Tab Menu */}
        <View className="border-b border-border">
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

        {/* Content */}
        {!workerId ? (
          <View className="flex-1 items-center justify-center p-8">
            <Loading title="Loading worker..." />
          </View>
        ) : isLoading || !agent ? (
          <View className="flex-1 items-center justify-center p-8">
            <Loading title="Loading worker..." />
          </View>
        ) : (
          <BottomSheetScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            showsVerticalScrollIndicator={false}>
            {activeView === 'instructions' && (
              <InstructionsScreen agentId={workerId} onUpdate={onWorkerUpdated} />
            )}
            {activeView === 'tools' && (
              <ToolsScreen agentId={workerId} onUpdate={onWorkerUpdated} />
            )}
            {activeView === 'integrations' && (
              <IntegrationsScreen
                agentId={workerId}
                onUpdate={onWorkerUpdated}
                onUpgradePress={onUpgradePress}
              />
            )}
            {activeView === 'triggers' && (
              <TriggersScreen
                agentId={workerId}
                onUpdate={onWorkerUpdated}
                onUpgradePress={onUpgradePress}
              />
            )}
          </BottomSheetScrollView>
        )}
      </View>
    </BottomSheetModal>
  );
}
