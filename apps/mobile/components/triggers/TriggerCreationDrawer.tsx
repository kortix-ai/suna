/**
 * Trigger Creation Drawer Component - Full-Featured & WORKING
 * 
 * Comprehensive trigger creation with all configuration options
 * Uses Modal for reliability instead of BottomSheet
 */

import React, { useState } from 'react';
import { View, Pressable, TextInput, ScrollView, Alert, Modal, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { 
  Clock, Sparkles, ChevronRight, ChevronLeft, Check, Zap, Timer, 
  Target, Calendar as CalendarIcon, Repeat, X 
} from 'lucide-react-native';
import { useAgent } from '@/contexts/AgentContext';
import { useCreateTrigger } from '@/hooks/api';

interface TriggerCreationDrawerProps {
  visible: boolean;
  onClose: () => void;
  onTriggerCreated?: (triggerId: string) => void;
}

type TriggerStep = 'type' | 'config';
type ScheduleMode = 'preset' | 'recurring' | 'advanced';
type RecurringType = 'daily' | 'weekly' | 'monthly';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// Schedule presets matching frontend
const SCHEDULE_PRESETS = [
  { id: 'every-15min', name: 'Every 15 min', cron: '*/15 * * * *', icon: Zap },
  { id: 'every-30min', name: 'Every 30 min', cron: '*/30 * * * *', icon: Timer },
  { id: 'hourly', name: 'Every hour', cron: '0 * * * *', icon: Clock },
  { id: 'daily-9am', name: 'Daily at 9 AM', cron: '0 9 * * *', icon: Target },
  { id: 'daily-12pm', name: 'Daily at 12 PM', cron: '0 12 * * *', icon: Target },
  { id: 'daily-6pm', name: 'Daily at 6 PM', cron: '0 18 * * *', icon: Target },
  { id: 'weekdays-9am', name: 'Weekdays 9 AM', cron: '0 9 * * 1-5', icon: CalendarIcon },
  { id: 'weekly-monday', name: 'Mon 9 AM', cron: '0 9 * * 1', icon: Repeat },
  { id: 'monthly-1st', name: 'Monthly 1st', cron: '0 9 1 * *', icon: CalendarIcon },
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

export function TriggerCreationDrawer({
  visible,
  onClose,
  onTriggerCreated
}: TriggerCreationDrawerProps) {
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
  const [timezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  
  // Recurring schedule state
  const [recurringType, setRecurringType] = useState<RecurringType>('daily');
  const [selectedHour, setSelectedHour] = useState('9');
  const [selectedMinute, setSelectedMinute] = useState('0');
  const [selectedWeekdays, setSelectedWeekdays] = useState<string[]>(['1', '2', '3', '4', '5']);
  const [selectedMonthDays, setSelectedMonthDays] = useState<string[]>(['1']);
  
  const createTriggerMutation = useCreateTrigger();

  // Reset form when modal closes
  React.useEffect(() => {
    if (visible) {
      console.log('✅ Trigger drawer now visible');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else {
      // Reset after animation completes
      setTimeout(() => {
        setCurrentStep('type');
        setSelectedType(null);
        setTriggerName('');
        setDescription('');
        setAgentPrompt('');
        setScheduleMode('preset');
        setSelectedPreset('');
        setCronExpression('');
        setRecurringType('daily');
        setSelectedHour('9');
        setSelectedMinute('0');
        setSelectedWeekdays(['1', '2', '3', '4', '5']);
        setSelectedMonthDays(['1']);
      }, 300);
    }
  }, [visible]);

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  const handleTypeSelect = (type: 'schedule' | 'event') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedType(type);
    setCurrentStep('config');
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (currentStep === 'config') {
      setCurrentStep('type');
    }
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
      case 'daily':
        return `${minute} ${hour} * * *`;
      case 'weekly':
        const weekdays = selectedWeekdays.join(',');
        return `${minute} ${hour} * * ${weekdays}`;
      case 'monthly':
        const monthDays = selectedMonthDays.join(',');
        return `${minute} ${hour} ${monthDays} * *`;
    }
  };

  const toggleWeekday = (day: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (selectedWeekdays.includes(day)) {
      if (selectedWeekdays.length > 1) {
        setSelectedWeekdays(selectedWeekdays.filter(d => d !== day));
      }
    } else {
      setSelectedWeekdays([...selectedWeekdays, day].sort());
    }
  };

  const toggleMonthDay = (day: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (selectedMonthDays.includes(day)) {
      if (selectedMonthDays.length > 1) {
        setSelectedMonthDays(selectedMonthDays.filter(d => d !== day));
      }
    } else {
      setSelectedMonthDays([...selectedMonthDays, day].sort((a, b) => parseInt(a) - parseInt(b)));
    }
  };

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
      if (scheduleMode === 'preset' || scheduleMode === 'recurring') {
        finalCron = scheduleMode === 'preset' ? cronExpression : generateRecurringCron();
      } else {
        finalCron = cronExpression;
      }

      if (selectedType === 'schedule' && !finalCron) {
        Alert.alert('Error', 'Please configure a schedule');
        return;
      }

      const config = selectedType === 'schedule' 
        ? { 
            cron_expression: finalCron,
            agent_prompt: agentPrompt,
            timezone: timezone 
          }
        : { 
            agent_prompt: agentPrompt || 'Process event',
            trigger_slug: 'event' 
          };

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

  const bgColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';
  const borderColor = colorScheme === 'dark' ? '#232324' : '#DCDCDC';
  const iconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const textColor = colorScheme === 'dark' ? 'text-white' : 'text-black';
  const mutedTextColor = colorScheme === 'dark' ? 'text-white/60' : 'text-black/60';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <View className="flex-1 bg-black/50">
        <Pressable 
          className="flex-1" 
          onPress={handleClose}
        />
        
        <View 
          style={{ 
            backgroundColor: bgColor,
            maxHeight: SCREEN_HEIGHT * 0.85,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <View className="px-6 pt-4 pb-3 border-b" style={{ borderColor }}>
            <View className="flex-row items-center justify-between mb-2">
              <Text className={`text-xl font-roobert-semibold ${textColor}`}>
                {currentStep === 'type' ? 'Create Trigger' : `Create ${selectedType === 'schedule' ? 'Schedule' : 'Event'} Trigger`}
              </Text>
              <Pressable onPress={handleClose} className="p-2 -mr-2">
                <Icon as={X} size={24} color={iconColor} />
              </Pressable>
            </View>
            <Text className={`text-sm font-roobert ${mutedTextColor}`}>
              {currentStep === 'type' ? 'Choose a trigger type' : 'Configure trigger settings'}
            </Text>
          </View>

          <ScrollView 
            style={{ flex: 1 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 40 }}
          >
            {currentStep === 'type' && (
              <View className="px-6 py-4">
                {/* Schedule Trigger */}
                <Pressable
                  onPress={() => handleTypeSelect('schedule')}
                  className="flex-row items-center gap-3 p-4 rounded-2xl border mb-3 active:opacity-70"
                  style={{ borderColor }}
                >
                  <View 
                    className="rounded-2xl items-center justify-center border-[1.5px]"
                    style={{ 
                      width: 48, 
                      height: 48,
                      borderColor,
                      backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF'
                    }}
                  >
                    <Icon as={Clock} size={20} color={iconColor} />
                  </View>
                  
                  <View className="flex-1">
                    <Text className={`text-base font-roobert-semibold ${textColor} mb-1`}>
                      Schedule Trigger
                    </Text>
                    <Text className={`text-sm font-roobert ${mutedTextColor}`}>
                      Run on a schedule with full control
                    </Text>
                  </View>

                  <Icon as={ChevronRight} size={20} color={iconColor} />
                </Pressable>

                {/* Event Trigger */}
                <Pressable
                  onPress={() => handleTypeSelect('event')}
                  className="flex-row items-center gap-3 p-4 rounded-2xl border active:opacity-70"
                  style={{ borderColor }}
                >
                  <View 
                    className="rounded-2xl items-center justify-center border-[1.5px]"
                    style={{ 
                      width: 48, 
                      height: 48,
                      borderColor,
                      backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF'
                    }}
                  >
                    <Icon as={Sparkles} size={20} color={iconColor} />
                  </View>
                  
                  <View className="flex-1">
                    <Text className={`text-base font-roobert-semibold ${textColor} mb-1`}>
                      Event Trigger
                    </Text>
                    <Text className={`text-sm font-roobert ${mutedTextColor}`}>
                      Trigger from external app events
                    </Text>
                  </View>

                  <Icon as={Sparkles} size={20} color={iconColor} />
                </Pressable>
              </View>
            )}

            {currentStep === 'config' && selectedType === 'schedule' && (
              <View className="px-6 py-4">
                {/* Trigger Name */}
                <View className="mb-4">
                  <Text className={`text-sm font-roobert-semibold ${textColor} mb-2`}>Trigger Name *</Text>
                  <TextInput
                    value={triggerName}
                    onChangeText={setTriggerName}
                    placeholder="e.g., Daily report generation"
                    placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                    className={`px-4 py-3 rounded-2xl border-[1.5px] ${
                      colorScheme === 'dark'
                        ? 'text-white'
                        : 'text-black'
                    }`}
                    style={{ borderColor }}
                  />
                </View>

                {/* Description */}
                <View className="mb-4">
                  <Text className={`text-sm font-roobert-semibold ${textColor} mb-2`}>Description (Optional)</Text>
                  <TextInput
                    value={description}
                    onChangeText={setDescription}
                    placeholder="Brief description"
                    placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                    multiline
                    numberOfLines={2}
                    className={`px-4 py-3 rounded-2xl border-[1.5px] ${
                      colorScheme === 'dark'
                        ? 'text-white'
                        : 'text-black'
                    }`}
                    style={{ borderColor, textAlignVertical: 'top' }}
                  />
                </View>

                {/* Schedule Mode Tabs */}
                <View className="mb-4">
                  <Text className={`text-sm font-roobert-semibold ${textColor} mb-3`}>Schedule Configuration</Text>
                  <View className="flex-row gap-2 mb-4">
                    {(['preset', 'recurring', 'advanced'] as ScheduleMode[]).map((mode) => (
                      <Pressable
                        key={mode}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setScheduleMode(mode);
                          setSelectedPreset('');
                        }}
                        className={`flex-1 py-2 rounded-xl border ${
                          scheduleMode === mode
                            ? 'bg-blue-50'
                            : ''
                        }`}
                        style={{ 
                          borderColor: scheduleMode === mode ? '#3b82f6' : borderColor 
                        }}
                      >
                        <Text className={`text-center text-sm font-roobert-medium ${
                          scheduleMode === mode ? 'text-blue-600' : textColor
                        }`}>
                          {mode.charAt(0).toUpperCase() + mode.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  {/* Preset Mode */}
                  {scheduleMode === 'preset' && (
                    <View>
                      {SCHEDULE_PRESETS.map((preset) => (
                        <Pressable
                          key={preset.id}
                          onPress={() => handlePresetSelect(preset.id)}
                          className={`p-3 rounded-xl border flex-row items-center gap-3 mb-2 ${
                            selectedPreset === preset.id ? 'bg-blue-50' : ''
                          }`}
                          style={{ 
                            borderColor: selectedPreset === preset.id ? '#3b82f6' : borderColor 
                          }}
                        >
                          <Icon as={preset.icon} size={18} color={selectedPreset === preset.id ? '#3b82f6' : iconColor} />
                          <View className="flex-1">
                            <Text className={`text-sm font-roobert-medium ${
                              selectedPreset === preset.id ? 'text-blue-600' : textColor
                            }`}>
                              {preset.name}
                            </Text>
                            <Text className={`text-xs ${mutedTextColor}`}>
                              {preset.cron}
                            </Text>
                          </View>
                          {selectedPreset === preset.id && (
                            <Icon as={Check} size={16} color="#3b82f6" />
                          )}
                        </Pressable>
                      ))}
                    </View>
                  )}

                  {/* Recurring Mode */}
                  {scheduleMode === 'recurring' && (
                    <View>
                      {/* Type Selection */}
                      <View className="flex-row gap-2 mb-4">
                        {(['daily', 'weekly', 'monthly'] as RecurringType[]).map((type) => (
                          <Pressable
                            key={type}
                            onPress={() => {
                              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                              setRecurringType(type);
                            }}
                            className={`flex-1 py-2 rounded-xl border ${
                              recurringType === type ? 'bg-blue-50' : ''
                            }`}
                            style={{ 
                              borderColor: recurringType === type ? '#3b82f6' : borderColor 
                            }}
                          >
                            <Text className={`text-center text-xs font-roobert-medium ${
                              recurringType === type ? 'text-blue-600' : textColor
                            }`}>
                              {type.charAt(0).toUpperCase() + type.slice(1)}
                            </Text>
                          </Pressable>
                        ))}
                      </View>

                      {/* Time Selection */}
                      <View className="mb-4">
                        <Text className={`text-xs font-roobert-medium ${textColor} mb-2`}>Time</Text>
                        <View className="flex-row gap-2 items-center">
                          <TextInput
                            value={selectedHour}
                            onChangeText={setSelectedHour}
                            placeholder="09"
                            keyboardType="number-pad"
                            maxLength={2}
                            className={`w-16 px-3 py-2 rounded-xl border-[1.5px] text-center ${
                              colorScheme === 'dark' ? 'text-white' : 'text-black'
                            }`}
                            style={{ borderColor }}
                          />
                          <Text className={textColor}>:</Text>
                          <TextInput
                            value={selectedMinute}
                            onChangeText={setSelectedMinute}
                            placeholder="00"
                            keyboardType="number-pad"
                            maxLength={2}
                            className={`w-16 px-3 py-2 rounded-xl border-[1.5px] text-center ${
                              colorScheme === 'dark' ? 'text-white' : 'text-black'
                            }`}
                            style={{ borderColor }}
                          />
                        </View>
                      </View>

                      {/* Weekly - Day Selection */}
                      {recurringType === 'weekly' && (
                        <View className="mb-4">
                          <Text className={`text-xs font-roobert-medium ${textColor} mb-2`}>Select Days</Text>
                          <View className="flex-row gap-2 flex-wrap">
                            {WEEKDAYS.map((day) => (
                              <Pressable
                                key={day.value}
                                onPress={() => toggleWeekday(day.value)}
                                className={`px-4 py-2 rounded-xl border ${
                                  selectedWeekdays.includes(day.value) ? 'bg-blue-50' : ''
                                }`}
                                style={{ 
                                  borderColor: selectedWeekdays.includes(day.value) ? '#3b82f6' : borderColor 
                                }}
                              >
                                <Text className={`text-xs font-roobert-medium ${
                                  selectedWeekdays.includes(day.value) ? 'text-blue-600' : textColor
                                }`}>
                                  {day.label}
                                </Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      )}

                      {/* Monthly - Day Selection */}
                      {recurringType === 'monthly' && (
                        <View className="mb-4">
                          <Text className={`text-xs font-roobert-medium ${textColor} mb-2`}>Select Days of Month</Text>
                          <View className="flex-row gap-1 flex-wrap">
                            {Array.from({ length: 31 }, (_, i) => (i + 1).toString()).map((day) => (
                              <Pressable
                                key={day}
                                onPress={() => toggleMonthDay(day)}
                                className={`w-10 h-10 rounded-xl border items-center justify-center ${
                                  selectedMonthDays.includes(day) ? 'bg-blue-50' : ''
                                }`}
                                style={{ 
                                  borderColor: selectedMonthDays.includes(day) ? '#3b82f6' : borderColor 
                                }}
                              >
                                <Text className={`text-xs font-roobert-medium ${
                                  selectedMonthDays.includes(day) ? 'text-blue-600' : textColor
                                }`}>
                                  {day}
                                </Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      )}

                      {/* Preview */}
                      <View className="p-3 rounded-xl border mb-4" style={{ borderColor, backgroundColor: colorScheme === 'dark' ? '#161618' : '#F5F5F5' }}>
                        <Text className={`text-xs font-roobert-medium ${textColor} mb-1`}>Preview</Text>
                        <Text className={`text-xs font-mono ${mutedTextColor}`}>
                          {generateRecurringCron()}
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* Advanced Mode */}
                  {scheduleMode === 'advanced' && (
                    <View>
                      <Text className={`text-xs font-roobert-medium ${textColor} mb-2`}>Custom Cron Expression</Text>
                      <TextInput
                        value={cronExpression}
                        onChangeText={setCronExpression}
                        placeholder="0 9 * * 1-5"
                        placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                        className={`px-4 py-3 rounded-2xl border-[1.5px] font-mono ${
                          colorScheme === 'dark' ? 'text-white' : 'text-black'
                        }`}
                        style={{ borderColor }}
                      />
                      <Text className={`text-xs ${mutedTextColor} mt-2`}>
                        Format: minute hour day month weekday
                      </Text>
                    </View>
                  )}
                </View>

                {/* Agent Instructions */}
                <View className="mb-4">
                  <Text className={`text-sm font-roobert-semibold ${textColor} mb-2`}>Agent Instructions *</Text>
                  <TextInput
                    value={agentPrompt}
                    onChangeText={setAgentPrompt}
                    placeholder="What should your agent do?"
                    placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                    multiline
                    numberOfLines={4}
                    className={`px-4 py-3 rounded-2xl border-[1.5px] ${
                      colorScheme === 'dark' ? 'text-white' : 'text-black'
                    }`}
                    style={{ borderColor, textAlignVertical: 'top' }}
                  />
                </View>

                {/* Action Buttons */}
                <View className="flex-row gap-3">
                  <Pressable
                    onPress={handleBack}
                    className="flex-1 py-3 rounded-2xl border-[1.5px] active:opacity-70"
                    style={{ borderColor }}
                  >
                    <View className="flex-row items-center justify-center gap-2">
                      <Icon as={ChevronLeft} size={16} color={iconColor} />
                      <Text className={`text-center text-base font-roobert-medium ${textColor}`}>
                        Back
                      </Text>
                    </View>
                  </Pressable>

                  <Pressable
                    onPress={handleCreate}
                    disabled={createTriggerMutation.isPending}
                    className="flex-1 py-3 rounded-2xl active:opacity-70"
                    style={{ backgroundColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000' }}
                  >
                    <Text className={`text-center text-base font-roobert-medium ${
                      colorScheme === 'dark' ? 'text-black' : 'text-white'
                    }`}>
                      {createTriggerMutation.isPending ? 'Creating...' : 'Create'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}

            {currentStep === 'config' && selectedType === 'event' && (
              <View className="px-6 py-4">
                {/* Trigger Name */}
                <View className="mb-4">
                  <Text className={`text-sm font-roobert-semibold ${textColor} mb-2`}>Trigger Name *</Text>
                  <TextInput
                    value={triggerName}
                    onChangeText={setTriggerName}
                    placeholder="e.g., New email processor"
                    placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                    className={`px-4 py-3 rounded-2xl border-[1.5px] ${
                      colorScheme === 'dark' ? 'text-white' : 'text-black'
                    }`}
                    style={{ borderColor }}
                  />
                </View>

                {/* Description */}
                <View className="mb-4">
                  <Text className={`text-sm font-roobert-semibold ${textColor} mb-2`}>Description (Optional)</Text>
                  <TextInput
                    value={description}
                    onChangeText={setDescription}
                    placeholder="Brief description"
                    placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                    multiline
                    numberOfLines={2}
                    className={`px-4 py-3 rounded-2xl border-[1.5px] ${
                      colorScheme === 'dark' ? 'text-white' : 'text-black'
                    }`}
                    style={{ borderColor, textAlignVertical: 'top' }}
                  />
                </View>

                {/* Agent Instructions */}
                <View className="mb-4">
                  <Text className={`text-sm font-roobert-semibold ${textColor} mb-2`}>Agent Instructions</Text>
                  <TextInput
                    value={agentPrompt}
                    onChangeText={setAgentPrompt}
                    placeholder="What should your agent do when this event occurs?"
                    placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
                    multiline
                    numberOfLines={4}
                    className={`px-4 py-3 rounded-2xl border-[1.5px] ${
                      colorScheme === 'dark' ? 'text-white' : 'text-black'
                    }`}
                    style={{ borderColor, textAlignVertical: 'top' }}
                  />
                </View>

                {/* Info Note */}
                <View className="p-3 bg-blue-50 rounded-xl border border-blue-200 mb-4">
                  <Text className="text-xs text-blue-900 font-roobert">
                    ℹ️ Event triggers connect to external apps. Full configuration available on web dashboard.
                  </Text>
                </View>

                {/* Action Buttons */}
                <View className="flex-row gap-3">
                  <Pressable
                    onPress={handleBack}
                    className="flex-1 py-3 rounded-2xl border-[1.5px] active:opacity-70"
                    style={{ borderColor }}
                  >
                    <View className="flex-row items-center justify-center gap-2">
                      <Icon as={ChevronLeft} size={16} color={iconColor} />
                      <Text className={`text-center text-base font-roobert-medium ${textColor}`}>
                        Back
                      </Text>
                    </View>
                  </Pressable>

                  <Pressable
                    onPress={handleCreate}
                    disabled={createTriggerMutation.isPending}
                    className="flex-1 py-3 rounded-2xl active:opacity-70"
                    style={{ backgroundColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000' }}
                  >
                    <Text className={`text-center text-base font-roobert-medium ${
                      colorScheme === 'dark' ? 'text-black' : 'text-white'
                    }`}>
                      {createTriggerMutation.isPending ? 'Creating...' : 'Create'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
