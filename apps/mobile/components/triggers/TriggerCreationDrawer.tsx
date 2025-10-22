/**
 * Trigger Creation Drawer
 * 
 * Uses @gorhom/bottom-sheet for consistent design with the rest of the app
 * Matches AgentDrawer and ThreadActionsDrawer styling
 */

import React, { useState, useEffect } from 'react';
import { View, Pressable, TextInput, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { 
  Clock, Sparkles, ChevronRight, Check, Zap, 
  Target, Calendar as CalendarIcon
} from 'lucide-react-native';
import { useAgent } from '@/contexts/AgentContext';
import { useCreateTrigger } from '@/lib/triggers';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TriggerCreationDrawerProps {
  visible: boolean;
  onClose: () => void;
  onTriggerCreated?: (triggerId: string) => void;
}

type TriggerStep = 'type' | 'config';
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

/**
 * TypeCard Component - Card for trigger type selection
 */
function TypeCard({ 
  icon: IconComponent, 
  title, 
  subtitle, 
  onPress 
}: { 
  icon: any; 
  title: string; 
  subtitle: string; 
  onPress: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const bgColor = colorScheme === 'dark' ? '#161618' : '#FFFFFF';
  const borderColor = colorScheme === 'dark' ? '#232324' : '#DCDCDC';
  const textColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const subtitleColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => { scale.value = withSpring(0.97); }}
      onPressOut={() => { scale.value = withSpring(1); }}
      style={[
        animatedStyle,
        {
          flexDirection: 'row',
          alignItems: 'center',
          padding: 16,
          borderRadius: 16,
          borderWidth: 1.5,
          borderColor,
          backgroundColor: bgColor,
          marginBottom: 12,
        }
      ]}
    >
      <View 
        style={{
          width: 48,
          height: 48,
          borderRadius: 16,
          borderWidth: 1.5,
          borderColor,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 12,
          backgroundColor: bgColor,
        }}
      >
        <Icon as={IconComponent} size={20} color={textColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: textColor }}>
          {title}
        </Text>
        <Text style={{ fontSize: 14, color: subtitleColor, opacity: 0.6, marginTop: 4 }}>
          {subtitle}
        </Text>
      </View>
      <Icon as={ChevronRight} size={20} color={textColor} />
    </AnimatedPressable>
  );
}

