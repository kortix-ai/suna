/**
 * Trigger Creation Drawer
 *
 * Uses @gorhom/bottom-sheet for consistent design with the rest of the app
 * Matches AgentDrawer and ThreadActionsDrawer styling
 * Supports both Schedule and Event-based triggers
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Pressable, TextInput, Alert, Image, ScrollView, Platform } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import {
  Clock,
  Sparkles,
  ChevronRight,
  Check,
  Zap,
  Target,
  Calendar as CalendarIcon,
  Link2,
  CheckCircle2,
  ArrowLeft,
  Info,
  Lock,
} from 'lucide-react-native';
import { useBillingContext } from '@/contexts/BillingContext';
import { FreeTierBlock } from '@/components/billing/FreeTierBlock';
import { useAgent } from '@/contexts/AgentContext';
import { useRouter } from 'expo-router';
import { extractErrorMessage } from '@/lib/utils/error-handler';
import {
  useCreateTrigger,
  useUpdateTrigger,
  useComposioAppsWithTriggers,
  useComposioAppTriggers,
  useCreateComposioEventTrigger,
} from '@/lib/triggers';
import type { TriggerConfiguration } from '@/api/types';
import { useComposioProfiles } from '@/hooks/useComposio';
import type { ComposioApp, ComposioProfile } from '@/hooks/useComposio';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Loading } from '../loading/loading';
import { AppSelectionStep } from './AppSelectionStep';
import { TriggerSelectionStep } from './TriggerSelectionStep';
import { TriggerConfigStep } from './TriggerConfigStep';
import { ComposioConnectorContent } from '../settings/integrations/ComposioConnector';
import type { TriggerApp, ComposioTriggerType } from '@/api/types';
import { SvgUri } from 'react-native-svg';
import { useLanguage } from '@/contexts/LanguageContext';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TriggerCreationDrawerProps {
  visible: boolean;
  onClose: () => void;
  onTriggerCreated?: (triggerId: string) => void;
  onTriggerUpdated?: (triggerId: string) => void;
  isEditMode?: boolean;
  existingTrigger?: TriggerConfiguration | null;
  agentId?: string; // Optional agentId prop - if not provided, uses selectedAgentId from context
  onUpgradePress?: () => void;
}

type TriggerStep = 'type' | 'config';
type EventTriggerStep = 'apps' | 'triggers' | 'config';
type ScheduleMode = 'preset' | 'recurring' | 'advanced';
type RecurringType = 'daily' | 'weekly' | 'monthly';

// Schedule presets
const SCHEDULE_PRESETS = [
  { id: 'every-15min', name: 'Every 15 min', cron: '*/15 * * * *', icon: Zap },
  { id: 'hourly', name: 'Every hour', cron: '0 * * * *', icon: Clock },
  { id: 'daily-9am', name: 'Daily at 9 AM', cron: '0 9 * * *', icon: Target },
  { id: 'weekdays-9am', name: 'Weekdays 9 AM', cron: '0 9 * * 1-5', icon: CalendarIcon },
];

const WEEKDAYS = [
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
  { value: '0', label: 'Sun' },
];

interface TypeCardProps {
  icon: any;
  title: string;
  subtitle: string;
  onPress: () => void;
}

function TypeCard({ icon: IconComponent, title, subtitle, onPress }: TypeCardProps) {
  const { colorScheme } = useColorScheme();

  return (
    <BottomSheetTouchable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={{
        marginBottom: 12,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: colorScheme === 'dark' ? '#3f3f46' : '#e4e4e7',
        backgroundColor: colorScheme === 'dark' ? '#27272a' : '#ffffff',
        padding: 16,
      }}>
      <View className="flex-row items-center gap-3">
        <View className="h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Icon as={IconComponent} size={24} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="mb-1 font-roobert-semibold text-base text-foreground">{title}</Text>
          <Text className="font-roobert text-sm text-muted-foreground">{subtitle}</Text>
        </View>
        <Icon as={ChevronRight} size={20} className="text-muted-foreground" />
      </View>
    </BottomSheetTouchable>
  );
}

function AppLogo({ app }: { app: TriggerApp }) {
  const isSvg = (url: string) =>
    url.toLowerCase().endsWith('.svg') || url.includes('composio.dev/api');

  return (
    <View className="h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
      {isSvg(app.logo) ? (
        <SvgUri uri={app.logo} width={24} height={24} />
      ) : (
        <Image source={{ uri: app.logo }} style={{ width: 24, height: 24 }} resizeMode="contain" />
      )}
    </View>
  );
}

