/**
 * Cron Expression Picker Component
 * 
 * Schedule picker component with preset options and custom input
 * Used in TriggerCreationDrawer for schedule triggers
 */

import React, { useState } from 'react';
import { View, Pressable, TextInput, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { getCronPresets, isValidCronExpression, formatCronExpression } from '@/lib/trigger-utils';
import { Clock, Check, AlertCircle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface CronExpressionPickerProps {
  value?: string;
  onChange: (cronExpression: string) => void;
  error?: string;
}

export function CronExpressionPicker({
  value = '',
  onChange,
  error,
}: CronExpressionPickerProps) {
  const { colorScheme } = useColorScheme();
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [customCron, setCustomCron] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  const presets = getCronPresets();

  const handlePresetSelect = (presetValue: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    if (presetValue === '') {
      // Custom option selected
      setShowCustomInput(true);
      setSelectedPreset('custom');
      setCustomCron(value);
    } else {
      setSelectedPreset(presetValue);
      setShowCustomInput(false);
      setCustomCron('');
      onChange(presetValue);
    }
  };

  const handleCustomCronChange = (text: string) => {
    setCustomCron(text);
    if (isValidCronExpression(text)) {
      onChange(text);
    }
  };

  const isValid = !customCron || isValidCronExpression(customCron);
  const displayValue = showCustomInput ? customCron : value;
  const humanReadable = formatCronExpression(displayValue);

  return (
    <View className="space-y-4">
      {/* Preset Options */}
      <View className="space-y-3">
        <Text className="text-foreground text-lg font-roobert-semibold">
          Schedule Options
        </Text>
        
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-row">
          {presets.map((preset) => (
            <Pressable
              key={preset.value || 'custom'}
              onPress={() => handlePresetSelect(preset.value)}
              className={`mr-3 px-4 py-3 rounded-2xl border-[1.5px] ${
                selectedPreset === preset.value || 
                (preset.value === '' && showCustomInput)
                  ? colorScheme === 'dark' 
                    ? 'border-[#232324] bg-[#161618]' 
                    : 'border-[#DCDCDC] bg-white'
                  : colorScheme === 'dark'
                    ? 'border-[#232324] bg-[#161618]'
                    : 'border-[#DCDCDC] bg-white'
              } active:opacity-70`}
              style={({ pressed }) => [
                {
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <View className="items-center min-w-20">
                <Text className={`text-sm font-roobert-medium ${
                  selectedPreset === preset.value || 
                  (preset.value === '' && showCustomInput)
                    ? colorScheme === 'dark' ? 'text-white' : 'text-black'
                    : colorScheme === 'dark' ? 'text-white opacity-50' : 'text-black opacity-50'
                }`}>
                  {preset.label}
                </Text>
                <Text className={`text-xs font-roobert mt-1 text-center max-w-24 ${
                  colorScheme === 'dark' ? 'text-white opacity-40' : 'text-black opacity-40'
                }`}>
                  {preset.description}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Custom Input */}
      {showCustomInput && (
        <View className="space-y-2">
          <Text className="text-foreground text-base font-roobert-semibold">
            Custom Cron Expression
          </Text>
          
          <View className="relative">
            <TextInput
              value={customCron}
              onChangeText={handleCustomCronChange}
              placeholder="0 9 * * 1-5"
              className={`px-4 py-4 rounded-2xl border-[1.5px] font-mono text-base ${
                error || !isValid
                  ? 'border-red-500 bg-red-50' 
                  : colorScheme === 'dark'
                    ? 'border-[#232324] bg-[#161618]'
                    : 'border-[#DCDCDC] bg-white'
              }`}
              placeholderTextColor={colorScheme === 'dark' ? '#666' : '#9ca3af'}
              autoCapitalize="none"
              autoCorrect={false}
            />
            
            {customCron && (
              <View className="absolute right-3 top-3">
                {isValid ? (
                  <Icon as={Check} size={16} color="#22c55e" />
                ) : (
                  <Icon as={AlertCircle} size={16} color="#ef4444" />
                )}
              </View>
            )}
          </View>
          
          {customCron && !isValid && (
            <Text className="text-red-500 text-xs font-roobert">
              Invalid cron expression format
            </Text>
          )}
        </View>
      )}

      {/* Preview */}
      {displayValue && (
        <View className="p-3 bg-muted/30 rounded-xl">
          <View className="flex-row items-center mb-2">
            <Icon as={Clock} size={16} color="#666" />
            <Text className="text-muted-foreground text-sm font-roobert-medium ml-2">
              Schedule Preview
            </Text>
          </View>
          
          <Text className="text-foreground text-sm font-roobert">
            {humanReadable}
          </Text>
          
          <Text className="text-muted-foreground text-xs font-mono mt-1">
            {displayValue}
          </Text>
        </View>
      )}

      {/* Error Message */}
      {error && (
        <View className="flex-row items-center p-3 bg-red-50 rounded-xl">
          <Icon as={AlertCircle} size={16} color="#ef4444" />
          <Text className="text-red-500 text-sm font-roobert ml-2">
            {error}
          </Text>
        </View>
      )}
    </View>
  );
}