export function TriggerCreationDrawer({
  visible,
  onClose,
  onTriggerCreated
}: TriggerCreationDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['85%'], []);
  const { colorScheme } = useColorScheme();
  const { selectedAgentId } = useAgent();
  
  // Wizard state
  const [currentStep, setCurrentStep] = useState<TriggerStep>('type');
  const [selectedType, setSelectedType] = useState<'schedule' | 'event' | null>(null);
  
  // Form data
  const [triggerName, setTriggerName] = useState('');
  const [description, setDescription] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  
  // Schedule configuration
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('preset');
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [cronExpression, setCronExpression] = useState('');
  
  // Recurring schedule state
  const [recurringType, setRecurringType] = useState<RecurringType>('daily');
  const [selectedHour, setSelectedHour] = useState('9');
  const [selectedMinute, setSelectedMinute] = useState('0');
  const [selectedWeekdays, setSelectedWeekdays] = useState<string[]>(['1', '2', '3', '4', '5']);
  const [selectedMonthDays, setSelectedMonthDays] = useState<string[]>(['1']);
  
  const createTriggerMutation = useCreateTrigger();

  // Handle visibility changes
  useEffect(() => {
    if (visible) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      console.log('🚪 Trigger Creation Drawer Opened');
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  const handleSheetChange = React.useCallback((index: number) => {
    if (index === -1) {
      onClose();
      // Reset form when closed
      setTimeout(() => {
        setCurrentStep('type');
        setSelectedType(null);
        setTriggerName('');
        setDescription('');
        setAgentPrompt('');
        setScheduleMode('preset');
        setSelectedPreset('');
        setCronExpression('');
      }, 300);
    }
  }, [onClose]);

  const handleTypeSelect = (type: 'schedule' | 'event') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedType(type);
    setCurrentStep('config');
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentStep('type');
  };

  const handlePresetSelect = (presetId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const preset = SCHEDULE_PRESETS.find(p => p.id === presetId);
    if (preset) {
      setSelectedPreset(presetId);
      setCronExpression(preset.cron);
      if (!triggerName) {
        setTriggerName(preset.name);
      }
    }
  };

  const generateRecurringCron = () => {
    const minute = selectedMinute;
    const hour = selectedHour;
    switch (recurringType) {
      case 'daily': return `${minute} ${hour} * * *`;
      case 'weekly': return `${minute} ${hour} * * ${selectedWeekdays.join(',')}`;
      case 'monthly': return `${minute} ${hour} ${selectedMonthDays.join(',')} * *`;
    }
  };

  const toggleWeekday = (day: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (selectedWeekdays.includes(day) && selectedWeekdays.length > 1) {
      setSelectedWeekdays(selectedWeekdays.filter(d => d !== day));
    } else if (!selectedWeekdays.includes(day)) {
      setSelectedWeekdays([...selectedWeekdays, day].sort());
    }
  };

  // Design system colors
  const bgColor = colorScheme === 'dark' ? '#161618' : '#FFFFFF';
  const textColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const mutedColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const borderColor = colorScheme === 'dark' ? '#232324' : '#DCDCDC';
  const inputBg = colorScheme === 'dark' ? '#161618' : '#FFFFFF';
  const previewBg = colorScheme === 'dark' ? '#161618' : '#F5F5F5';

  const handleCreate = async () => {
    if (!selectedAgentId) {
      Alert.alert('Error', 'Please select an agent first');
      return;
    }
    if (!triggerName.trim()) {
      Alert.alert('Error', 'Please enter a trigger name');
      return;
    }
    if (selectedType === 'schedule' && !agentPrompt.trim()) {
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

      if (selectedType === 'schedule' && !finalCron) {
        Alert.alert('Error', 'Please configure a schedule');
        return;
      }

      const config = selectedType === 'schedule' 
        ? { cron_expression: finalCron, agent_prompt: agentPrompt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        : { agent_prompt: agentPrompt || 'Process event', trigger_slug: 'event' };

      const result = await createTriggerMutation.mutateAsync({
        agentId: selectedAgentId,
        data: {
          provider_id: selectedType === 'schedule' ? 'schedule' : 'event',
          name: triggerName,
          description: description,
          config,
        },
      });

      console.log('✅ Trigger created successfully:', result.trigger_id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      onTriggerCreated?.(result.trigger_id);
      onClose();
    } catch (error) {
      console.error('❌ Error creating trigger:', error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', 'Failed to create trigger. Please try again.');
    }
  };

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ 
        backgroundColor: bgColor
      }}
      handleIndicatorStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
        marginTop: 8,
        marginBottom: 0
      }}
      enableDynamicSizing={false}
      style={{
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden'
      }}
    >
      <BottomSheetScrollView 
        className="flex-1 px-6"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View className="pt-6 pb-4">
          <Text 
            style={{ 
              color: textColor, 
              fontSize: 20, 
              fontWeight: '600' 
            }}
          >
            {currentStep === 'type' ? 'Create Trigger' : `${selectedType === 'schedule' ? 'Schedule' : 'Event'} Trigger`}
          </Text>
          <Text 
            style={{ 
              color: mutedColor, 
              fontSize: 14, 
              opacity: 0.6, 
              marginTop: 4 
            }}
          >
            {currentStep === 'type' ? 'Choose a trigger type' : 'Configure your trigger'}
          </Text>
        </View>
        {/* Type Selection Step */}
        {currentStep === 'type' && (
          <View>
            <TypeCard
              icon={Clock}
              title="Schedule Trigger"
              subtitle="Run on a schedule"
              onPress={() => handleTypeSelect('schedule')}
            />
            <TypeCard
              icon={Sparkles}
              title="Event Trigger"
              subtitle="From external apps"
              onPress={() => handleTypeSelect('event')}
            />
          </View>
        )}

        {/* Schedule Configuration Step */}
        {currentStep === 'config' && selectedType === 'schedule' && (
          <View>
            {/* Name Input */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: textColor, marginBottom: 8 }}>
                Name *
              </Text>
              <TextInput
                value={triggerName}
                onChangeText={setTriggerName}
                placeholder="Daily report"
                placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                style={{ 
                  padding: 12, 
                  borderRadius: 12, 
                  borderWidth: 1.5, 
                  borderColor,
                  backgroundColor: inputBg,
                  fontSize: 16, 
                  color: textColor 
                }}
              />
            </View>

            {/* Schedule Mode Tabs */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: textColor, marginBottom: 8 }}>
                Schedule
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                {(['preset', 'recurring', 'advanced'] as const).map((mode) => (
                  <Pressable
                    key={mode}
                    onPress={() => setScheduleMode(mode)}
                    style={{
                      flex: 1,
                      padding: 10,
                      borderRadius: 12,
                      borderWidth: 1.5,
                      borderColor: scheduleMode === mode ? '#3B82F6' : borderColor,
                      backgroundColor: scheduleMode === mode ? '#3B82F610' : 'transparent',
                    }}
                  >
                    <Text 
                      style={{ 
                        textAlign: 'center', 
                        fontSize: 13, 
                        fontWeight: '500', 
                        color: scheduleMode === mode ? '#3B82F6' : textColor 
                      }}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Preset Options */}
              {scheduleMode === 'preset' && SCHEDULE_PRESETS.map((preset) => (
                <Pressable
                  key={preset.id}
                  onPress={() => handlePresetSelect(preset.id)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    padding: 12,
                    borderRadius: 12,
                    borderWidth: 1.5,
                    borderColor: selectedPreset === preset.id ? '#3B82F6' : borderColor,
                    backgroundColor: selectedPreset === preset.id ? '#3B82F610' : bgColor,
                    marginBottom: 8,
                  }}
                >
                  <Icon 
                    as={preset.icon} 
                    size={18} 
                    color={selectedPreset === preset.id ? '#3B82F6' : textColor} 
                  />
                  <Text 
                    style={{ 
                      flex: 1, 
                      marginLeft: 12, 
                      fontSize: 14, 
                      fontWeight: '500', 
                      color: selectedPreset === preset.id ? '#3B82F6' : textColor 
                    }}
                  >
                    {preset.name}
                  </Text>
                  {selectedPreset === preset.id && <Icon as={Check} size={16} color="#3B82F6" />}
                </Pressable>
              ))}

              {/* Recurring Options */}
              {scheduleMode === 'recurring' && (
                <View>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                    {(['daily', 'weekly', 'monthly'] as const).map((type) => (
                      <Pressable
                        key={type}
                        onPress={() => setRecurringType(type)}
                        style={{
                          flex: 1,
                          padding: 8,
                          borderRadius: 12,
                          borderWidth: 1.5,
                          borderColor: recurringType === type ? '#3B82F6' : borderColor,
                          backgroundColor: recurringType === type ? '#3B82F610' : 'transparent',
                        }}
                      >
                        <Text 
                          style={{ 
                            textAlign: 'center', 
                            fontSize: 12, 
                            fontWeight: '500', 
                            color: recurringType === type ? '#3B82F6' : textColor 
                          }}
                        >
                          {type.charAt(0).toUpperCase() + type.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                    <TextInput
                      value={selectedHour}
                      onChangeText={setSelectedHour}
                      placeholder="09"
                      keyboardType="number-pad"
                      maxLength={2}
                      placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                      style={{ 
                        width: 60, 
                        padding: 8, 
                        borderRadius: 8, 
                        borderWidth: 1.5, 
                        borderColor,
                        backgroundColor: inputBg,
                        textAlign: 'center', 
                        fontSize: 16, 
                        color: textColor 
                      }}
                    />
                    <Text style={{ fontSize: 20, color: textColor, alignSelf: 'center' }}>:</Text>
                    <TextInput
                      value={selectedMinute}
                      onChangeText={setSelectedMinute}
                      placeholder="00"
                      keyboardType="number-pad"
                      maxLength={2}
                      placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                      style={{ 
                        width: 60, 
                        padding: 8, 
                        borderRadius: 8, 
                        borderWidth: 1.5, 
                        borderColor,
                        backgroundColor: inputBg,
                        textAlign: 'center', 
                        fontSize: 16, 
                        color: textColor 
                      }}
                    />
                  </View>

                  {recurringType === 'weekly' && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                      {WEEKDAYS.map((day) => (
                        <Pressable
                          key={day.value}
                          onPress={() => toggleWeekday(day.value)}
                          style={{
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 8,
                            borderWidth: 1.5,
                            borderColor: selectedWeekdays.includes(day.value) ? '#3B82F6' : borderColor,
                            backgroundColor: selectedWeekdays.includes(day.value) ? '#3B82F610' : 'transparent',
                          }}
                        >
                          <Text 
                            style={{ 
                              fontSize: 12, 
                              fontWeight: '500', 
                              color: selectedWeekdays.includes(day.value) ? '#3B82F6' : textColor 
                            }}
                          >
                            {day.label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  )}

                  <View 
                    style={{ 
                      padding: 12, 
                      borderRadius: 12, 
                      backgroundColor: previewBg, 
                      marginBottom: 12 
                    }}
                  >
                    <Text 
                      style={{ 
                        fontSize: 12, 
                        fontFamily: 'monospace', 
                        color: textColor,
                        opacity: 0.6 
                      }}
                    >
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
                    borderColor,
                    backgroundColor: inputBg,
                    fontFamily: 'monospace', 
                    fontSize: 14, 
                    color: textColor 
                  }}
                />
              )}
            </View>

            {/* Agent Instructions */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: textColor, marginBottom: 8 }}>
                Instructions *
              </Text>
              <TextInput
                value={agentPrompt}
                onChangeText={setAgentPrompt}
                placeholder="What should your agent do?"
                placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                multiline
                numberOfLines={3}
                style={{ 
                  padding: 12, 
                  borderRadius: 12, 
                  borderWidth: 1.5, 
                  borderColor,
                  backgroundColor: inputBg,
                  fontSize: 14, 
                  color: textColor, 
                  textAlignVertical: 'top' 
                }}
              />
            </View>

            {/* Action Buttons */}
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <Pressable
                onPress={handleBack}
                style={({ pressed }) => [{
                  flex: 1,
                  padding: 16,
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor,
                  backgroundColor: bgColor,
                  alignItems: 'center',
                  opacity: pressed ? 0.7 : 1,
                }]}
              >
                <Text style={{ fontSize: 16, fontWeight: '600', color: textColor }}>
                  Back
                </Text>
              </Pressable>
              <Pressable
                onPress={handleCreate}
                disabled={createTriggerMutation.isPending}
                style={({ pressed }) => [{
                  flex: 1,
                  padding: 16,
                  borderRadius: 12,
                  backgroundColor: textColor,
                  alignItems: 'center',
                  opacity: pressed || createTriggerMutation.isPending ? 0.7 : 1,
                }]}
              >
                <Text style={{ fontSize: 16, fontWeight: '600', color: bgColor }}>
                  {createTriggerMutation.isPending ? 'Creating...' : 'Create'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Event Trigger Configuration Step */}
        {currentStep === 'config' && selectedType === 'event' && (
          <View>
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: textColor, marginBottom: 8 }}>
                Name *
              </Text>
              <TextInput
                value={triggerName}
                onChangeText={setTriggerName}
                placeholder="Event processor"
                placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                style={{ 
                  padding: 12, 
                  borderRadius: 12, 
                  borderWidth: 1.5, 
                  borderColor,
                  backgroundColor: inputBg,
                  fontSize: 16, 
                  color: textColor 
                }}
              />
            </View>

            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <Pressable 
                onPress={handleBack} 
                style={({ pressed }) => [{ 
                  flex: 1, 
                  padding: 16, 
                  borderRadius: 12, 
                  borderWidth: 1.5, 
                  borderColor,
                  backgroundColor: bgColor,
                  alignItems: 'center', 
                  opacity: pressed ? 0.7 : 1 
                }]}
              >
                <Text style={{ fontSize: 16, fontWeight: '600', color: textColor }}>
                  Back
                </Text>
              </Pressable>
              <Pressable 
                onPress={handleCreate} 
                disabled={createTriggerMutation.isPending}
                style={({ pressed }) => [{ 
                  flex: 1, 
                  padding: 16, 
                  borderRadius: 12, 
                  backgroundColor: textColor, 
                  alignItems: 'center', 
                  opacity: pressed || createTriggerMutation.isPending ? 0.7 : 1 
                }]}
              >
                <Text style={{ fontSize: 16, fontWeight: '600', color: bgColor }}>
                  {createTriggerMutation.isPending ? 'Creating...' : 'Create'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}