export function TriggerCreationDrawer({
  visible,
  onClose,
  onTriggerCreated,
  onTriggerUpdated,
  isEditMode = false,
  existingTrigger = null,
  agentId: propAgentId,
  onUpgradePress,
}: TriggerCreationDrawerProps) {
  const bottomSheetModalRef = React.useRef<BottomSheetModal>(null);
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const { selectedAgentId: contextAgentId } = useAgent();
  const { hasFreeTier } = useBillingContext();
  const { t } = useLanguage();

  // Handle upgrade press - use provided callback or navigate to plans
  const handleUpgradePress = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if (onUpgradePress) {
      onUpgradePress();
    } else {
      router.push('/plans');
    }
  }, [onUpgradePress, router]);

  // Use prop agentId if provided, otherwise fall back to context
  const agentId = propAgentId || contextAgentId;

  const [currentStep, setCurrentStep] = useState<TriggerStep>(isEditMode ? 'config' : 'type');
  const [selectedType, setSelectedType] = useState<'schedule' | 'event' | null>(
    isEditMode && existingTrigger
      ? existingTrigger.provider_id === 'composio' ||
        existingTrigger.provider_id === 'event' ||
        existingTrigger.trigger_type === 'event'
        ? 'event'
        : 'schedule'
      : null
  );
  const [eventStep, setEventStep] = useState<EventTriggerStep>(() => {
    if (isEditMode && existingTrigger) {
      const isEventTrigger =
        existingTrigger.provider_id === 'composio' ||
        existingTrigger.provider_id === 'event' ||
        existingTrigger.trigger_type === 'event';
      // In edit mode, event triggers should go directly to config step
      return isEventTrigger ? 'config' : 'apps';
    }
    return 'apps';
  });

  // Schedule trigger state
  const [triggerName, setTriggerName] = useState('');
  const [description, setDescription] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('preset');
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [cronExpression, setCronExpression] = useState('');
  const [recurringType, setRecurringType] = useState<RecurringType>('daily');
  const [selectedHour, setSelectedHour] = useState('9');
  const [selectedMinute, setSelectedMinute] = useState('0');
  const [selectedWeekdays, setSelectedWeekdays] = useState<string[]>([]);

  // Event trigger state
  const [selectedApp, setSelectedApp] = useState<TriggerApp | null>(null);
  const [selectedTrigger, setSelectedTrigger] = useState<ComposioTriggerType | null>(null);
  const [eventConfig, setEventConfig] = useState<Record<string, any>>({});
  const [profileId, setProfileId] = useState('');
  const [model, setModel] = useState('kortix/basic');
  const [showComposioConnector, setShowComposioConnector] = useState(false);
  const [appSearchQuery, setAppSearchQuery] = useState('');

  // Hooks
  const createTriggerMutation = useCreateTrigger();
  const updateTriggerMutation = useUpdateTrigger();
  const createEventTriggerMutation = useCreateComposioEventTrigger();
  const {
    data: triggersApps,
    isLoading: triggersAppsLoading,
    error: triggersAppsError,
    refetch: refetchTriggersApps,
  } = useComposioAppsWithTriggers();
  const {
    data: triggersData,
    isLoading: loadingTriggers,
    error: triggersError,
    refetch: refetchTriggers,
  } = useComposioAppTriggers(
    selectedApp?.slug,
    visible && !!selectedApp && (eventStep === 'triggers' || (isEditMode && eventStep === 'config'))
  );
  const {
    data: profiles,
    isLoading: isLoadingProfiles,
    error: profilesError,
    refetch: refetchProfiles,
  } = useComposioProfiles();

  // Use dynamic sizing for initial type selection to fit content, fixed height for other steps
  // In edit mode, always use fixed height since we start at config step
  const shouldUseDynamicSizing = !isEditMode && currentStep === 'type' && !selectedType;

  const snapPoints = useMemo(() => {
    // When using dynamic sizing, snapPoints are ignored, but we still need to provide them
    // For the initial type selection step (create mode only), dynamic sizing will fit content
    if (shouldUseDynamicSizing) {
      return ['50%']; // Fallback, but dynamic sizing will override
    }
    // For edit mode or other steps, use a larger height
    return ['90%'];
  }, [shouldUseDynamicSizing, isEditMode]);

  // Initialize form from existing trigger in edit mode
  useEffect(() => {
    if (isEditMode && existingTrigger) {
      const triggerConfig = existingTrigger.config || {};

      const isComposioTrigger =
        triggerConfig.provider_id === 'composio' ||
        existingTrigger.provider_id === 'composio' ||
        existingTrigger.provider_id === 'event' ||
        existingTrigger.trigger_type === 'event';

      // Set the selected type and step immediately
      if (isComposioTrigger) {
        setSelectedType('event');
        setCurrentStep('config');
        setEventStep('config'); // Event triggers should go directly to config step in edit mode
      } else {
        setSelectedType('schedule');
        setCurrentStep('config');
      }

      // Only continue with full initialization when visible
      if (!visible) return;

      // Set form values
      setTriggerName(existingTrigger.name || '');
      setDescription(existingTrigger.description || '');
      setAgentPrompt(triggerConfig.agent_prompt || '');
      setModel(triggerConfig.model || 'kortix/basic');

      if (isComposioTrigger) {
        // Event trigger
        setProfileId(triggerConfig.profile_id || '');
        const {
          agent_prompt,
          profile_id,
          provider_id,
          trigger_slug,
          qualified_name,
          model: _,
          ...triggerSpecificConfig
        } = triggerConfig;
        setEventConfig(triggerSpecificConfig);

        if (triggerConfig.trigger_slug && triggerConfig.qualified_name) {
          let toolkitSlug = '';
          if (triggerConfig.qualified_name) {
            toolkitSlug = triggerConfig.qualified_name.replace(/^composio\./, '').toLowerCase();
          }

          if (!toolkitSlug && triggerConfig.trigger_slug) {
            const slugParts = triggerConfig.trigger_slug.toLowerCase().split('_');
            if (slugParts.length > 0) {
              toolkitSlug = slugParts[0];
            }
          }

          if (toolkitSlug) {
            const app = {
              slug: toolkitSlug,
              name: toolkitSlug,
              logo: '',
            };
            setSelectedApp(app);
          }
        }
      } else {
        // Schedule trigger
        if (triggerConfig.cron_expression) {
          setCronExpression(triggerConfig.cron_expression);
          // Try to match preset
          const matchingPreset = SCHEDULE_PRESETS.find(
            (p) => p.cron === triggerConfig.cron_expression
          );
          if (matchingPreset) {
            setSelectedPreset(matchingPreset.id);
            setScheduleMode('preset');
          } else {
            setScheduleMode('advanced');
          }
        }
      }
    }
  }, [isEditMode, existingTrigger, visible]);

  // Load trigger data when app is selected in edit mode
  useEffect(() => {
    if (isEditMode && existingTrigger && selectedApp && triggersData?.items) {
      const triggerConfig = existingTrigger.config || {};
      if (triggerConfig.trigger_slug) {
        const searchSlug = triggerConfig.trigger_slug.toLowerCase();
        const matchingTrigger = triggersData.items.find((t) => t.slug.toLowerCase() === searchSlug);
        if (matchingTrigger) {
          setSelectedTrigger(matchingTrigger);
          // Update selectedApp logo from trigger toolkit if available
          if (matchingTrigger.toolkit?.logo && !selectedApp.logo) {
            setSelectedApp({
              ...selectedApp,
              logo: matchingTrigger.toolkit.logo,
            });
          }
        }
      }
    }
  }, [isEditMode, existingTrigger, selectedApp, triggersData]);

  // Reset state when drawer closes
  useEffect(() => {
    if (!visible) {
      setCurrentStep(isEditMode ? 'config' : 'type');
      setSelectedType(
        isEditMode && existingTrigger
          ? existingTrigger.provider_id === 'composio' ||
            existingTrigger.provider_id === 'event' ||
            existingTrigger.trigger_type === 'event'
            ? 'event'
            : 'schedule'
          : null
      );
      const isEventTrigger =
        isEditMode &&
        existingTrigger &&
        (existingTrigger.provider_id === 'composio' ||
          existingTrigger.provider_id === 'event' ||
          existingTrigger.trigger_type === 'event');
      setEventStep(isEventTrigger ? 'config' : 'apps');
      if (!isEditMode) {
        setTriggerName('');
        setDescription('');
        setAgentPrompt('');
        setScheduleMode('preset');
        setSelectedPreset('');
        setCronExpression('');
        setSelectedApp(null);
        setSelectedTrigger(null);
        setEventConfig({});
        setProfileId('');
        setModel('kortix/basic');
        setShowComposioConnector(false);
        setAppSearchQuery('');
      }
    }
  }, [visible, isEditMode, existingTrigger]);

  // Handle sheet visibility - use present/dismiss for BottomSheetModal
  useEffect(() => {
    if (visible) {
      bottomSheetModalRef.current?.present();
    } else {
      bottomSheetModalRef.current?.dismiss();
    }
  }, [visible]);

  const handleDismiss = () => {
    onClose();
  };

  const handleTypeSelect = (type: 'schedule' | 'event') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedType(type);
    if (type === 'event') {
      setCurrentStep('config');
      setEventStep('apps');
    } else {
      setCurrentStep('config');
    }
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isEditMode) {
      // In edit mode, back button closes the drawer
      onClose();
      return;
    }
    if (selectedType === 'event') {
      if (eventStep === 'apps') {
        // Go back to type selection
        setCurrentStep('type');
        setSelectedType(null);
        setEventStep('apps');
        setSelectedApp(null);
      } else if (eventStep === 'triggers') {
        setEventStep('apps');
        setSelectedApp(null);
      } else if (eventStep === 'config') {
        setEventStep('triggers');
        setSelectedTrigger(null);
        setEventConfig({});
      }
    } else {
      setCurrentStep('type');
      setSelectedType(null);
    }
  };

  const handlePresetSelect = (presetId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedPreset(presetId);
    const preset = SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setCronExpression(preset.cron);
    }
  };

  const toggleWeekday = (day: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const generateRecurringCron = (): string => {
    if (recurringType === 'daily') {
      return `${selectedMinute || '0'} ${selectedHour || '9'} * * *`;
    } else if (recurringType === 'weekly') {
      // Default to weekdays (Mon-Fri) if no days are selected
      const days = selectedWeekdays.length > 0 ? selectedWeekdays.join(',') : '1,2,3,4,5';
      return `${selectedMinute || '0'} ${selectedHour || '9'} * * ${days}`;
    } else {
      // monthly
      return `${selectedMinute || '0'} ${selectedHour || '9'} 1 * *`;
    }
  };

  // Validate event config
  const isEventConfigValid = useMemo(() => {
    if (!selectedTrigger?.config) return true;
    const schema = selectedTrigger.config as any;
    if (!schema.properties) return true;
    const required = schema.required || [];
    return required.every((key: string) => {
      const value = eventConfig[key];
      return value !== undefined && value !== null && value !== '';
    });
  }, [eventConfig, selectedTrigger]);

  // Helper to check connection status for an app
  const getAppConnectionStatus = useMemo(() => {
    return (appSlug: string) => {
      if (!profiles) return { isConnected: false, hasProfiles: false };
      const appProfiles = profiles.filter((p: ComposioProfile) => p.toolkit_slug === appSlug);
      const connectedProfiles = appProfiles.filter((p: ComposioProfile) => p.is_connected);
      return {
        isConnected: connectedProfiles.length > 0,
        hasProfiles: appProfiles.length > 0,
      };
    };
  }, [profiles]);

  const handleCreate = async () => {
    if (isEditMode && existingTrigger) {
      // Update existing trigger
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

        if (selectedType === 'event') {
          if (!triggerName.trim() || !agentPrompt.trim() || !profileId || !isEventConfigValid) {
            Alert.alert('Error', 'Please fill in all required fields');
            return;
          }

          const updatedConfig = {
            ...eventConfig,
            profile_id: profileId,
            trigger_slug: selectedTrigger!.slug,
            qualified_name: `composio.${selectedApp?.slug}`,
            provider_id: 'composio',
            agent_prompt: agentPrompt,
            model: model,
          };

          const result = await updateTriggerMutation.mutateAsync({
            triggerId: existingTrigger.trigger_id,
            data: {
              name: triggerName,
              description: description || existingTrigger.description,
              config: updatedConfig,
            },
          });

          log.log('✅ Event trigger updated successfully:', result.trigger_id);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onTriggerUpdated?.(result.trigger_id);
        } else {
          // Schedule trigger update
          if (!triggerName.trim() || !agentPrompt.trim()) {
            Alert.alert('Error', 'Please fill in all required fields');
            return;
          }

          let finalCron = '';
          if (scheduleMode === 'preset') {
            finalCron = cronExpression;
          } else if (scheduleMode === 'recurring') {
            finalCron = generateRecurringCron();
          } else {
            finalCron = cronExpression;
          }

          if (!finalCron) {
            Alert.alert('Error', 'Please configure a schedule');
            return;
          }

          const config = {
            cron_expression: finalCron,
            agent_prompt: agentPrompt,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          };

          const result = await updateTriggerMutation.mutateAsync({
            triggerId: existingTrigger.trigger_id,
            data: {
              name: triggerName,
              description: description || existingTrigger.description,
              config,
            },
          });

          log.log('✅ Schedule trigger updated successfully:', result.trigger_id);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onTriggerUpdated?.(result.trigger_id);
        }

        onClose();
      } catch (error: any) {
        log.error('❌ Error updating trigger:', error);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

        // Extract user-friendly error message using utility function
        const errorMessage =
          extractErrorMessage(error) || 'Failed to update trigger. Please try again.';

        Alert.alert('Error Updating Trigger', errorMessage);
      }
      return;
    }

    // Create new trigger
    if (selectedType === 'event') {
      if (!triggerName.trim()) {
        Alert.alert('Error', 'Please enter a trigger name');
        return;
      }
      if (!agentPrompt.trim()) {
        Alert.alert('Error', 'Please enter agent instructions');
        return;
      }
      if (!profileId) {
        Alert.alert('Error', 'Please select a connection profile');
        return;
      }
      if (!isEventConfigValid) {
        Alert.alert('Error', 'Please fill in all required trigger configuration fields');
        return;
      }

      if (!agentId) {
        Alert.alert('Error', 'Please select an agent first');
        return;
      }

      if (!selectedTrigger) {
        Alert.alert('Error', 'Please select a trigger');
        return;
      }

      if (!selectedApp) {
        Alert.alert('Error', 'Please select an app');
        return;
      }

      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

        const selectedProfile = profiles?.find((p: ComposioProfile) => p.profile_id === profileId);

        const payload = {
          agent_id: agentId,
          slug: selectedTrigger.slug,
          toolkit_slug: selectedApp.slug,
          profile_id: profileId,
          name: triggerName,
          agent_prompt: agentPrompt,
          trigger_config: eventConfig,
          route: 'agent' as const,
          model: model,
          connected_account_id: selectedProfile?.connected_account_id,
        };

        const result = await createEventTriggerMutation.mutateAsync(payload);

        log.log('✅ Event trigger created successfully:', result.trigger_id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        onTriggerCreated?.(result.trigger_id);
        onClose();
      } catch (error: any) {
        log.error('❌ Error creating event trigger:', error);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

        // Extract user-friendly error message using utility function
        const errorMessage =
          extractErrorMessage(error) || 'Failed to create event trigger. Please try again.';

        Alert.alert('Error Creating Trigger', errorMessage);
      }
    } else {
      if (!triggerName.trim()) {
        Alert.alert('Error', 'Please enter a trigger name');
        return;
      }
      if (!agentPrompt.trim()) {
        Alert.alert('Error', 'Please enter agent instructions');
        return;
      }

      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

        let finalCron = '';
        if (scheduleMode === 'preset') {
          finalCron = cronExpression;
        } else if (scheduleMode === 'recurring') {
          finalCron = generateRecurringCron();
        } else {
          finalCron = cronExpression;
        }

        if (!finalCron) {
          Alert.alert('Error', 'Please configure a schedule');
          return;
        }

        const config = {
          cron_expression: finalCron,
          agent_prompt: agentPrompt,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };

        if (!agentId) {
          Alert.alert('Error', 'Please select an agent first');
          return;
        }

        const result = await createTriggerMutation.mutateAsync({
          agentId: agentId,
          data: {
            provider_id: 'schedule',
            name: triggerName,
            description: description,
            config,
          },
        });

        log.log('✅ Trigger created successfully:', result.trigger_id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        onTriggerCreated?.(result.trigger_id);
        onClose();
      } catch (error: any) {
        log.error('❌ Error creating trigger:', error);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

        // Extract user-friendly error message using utility function
        const errorMessage =
          extractErrorMessage(error) || 'Failed to create trigger. Please try again.';

        Alert.alert('Error Creating Trigger', errorMessage);
      }
    }
  };

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    []
  );

  // Check if we should show action buttons
  const showActionButtons =
    (selectedType === 'schedule' && currentStep === 'config') ||
    (selectedType === 'event' && eventStep === 'config');

  // Check if form is valid
  const isFormValid =
    selectedType === 'event'
      ? triggerName.trim() && profileId && isEventConfigValid && agentPrompt.trim()
      : triggerName.trim() &&
        agentPrompt.trim() &&
        (scheduleMode === 'preset'
          ? cronExpression.trim()
          : scheduleMode === 'recurring'
            ? true
            : cronExpression.trim());

  return (
    <BottomSheetModal
      ref={bottomSheetModalRef}
      snapPoints={snapPoints}
      enablePanDownToClose
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
      }}
      handleIndicatorStyle={{
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
        marginTop: 8,
        marginBottom: 0,
      }}
      enableDynamicSizing={shouldUseDynamicSizing}
      style={{
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden',
      }}>
      <BottomSheetScrollView
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: 16,
          paddingBottom: showActionButtons ? 30 : 40,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        {/* Composio Connector - Show instead of other content */}
        {selectedApp && showComposioConnector ? (
          <ComposioConnectorContent
            app={
              {
                name: selectedApp.name,
                slug: selectedApp.slug,
                logo: selectedApp.logo,
                description: `Connect your ${selectedApp.name} account to create event triggers`,
                categories: [],
                connected: false,
                connection_status: 'requires_auth',
              } as ComposioApp
            }
            onBack={() => {
              setShowComposioConnector(false);
              if (eventStep === 'triggers') {
                setEventStep('apps');
                setSelectedApp(null);
              }
            }}
            onComplete={(createdProfileId, appName, appSlug) => {
              setProfileId(createdProfileId);
              setShowComposioConnector(false);
              refetchProfiles();
              // After creating profile, move to triggers step if we're still on apps step
              if (eventStep === 'apps') {
                setEventStep('triggers');
              }
            }}
            mode="profile-only"
            noPadding={false}
          />
        ) : (
          <>
            {/* Header */}
            <View className="flex-row items-center pb-4 pt-4">
              {(currentStep !== 'type' || isEditMode) && (
                <Pressable onPress={handleBack} className="mr-3 active:opacity-70">
                  {(() => {
                    // Show app logo if available, otherwise show trigger toolkit logo if available
                    if (selectedApp) {
                      return <AppLogo app={selectedApp} />;
                    }
                    if (selectedTrigger?.toolkit) {
                      const toolkitApp: TriggerApp = {
                        slug: selectedTrigger.toolkit.slug,
                        name: selectedTrigger.toolkit.name,
                        logo: selectedTrigger.toolkit.logo || '',
                      };
                      return <AppLogo app={toolkitApp} />;
                    }
                    return null;
                  })()}
                </Pressable>
              )}
              <View className="flex-1">
                <Text className="font-roobert-semibold text-xl text-foreground">
                  {isEditMode
                    ? t('triggers.editTrigger')
                    : currentStep === 'type'
                      ? t('triggers.createTrigger')
                      : selectedType === 'event'
                        ? eventStep === 'apps'
                          ? t('triggers.selectApplication')
                          : eventStep === 'triggers'
                            ? `${selectedApp?.name || ''} ${t('triggers.triggers')}`
                            : t('triggers.configureTrigger')
                        : t('triggers.scheduleTrigger')}
                </Text>
                <Text className="mt-1 font-roobert text-sm text-muted-foreground">
                  {isEditMode
                    ? t('triggers.updateYourConfig')
                    : currentStep === 'type'
                      ? t('triggers.chooseType')
                      : selectedType === 'event'
                        ? eventStep === 'apps'
                          ? t('triggers.chooseAppToMonitor')
                          : eventStep === 'triggers'
                            ? t('triggers.chooseEventToMonitor')
                            : t('triggers.configureYourTrigger')
                        : t('triggers.configureYourTrigger')}
                </Text>
              </View>
            </View>

            {/* Progress Stepper for Event Triggers */}
            {selectedType === 'event' && currentStep !== 'type' && (
              <View className="-mx-6 mb-6 border-b border-border bg-muted/30 px-6 py-3">
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingRight: 24,
                  }}>
                  {[
                    { id: 'apps', name: t('triggers.selectApp'), icon: Link2 },
                    { id: 'triggers', name: t('triggers.chooseTrigger'), icon: Zap },
                    { id: 'config', name: t('triggers.configure'), icon: Sparkles },
                  ].map((step, index) => {
                    const stepIndex = ['apps', 'triggers', 'config'].indexOf(eventStep);
                    const isCompleted = index < stepIndex;
                    const isCurrent = index === stepIndex;

                    return (
                      <React.Fragment key={step.id}>
                        <View className="flex-row items-center gap-2" style={{ minWidth: 100 }}>
                          <View
                            className={`h-6 w-6 items-center justify-center rounded-full ${
                              isCompleted || isCurrent ? 'bg-primary' : 'bg-muted'
                            }`}>
                            {isCompleted ? (
                              <Icon
                                as={CheckCircle2}
                                size={12}
                                className="text-primary-foreground"
                              />
                            ) : (
                              <Text
                                className={`font-roobert-semibold text-xs ${
                                  isCompleted || isCurrent
                                    ? 'text-primary-foreground'
                                    : 'text-muted-foreground'
                                }`}>
                                {index + 1}
                              </Text>
                            )}
                          </View>
                          <Text
                            className={`font-roobert-medium text-sm ${
                              isCompleted || isCurrent ? 'text-foreground' : 'text-muted-foreground'
                            }`}>
                            {step.name}
                          </Text>
                        </View>
                        {index < 2 && (
                          <Icon
                            as={ChevronRight}
                            size={16}
                            className="mx-2 text-muted-foreground"
                            style={{ opacity: 0.5 }}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            {/* Type Selection Step */}
            {currentStep === 'type' && !isEditMode && (
              <View className="space-y-3">
                {hasFreeTier ? (
                  <FreeTierBlock
                    variant="automation"
                    onUpgradePress={handleUpgradePress}
                    style="card"
                  />
                ) : (
                  <>
                    <TypeCard
                      icon={Clock}
                      title={t('triggers.scheduleTrigger')}
                      subtitle={t('triggers.runOnSchedule')}
                      onPress={() => handleTypeSelect('schedule')}
                    />
                    <TypeCard
                      icon={Sparkles}
                      title={t('triggers.eventTrigger')}
                      subtitle={t('triggers.fromExternalApps')}
                      onPress={() => handleTypeSelect('event')}
                    />
                  </>
                )}
              </View>
            )}

            {/* Schedule Configuration Step */}
            {currentStep === 'config' && selectedType === 'schedule' && (
              <View className="space-y-8">
                {/* Name Input */}
                <View style={{ marginBottom: 16 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                      marginBottom: 8,
                    }}>
                    {t('triggers.nameRequired')}
                  </Text>
                  <TextInput
                    value={triggerName}
                    onChangeText={setTriggerName}
                    placeholder={t('triggers.dailyAt9Am')}
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

                {/* Schedule Mode Tabs */}
                <View className="space-y-4" style={{ marginBottom: 16 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                      marginBottom: 8,
                    }}>
                    {t('triggers.scheduleRequired')}
                  </Text>
                  <View className="flex-row gap-3">
                    {(['preset', 'recurring', 'advanced'] as const).map((mode) => (
                      <Pressable
                        key={mode}
                        onPress={() => setScheduleMode(mode)}
                        className={`flex-1 rounded-xl border py-3.5 ${
                          scheduleMode === mode
                            ? 'border-primary bg-primary/10'
                            : 'border-border bg-card'
                        } active:opacity-80`}>
                        <Text
                          className={`text-center font-roobert-medium text-sm ${
                            scheduleMode === mode ? 'text-primary' : 'text-foreground'
                          }`}>
                          {mode.charAt(0).toUpperCase() + mode.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  {/* Preset Options */}
                  {scheduleMode === 'preset' && (
                    <View className="mt-4 flex flex-col gap-2 space-y-3">
                      {SCHEDULE_PRESETS.map((preset) => (
                        <Pressable
                          key={preset.id}
                          onPress={() => handlePresetSelect(preset.id)}
                          className={`flex-row items-center rounded-xl border p-4 ${
                            selectedPreset === preset.id
                              ? 'border-primary bg-primary/10'
                              : 'border-border bg-card'
                          } active:opacity-80`}>
                          <Icon
                            as={preset.icon}
                            size={20}
                            className={
                              selectedPreset === preset.id ? 'text-primary' : 'text-foreground'
                            }
                          />
                          <Text
                            className={`ml-3 flex-1 font-roobert-medium text-base ${
                              selectedPreset === preset.id ? 'text-primary' : 'text-foreground'
                            }`}>
                            {preset.name}
                          </Text>
                          {selectedPreset === preset.id && (
                            <View className="h-5 w-5 items-center justify-center rounded-full bg-primary">
                              <Icon
                                as={Check}
                                size={12}
                                className="text-primary-foreground"
                                strokeWidth={3}
                              />
                            </View>
                          )}
                        </Pressable>
                      ))}
                    </View>
                  )}

                  {/* Recurring Options */}
                  {scheduleMode === 'recurring' && (
                    <View className="mt-4 space-y-5">
                      <View className="flex-row gap-3">
                        {(['daily', 'weekly', 'monthly'] as const).map((type) => (
                          <Pressable
                            key={type}
                            onPress={() => setRecurringType(type)}
                            className={`flex-1 rounded-xl border py-3.5 ${
                              recurringType === type
                                ? 'border-primary bg-primary/10'
                                : 'border-border bg-card'
                            } active:opacity-80`}>
                            <Text
                              className={`text-center font-roobert-medium text-sm ${
                                recurringType === type ? 'text-primary' : 'text-foreground'
                              }`}>
                              {type.charAt(0).toUpperCase() + type.slice(1)}
                            </Text>
                          </Pressable>
                        ))}
                      </View>

                      <View className="mt-4 flex-row items-center gap-4">
                        <TextInput
                          value={selectedHour}
                          onChangeText={setSelectedHour}
                          placeholder="09"
                          keyboardType="number-pad"
                          maxLength={2}
                          placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                          style={{
                            width: 80,
                            padding: 12,
                            borderRadius: 12,
                            borderWidth: 1.5,
                            borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
                            backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
                            fontSize: 18,
                            color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                            textAlign: 'center',
                          }}
                        />
                        <Text className="text-2xl text-foreground">:</Text>
                        <TextInput
                          value={selectedMinute}
                          onChangeText={setSelectedMinute}
                          placeholder="00"
                          keyboardType="number-pad"
                          maxLength={2}
                          placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                          style={{
                            width: 80,
                            padding: 12,
                            borderRadius: 12,
                            borderWidth: 1.5,
                            borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
                            backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
                            fontSize: 18,
                            color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                            textAlign: 'center',
                          }}
                        />
                      </View>

                      {recurringType === 'weekly' && (
                        <View className="mt-4 flex-row flex-wrap gap-2.5">
                          {WEEKDAYS.map((day) => (
                            <Pressable
                              key={day.value}
                              onPress={() => toggleWeekday(day.value)}
                              className={`rounded-lg border px-4 py-2.5 ${
                                selectedWeekdays.includes(day.value)
                                  ? 'border-primary bg-primary/10'
                                  : 'border-border bg-card'
                              } active:opacity-80`}>
                              <Text
                                className={`font-roobert-medium text-xs ${
                                  selectedWeekdays.includes(day.value)
                                    ? 'text-primary'
                                    : 'text-foreground'
                                }`}>
                                {day.label}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      )}

                      <View className="mt-4 rounded-xl bg-muted p-4">
                        <Text className="font-mono text-sm text-muted-foreground">
                          {generateRecurringCron()}
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* Advanced Cron Input */}
                  {scheduleMode === 'advanced' && (
                    <TextInput
                      value={cronExpression}
                      onChangeText={setCronExpression}
                      placeholder="0 9 * * 1-5"
                      placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                      style={{
                        padding: 12,
                        borderRadius: 12,
                        borderWidth: 1.5,
                        borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
                        backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
                        fontSize: 16,
                        color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                        fontFamily: 'monospace',
                        marginTop: 16,
                      }}
                    />
                  )}
                </View>

                {/* Agent Description */}
                <View style={{ marginBottom: 16 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                      marginBottom: 8,
                    }}>
                    {t('triggers.descriptionOptional')}
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
                      maxHeight: 150,
                    }}
                    contentContainerStyle={{
                      padding: 12,
                    }}>
                    <TextInput
                      value={description}
                      onChangeText={setDescription}
                      placeholder={t('triggers.describePlaceholder')}
                      placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                      multiline
                      scrollEnabled={false}
                      style={{
                        minHeight: 100,
                        fontSize: 16,
                        color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                        textAlignVertical: 'top',
                      }}
                    />
                  </ScrollView>
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
                    {t('triggers.instructionsRequired')}
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
                      onChangeText={setAgentPrompt}
                      placeholder={t('triggers.instructionsLabel')}
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
                </View>
              </View>
            )}

            {/* Event Trigger Steps */}
            {selectedType === 'event' && (
              <View className="space-y-4">
                {/* App Selection Step */}
                {eventStep === 'apps' && (
                  <AppSelectionStep
                    apps={triggersApps?.items || []}
                    isLoading={triggersAppsLoading}
                    searchQuery={appSearchQuery}
                    onSearchChange={setAppSearchQuery}
                    onAppSelect={(app) => {
                      const connectionStatus = getAppConnectionStatus(app.slug);
                      if (connectionStatus.isConnected) {
                        setSelectedApp(app);
                        setEventStep('triggers');
                      } else {
                        setSelectedApp(app);
                        setShowComposioConnector(true);
                      }
                    }}
                    profiles={profiles || []}
                  />
                )}

                {/* Trigger Selection Step */}
                {eventStep === 'triggers' && selectedApp && (
                  <TriggerSelectionStep
                    app={selectedApp}
                    triggers={triggersData?.items || []}
                    isLoading={loadingTriggers}
                    onTriggerSelect={(trigger) => {
                      setSelectedTrigger(trigger);
                      setEventConfig({});
                      setTriggerName(`${selectedApp.name} → Worker`);
                      setEventStep('config');
                    }}
                  />
                )}

                {/* Config Step */}
                {eventStep === 'config' && (
                  <>
                    {isEditMode && selectedApp && loadingTriggers && !selectedTrigger ? (
                      <View className="items-center justify-center py-16">
                        <Loading title={t('triggers.loadingTriggerConfig')} />
                      </View>
                    ) : isEditMode && selectedApp && triggersError && !selectedTrigger ? (
                      <View className="items-center justify-center px-8 py-16">
                        <View
                          className="mb-4 h-16 w-16 items-center justify-center rounded-2xl"
                          style={{
                            backgroundColor:
                              colorScheme === 'dark'
                                ? 'rgba(239, 68, 68, 0.1)'
                                : 'rgba(239, 68, 68, 0.05)',
                          }}>
                          <Icon as={Info} size={32} color="#ef4444" strokeWidth={2} />
                        </View>
                        <Text className="mb-2 text-center font-roobert-semibold text-lg text-foreground">
                          {t('triggers.failedToLoadTrigger')}
                        </Text>
                        <Text className="mb-6 text-center text-sm text-muted-foreground">
                          {triggersError?.message || 'An error occurred while loading trigger data'}
                        </Text>
                        <Pressable
                          onPress={() => refetchTriggers()}
                          className="rounded-xl bg-primary px-6 py-3 active:opacity-80">
                          <Text className="font-roobert-semibold text-sm text-primary-foreground">
                            {t('triggers.retry')}
                          </Text>
                        </Pressable>
                      </View>
                    ) : selectedTrigger && selectedApp ? (
                      <TriggerConfigStep
                        trigger={selectedTrigger}
                        app={selectedApp}
                        config={eventConfig}
                        onConfigChange={setEventConfig}
                        profileId={profileId}
                        onProfileChange={setProfileId}
                        profiles={profiles || []}
                        isLoadingProfiles={isLoadingProfiles}
                        onCreateProfile={() => setShowComposioConnector(true)}
                        triggerName={triggerName}
                        onTriggerNameChange={setTriggerName}
                        agentPrompt={agentPrompt}
                        onAgentPromptChange={setAgentPrompt}
                        model={model}
                        onModelChange={setModel}
                        isConfigValid={isEventConfigValid}
                      />
                    ) : null}
                  </>
                )}
              </View>
            )}

            {/* Action Buttons - Inside ScrollView at bottom */}
            {showActionButtons && (
              <View className="mt-6 border-t border-border pt-4">
                <View className="flex-row gap-3">
                  <Pressable
                    onPress={handleBack}
                    className="flex-1 items-center rounded-xl bg-muted py-4 active:opacity-70">
                    <Text className="font-roobert-semibold text-base text-muted-foreground">
                      {t('triggers.back')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={handleCreate}
                    disabled={
                      !isFormValid ||
                      (isEditMode
                        ? updateTriggerMutation.isPending
                        : selectedType === 'event'
                          ? createEventTriggerMutation.isPending
                          : createTriggerMutation.isPending)
                    }
                    className={`flex-1 items-center rounded-xl py-4 ${
                      !isFormValid ||
                      (isEditMode
                        ? updateTriggerMutation.isPending
                        : selectedType === 'event'
                          ? createEventTriggerMutation.isPending
                          : createTriggerMutation.isPending)
                        ? 'bg-muted'
                        : 'bg-primary active:opacity-80'
                    }`}>
                    <Text
                      className={`font-roobert-semibold text-base ${
                        !isFormValid ||
                        (isEditMode
                          ? updateTriggerMutation.isPending
                          : selectedType === 'event'
                            ? createEventTriggerMutation.isPending
                            : createTriggerMutation.isPending)
                          ? 'text-muted-foreground'
                          : 'text-primary-foreground'
                      }`}>
                      {isEditMode
                        ? updateTriggerMutation.isPending
                          ? t('triggers.updating')
                          : t('triggers.updateTrigger')
                        : selectedType === 'event'
                          ? createEventTriggerMutation.isPending
                            ? t('triggers.creating')
                            : t('triggers.createTrigger')
                          : createTriggerMutation.isPending
                            ? t('triggers.creating')
                            : t('triggers.createTrigger')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
          </>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
