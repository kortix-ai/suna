/**
 * Worker Creation Drawer
 *
 * Uses @gorhom/bottom-sheet for consistent design with the rest of the app
 * Matches TriggerCreationDrawer styling
 * Supports three creation methods: scratch, chat, template
 */

import React, { useState, useEffect } from 'react';
import { View, Pressable, TextInput, Alert, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import {
  Wrench,
  MessageSquare,
  Globe,
  ChevronRight,
  ArrowLeft,
  Sparkles,
} from 'lucide-react-native';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useCreateAgent, useCreateNewAgent } from '@/lib/agents/hooks';
import { API_URL, getAuthHeaders } from '@/api/config';
import { Loading } from '../loading/loading';
import type { AgentCreateRequest } from '@/api/types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface WorkerCreationDrawerProps {
  visible: boolean;
  onClose: () => void;
  onWorkerCreated?: (workerId: string) => void;
}

type CreationOption = 'scratch' | 'chat' | 'template';

const creationOptions = [
  {
    id: 'scratch' as const,
    icon: Wrench,
    label: 'Configure Manually',
    description: 'Full control over every setting',
  },
  {
    id: 'chat' as const,
    icon: MessageSquare,
    label: 'Configure by Chat',
    description: 'Let AI set it up for you',
  },
  {
    id: 'template' as const,
    icon: Globe,
    label: 'Explore Templates',
    description: 'Start from a pre-built worker',
  },
];

interface OptionCardProps {
  option: typeof creationOptions[0];
  isSelected: boolean;
  isLoading: boolean;
  onPress: () => void;
}

