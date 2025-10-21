/**
 * Trigger Creation Drawer - SIMPLE & VISIBLE
 * 
 * Uses simple Animated View - guaranteed to be visible
 */

import React, { useState, useEffect } from 'react';
import { 
  View, Pressable, TextInput, Alert, ScrollView, 
  Animated, Dimensions, KeyboardAvoidingView, Platform,
  TouchableWithoutFeedback
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { 
  Clock, Sparkles, ChevronRight, ChevronLeft, Check, Zap, Timer, 
  Target, Calendar as CalendarIcon, Repeat, X
} from 'lucide-react-native';
import { useAgent } from '@/contexts/AgentContext';
import { useCreateTrigger } from '@/lib/triggers';

interface TriggerCreationDrawerProps {
  visible: boolean;
  onClose: () => void;
  onTriggerCreated?: (triggerId: string) => void;
}

type TriggerStep = 'type' | 'config';
type ScheduleMode = 'preset' | 'recurring' | 'advanced';
type RecurringType = 'daily' | 'weekly' | 'monthly';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

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

export function TriggerCreationDrawer({
  visible,
  onClose,
  onTriggerCreated
}: TriggerCreationDrawerProps) {
  const { colorScheme } = useColorScheme();
  const { selectedAgentId } = useAgent();
  const slideAnim = React.useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  
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

  // Animate in/out
  useEffect(() => {
    console.log('🎬 Drawer visible changed to:', visible);
    if (visible) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 65,
        friction: 11
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: SCREEN_HEIGHT,
        duration: 250,
        useNativeDriver: true,
      }).start(() => {
        // Reset form
        setCurrentStep('type');
        setSelectedType(null);
        setTriggerName('');
        setDescription('');
        setAgentPrompt('');
        setScheduleMode('preset');
        setSelectedPreset('');
        setCronExpression('');
      });
    }
  }, [visible]);

  if (!visible) return null;

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

  const bgColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';
  const textColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const mutedColor = colorScheme === 'dark' ? '#666666' : '#9CA3AF';
  const borderColor = colorScheme === 'dark' ? '#232324' : '#DCDCDC';

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 }}>
      {/* Backdrop */}
      <TouchableWithoutFeedback onPress={handleClose}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} />
      </TouchableWithoutFeedback>

      {/* Drawer */}
      <Animated.View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: SCREEN_HEIGHT * 0.85,
          backgroundColor: bgColor,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          transform: [{ translateY: slideAnim }],
        }}
      >
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: borderColor }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 20, fontWeight: '600', color: textColor }}>
                {currentStep === 'type' ? 'Create Trigger' : `${selectedType === 'schedule' ? 'Schedule' : 'Event'} Trigger`}
              </Text>
              <Text style={{ fontSize: 14, color: mutedColor, marginTop: 4 }}>
                {currentStep === 'type' ? 'Choose a trigger type' : 'Configure your trigger'}
              </Text>
            </View>
            <Pressable onPress={handleClose} style={{ padding: 8 }}>
              <Icon as={X} size={24} color={textColor} />
            </Pressable>
          </View>

          <ScrollView 
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 24, paddingBottom: 120 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {currentStep === 'type' && (
              <View>
                {/* Schedule Trigger */}
                <Pressable
                  onPress={() => handleTypeSelect('schedule')}
                  style={({ pressed }) => [{
                    flexDirection: 'row',
                    alignItems: 'center',
                    padding: 16,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: borderColor,
                    marginBottom: 12,
                    opacity: pressed ? 0.7 : 1,
                  }]}
                >
                  <View style={{ width: 48, height: 48, borderRadius: 16, borderWidth: 1.5, borderColor: borderColor, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                    <Icon as={Clock} size={20} color={textColor} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: textColor }}>Schedule Trigger</Text>
                    <Text style={{ fontSize: 14, color: mutedColor, marginTop: 4 }}>Run on a schedule</Text>
                  </View>
                  <Icon as={ChevronRight} size={20} color={textColor} />
                </Pressable>

                {/* Event Trigger */}
                <Pressable
                  onPress={() => handleTypeSelect('event')}
                  style={({ pressed }) => [{
                    flexDirection: 'row',
                    alignItems: 'center',
                    padding: 16,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: borderColor,
                    opacity: pressed ? 0.7 : 1,
                  }]}
                >
                  <View style={{ width: 48, height: 48, borderRadius: 16, borderWidth: 1.5, borderColor: borderColor, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                    <Icon as={Sparkles} size={20} color={textColor} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: textColor }}>Event Trigger</Text>
                    <Text style={{ fontSize: 14, color: mutedColor, marginTop: 4 }}>From external apps</Text>
                  </View>
                  <Icon as={ChevronRight} size={20} color={textColor} />
                </Pressable>
              </View>
            )}

            {currentStep === 'config' && selectedType === 'schedule' && (
              <View>
                {/* Name */}
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: textColor, marginBottom: 8 }}>Name *</Text>
                  <TextInput
                    value={triggerName}
                    onChangeText={setTriggerName}
                    placeholder="Daily report"
                    placeholderTextColor={mutedColor}
                    style={{ padding: 12, borderRadius: 12, borderWidth: 1.5, borderColor: borderColor, fontSize: 16, color: textColor }}
                  />
                </View>

                {/* Mode Tabs */}
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: textColor, marginBottom: 8 }}>Schedule</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                    {['preset', 'recurring', 'advanced'].map((mode) => (
                      <Pressable
                        key={mode}
                        onPress={() => setScheduleMode(mode as ScheduleMode)}
                        style={{
                          flex: 1,
                          padding: 10,
                          borderRadius: 12,
                          borderWidth: 1.5,
                          borderColor: scheduleMode === mode ? '#3B82F6' : borderColor,
                          backgroundColor: scheduleMode === mode ? '#3B82F610' : 'transparent',
                        }}
                      >
                        <Text style={{ textAlign: 'center', fontSize: 13, fontWeight: '500', color: scheduleMode === mode ? '#3B82F6' : textColor }}>
                          {mode.charAt(0).toUpperCase() + mode.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  {/* Presets */}
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
                        backgroundColor: selectedPreset === preset.id ? '#3B82F610' : 'transparent',
                        marginBottom: 8,
                      }}
                    >
                      <Icon as={preset.icon} size={18} color={selectedPreset === preset.id ? '#3B82F6' : textColor} />
                      <Text style={{ flex: 1, marginLeft: 12, fontSize: 14, fontWeight: '500', color: selectedPreset === preset.id ? '#3B82F6' : textColor }}>
                        {preset.name}
                      </Text>
                      {selectedPreset === preset.id && <Icon as={Check} size={16} color="#3B82F6" />}
                    </Pressable>
                  ))}

                  {/* Recurring */}
                  {scheduleMode === 'recurring' && (
                    <View>
                      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                        {['daily', 'weekly', 'monthly'].map((type) => (
                          <Pressable
                            key={type}
                            onPress={() => setRecurringType(type as RecurringType)}
                            style={{
                              flex: 1,
                              padding: 8,
                              borderRadius: 12,
                              borderWidth: 1.5,
                              borderColor: recurringType === type ? '#3B82F6' : borderColor,
                              backgroundColor: recurringType === type ? '#3B82F610' : 'transparent',
                            }}
                          >
                            <Text style={{ textAlign: 'center', fontSize: 12, fontWeight: '500', color: recurringType === type ? '#3B82F6' : textColor }}>
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
                          style={{ width: 60, padding: 8, borderRadius: 8, borderWidth: 1.5, borderColor: borderColor, textAlign: 'center', fontSize: 16, color: textColor }}
                        />
                        <Text style={{ fontSize: 20, color: textColor, alignSelf: 'center' }}>:</Text>
                        <TextInput
                          value={selectedMinute}
                          onChangeText={setSelectedMinute}
                          placeholder="00"
                          keyboardType="number-pad"
                          maxLength={2}
                          style={{ width: 60, padding: 8, borderRadius: 8, borderWidth: 1.5, borderColor: borderColor, textAlign: 'center', fontSize: 16, color: textColor }}
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
                              <Text style={{ fontSize: 12, fontWeight: '500', color: selectedWeekdays.includes(day.value) ? '#3B82F6' : textColor }}>
                                {day.label}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      )}

                      <View style={{ padding: 12, borderRadius: 12, backgroundColor: colorScheme === 'dark' ? '#1a1a1a' : '#f5f5f5', marginBottom: 12 }}>
                        <Text style={{ fontSize: 12, fontFamily: 'monospace', color: mutedColor }}>
                          {generateRecurringCron()}
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* Advanced */}
                  {scheduleMode === 'advanced' && (
                    <TextInput
                      value={cronExpression}
                      onChangeText={setCronExpression}
                      placeholder="0 9 * * 1-5"
                      placeholderTextColor={mutedColor}
                      style={{ padding: 12, borderRadius: 12, borderWidth: 1.5, borderColor: borderColor, fontFamily: 'monospace', fontSize: 14, color: textColor }}
                    />
                  )}
                </View>

                {/* Instructions */}
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: textColor, marginBottom: 8 }}>Instructions *</Text>
                  <TextInput
                    value={agentPrompt}
                    onChangeText={setAgentPrompt}
                    placeholder="What should your agent do?"
                    placeholderTextColor={mutedColor}
                    multiline
                    numberOfLines={3}
                    style={{ padding: 12, borderRadius: 12, borderWidth: 1.5, borderColor: borderColor, fontSize: 14, color: textColor, textAlignVertical: 'top' }}
                  />
                </View>

                {/* Buttons */}
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                  <Pressable
                    onPress={handleBack}
                    style={({ pressed }) => [{
                      flex: 1,
                      padding: 16,
                      borderRadius: 12,
                      borderWidth: 1.5,
                      borderColor: borderColor,
                      alignItems: 'center',
                      opacity: pressed ? 0.7 : 1,
                    }]}
                  >
                    <Text style={{ fontSize: 16, fontWeight: '600', color: textColor }}>Back</Text>
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

            {currentStep === 'config' && selectedType === 'event' && (
              <View>
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: textColor, marginBottom: 8 }}>Name *</Text>
                  <TextInput
                    value={triggerName}
                    onChangeText={setTriggerName}
                    placeholder="Event processor"
                    placeholderTextColor={mutedColor}
                    style={{ padding: 12, borderRadius: 12, borderWidth: 1.5, borderColor: borderColor, fontSize: 16, color: textColor }}
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
                      borderColor: borderColor, 
                      alignItems: 'center', 
                      opacity: pressed ? 0.7 : 1 
                    }]}
                  >
                    <Text style={{ fontSize: 16, fontWeight: '600', color: textColor }}>Back</Text>
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
          </ScrollView>
        </KeyboardAvoidingView>
      </Animated.View>
    </View>
  );
}
