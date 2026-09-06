/**
 * Cron Expression Picker Component
 * 
 * Schedule picker component with preset options and custom input
 * Updated to match app design system colors
 */

import React, { useState } from 'react';
import { View, Pressable, TextInput, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { getCronPresets, isValidCronExpression, formatCronExpression } from '@/lib/utils/trigger-utils';
import { Clock, Check, AlertCircle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { THEME, withAlpha } from '@/lib/utils/theme';

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
  
  // Design system colors
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const borderColor = isDark ? THEME.dark.border : THEME.light.border;
  const bgColor = isDark ? THEME.dark.popover : THEME.light.popover;
  const previewBg = isDark ? THEME.dark.muted : THEME.light.muted;
  const mutedTextColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;

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
    <View style={{ gap: 16 }}>
      {/* Preset Options */}
      <View style={{ gap: 12 }}>
        <Text style={{ color: textColor, fontSize: 18, fontWeight: '600' }}>
          Schedule Options
        </Text>
        
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {presets.map((preset) => {
              const isSelected = selectedPreset === preset.value || (preset.value === '' && showCustomInput);
              return (
                <Pressable
                  key={preset.value || 'custom'}
                  onPress={() => handlePresetSelect(preset.value)}
                  style={({ pressed }) => [
                    {
                      marginRight: 0,
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      borderRadius: 16,
                      borderWidth: 1.5,
                      borderColor,
                      backgroundColor: bgColor,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <View style={{ alignItems: 'center', minWidth: 80 }}>
                    <Text 
                      style={{ 
                        fontSize: 14, 
                        fontWeight: '500', 
                        color: isSelected ? textColor : textColor,
                        opacity: isSelected ? 1 : 0.5
                      }}
                    >
                      {preset.label}
                    </Text>
                    <Text 
                      style={{ 
                        fontSize: 12, 
                        marginTop: 4, 
                        textAlign: 'center', 
                        maxWidth: 96,
                        color: textColor,
                        opacity: 0.4
                      }}
                    >
                      {preset.description}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>

      {/* Custom Input */}
      {showCustomInput && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: textColor, fontSize: 16, fontWeight: '600' }}>
            Custom Cron Expression
          </Text>
          
          <View style={{ position: 'relative' }}>
            <TextInput
              value={customCron}
              onChangeText={handleCustomCronChange}
              placeholder="0 9 * * 1-5"
              placeholderTextColor={mutedTextColor}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 16,
                borderRadius: 16,
                borderWidth: 1.5,
                borderColor: error || !isValid ? destructiveColor : borderColor,
                backgroundColor: error || !isValid ? withAlpha(destructiveColor, 0.1) : bgColor,
                fontFamily: 'monospace',
                fontSize: 16,
                color: textColor,
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />

            {customCron && (
              <View style={{ position: 'absolute', right: 12, top: 12 }}>
                {isValid ? (
                  <Icon as={Check} size={16} color={THEME.accent.green} />
                ) : (
                  <Icon as={AlertCircle} size={16} color={destructiveColor} />
                )}
              </View>
            )}
          </View>

          {customCron && !isValid && (
            <Text style={{ color: destructiveColor, fontSize: 12, fontWeight: '400' }}>
              Invalid cron expression format
            </Text>
          )}
        </View>
      )}

      {/* Preview */}
      {displayValue && (
        <View style={{ padding: 12, backgroundColor: previewBg, borderRadius: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Icon as={Clock} size={16} color={mutedTextColor} />
            <Text style={{ color: mutedTextColor, fontSize: 14, fontWeight: '500', marginLeft: 8 }}>
              Schedule Preview
            </Text>
          </View>
          
          <Text style={{ color: textColor, fontSize: 14, fontWeight: '400' }}>
            {humanReadable}
          </Text>
          
          <Text style={{ color: mutedTextColor, fontSize: 12, fontFamily: 'monospace', marginTop: 4 }}>
            {displayValue}
          </Text>
        </View>
      )}

      {/* Error Message */}
      {error && (
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: withAlpha(destructiveColor, 0.1), borderRadius: 12 }}>
          <Icon as={AlertCircle} size={16} color={destructiveColor} />
          <Text style={{ color: destructiveColor, fontSize: 14, fontWeight: '400', marginLeft: 8 }}>
            {error}
          </Text>
        </View>
      )}
    </View>
  );
}