function OptionCard({ option, isSelected, isLoading, onPress }: OptionCardProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  const IconComponent = option.icon;

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
      disabled={isLoading}
      className={`mb-3 rounded-2xl border p-4 ${
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card active:opacity-80'
      } ${isLoading ? 'opacity-50' : ''}`}>
      <View className="flex-row items-center gap-3">
        <View
          className={`h-12 w-12 items-center justify-center rounded-xl ${
            isSelected ? 'bg-primary/10' : 'bg-muted/60'
          }`}>
          <Icon
            as={IconComponent}
            size={24}
            className={isSelected ? 'text-primary' : 'text-muted-foreground'}
          />
        </View>
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="font-roobert-semibold text-base text-foreground">
              {option.label}
            </Text>
            {isLoading && (
              <View className="h-3.5 w-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            )}
          </View>
          <Text className="mt-0.5 font-roobert text-sm text-muted-foreground">
            {option.description}
          </Text>
        </View>
        {!isLoading && <Icon as={ChevronRight} size={20} className="text-muted-foreground" />}
      </View>
    </AnimatedPressable>
  );
}

export function WorkerCreationDrawer({
  visible,
  onClose,
  onWorkerCreated,
}: WorkerCreationDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const { colorScheme } = useColorScheme();
  const [selectedOption, setSelectedOption] = useState<CreationOption | null>(null);
  const [showChatStep, setShowChatStep] = useState(false);
  const [chatDescription, setChatDescription] = useState('');

  const createNewAgentMutation = useCreateNewAgent();
  const createAgentMutation = useCreateAgent();

  // Setup agent from chat API call
  const setupAgentFromChat = async (description: string) => {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_URL}/agents/setup-from-chat`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ description }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `Failed to create agent: ${response.statusText}`);
    }

    return response.json();
  };

  // Snap points for bottom sheet
  const snapPoints = React.useMemo(() => ['90%'], []);

  // Handle visibility changes
  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.expand();
    } else {
      bottomSheetRef.current?.close();
      // Reset state when closing
      setSelectedOption(null);
      setShowChatStep(false);
      setChatDescription('');
    }
  }, [visible]);

  // Handle sheet changes
  const handleSheetChanges = React.useCallback((index: number) => {
    if (index === -1) {
      onClose();
    }
  }, [onClose]);

  // Backdrop component
  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    []
  );

  const handleOptionClick = (option: CreationOption) => {
    setSelectedOption(option);

    if (option === 'scratch') {
      // Create agent and open config
      createNewAgentMutation.mutate(
        {} as AgentCreateRequest, // Empty object, defaults will be used
        {
          onSuccess: (newAgent) => {
            onClose();
            onWorkerCreated?.(newAgent.agent_id);
          },
          onError: (error: any) => {
            console.error('Failed to create agent:', error);
            Alert.alert(
              'Error',
              error?.message || 'Failed to create worker. Please try again.'
            );
          },
        }
      );
    } else if (option === 'chat') {
      // Show chat configuration step
      setShowChatStep(true);
    } else if (option === 'template') {
      // For now, show alert - templates can be implemented later
      Alert.alert(
        'Templates',
        'Template browsing will be available soon. For now, please use "Configure Manually" or "Configure by Chat".'
      );
    }
  };

  const handleChatContinue = async () => {
    if (!chatDescription.trim()) {
      Alert.alert('Error', 'Please describe what your Worker should be able to do');
      return;
    }

    try {
      const result = await setupAgentFromChat(chatDescription);
      onClose();
      onWorkerCreated?.(result.agent_id);
    } catch (error: any) {
      console.error('Error creating agent from chat:', error);
      Alert.alert(
        'Error',
        error?.message || 'Failed to create worker. Please try again.'
      );
    }
  };

  const handleBack = () => {
    setShowChatStep(false);
    setSelectedOption(null);
    setChatDescription('');
  };

  const isLoading = createNewAgentMutation.isPending || createAgentMutation.isPending;

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: colorScheme === 'dark' ? '#18181B' : '#FFFFFF',
      }}
      handleIndicatorStyle={{
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
      }}>
      <BottomSheetScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}>
        {!showChatStep ? (
          <>
            {/* Header */}
            <View className="items-center mb-6">
              <View className="mb-3 p-3 rounded-2xl bg-muted/50">
                <Icon as={Sparkles} size={28} className="text-primary" />
              </View>
              <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                Create a new Worker
              </Text>
              <Text className="text-sm text-center text-muted-foreground max-w-sm">
                Choose how you'd like to set up your new worker
              </Text>
            </View>

            {/* Options */}
            <View className="mb-4">
              {creationOptions.map((option) => (
                <OptionCard
                  key={option.id}
                  option={option}
                  isSelected={selectedOption === option.id}
                  isLoading={isLoading && selectedOption === option.id}
                  onPress={() => handleOptionClick(option.id)}
                />
              ))}
            </View>

            {/* Cancel button */}
            <Pressable
              onPress={onClose}
              className="rounded-xl border border-border bg-card p-3 active:opacity-80">
              <Text className="text-center font-roobert-medium text-sm text-muted-foreground">
                Cancel
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            {/* Chat Step Header */}
            <View className="items-center mb-5">
              <Pressable
                onPress={handleBack}
                className="absolute left-0 top-0 h-10 w-10 items-center justify-center rounded-xl active:opacity-80">
                <Icon as={ArrowLeft} size={20} className="text-foreground" />
              </Pressable>
              <View className="mb-3 p-3 rounded-2xl bg-muted/50">
                <Icon as={Sparkles} size={28} className="text-primary" />
              </View>
              <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                Describe your Worker
              </Text>
              <Text className="text-sm text-center text-muted-foreground max-w-sm">
                Tell us what your worker should be able to do
              </Text>
            </View>

            {/* Textarea */}
            <View className="mb-6">
              <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={true}
                style={{
                  borderRadius: 16,
                  borderWidth: 1.5,
                  borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
                  backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
                  maxHeight: 200,
                }}
                contentContainerStyle={{
                  padding: 16,
                }}>
                <TextInput
                  value={chatDescription}
                  onChangeText={setChatDescription}
                  placeholder="e.g., A worker that monitors competitor prices and sends me daily reports..."
                  placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                  multiline
                  scrollEnabled={false}
                  style={{
                    minHeight: 120,
                    fontSize: 16,
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                    textAlignVertical: 'top',
                  }}
                  autoFocus
                />
              </ScrollView>
            </View>

            {/* Actions */}
            <View className="space-y-3">
              <Pressable
                onPress={handleChatContinue}
                disabled={!chatDescription.trim() || isLoading}
                className={`rounded-xl p-4 ${
                  !chatDescription.trim() || isLoading
                    ? 'bg-muted opacity-50'
                    : 'bg-primary active:opacity-80'
                }`}>
                <Text className="text-center font-roobert-semibold text-base text-primary-foreground">
                  {isLoading ? 'Creating...' : 'Create Worker'}
                </Text>
              </Pressable>
              <Pressable
                onPress={handleBack}
                disabled={isLoading}
                className="rounded-xl border border-border bg-card p-3 active:opacity-80">
                <View className="flex-row items-center justify-center gap-2">
                  <Icon as={ArrowLeft} size={16} className="text-muted-foreground" />
                  <Text className="font-roobert-medium text-sm text-muted-foreground">Back</Text>
                </View>
              </Pressable>
            </View>
          </>
        )}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

