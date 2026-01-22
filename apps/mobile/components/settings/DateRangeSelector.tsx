import * as React from 'react';
import { View, Pressable, Platform, StyleSheet } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Calendar, ChevronDown, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { type DateRange } from '@/components/billing/DateRangePicker';
import { useColorScheme } from 'nativewind';
import { log } from '@/lib/logger';

let ContextMenu: React.ComponentType<any> | null = null;
if (Platform.OS !== 'web') {
  try {
    ContextMenu = require('react-native-context-menu-view').default;
  } catch (e) {
    log.warn('react-native-context-menu-view not available');
  }
}

interface DatePreset {
  label: string;
  getRange: () => DateRange;
}

interface DateRangeSelectorProps {
  dateRange: DateRange;
  datePresets: DatePreset[];
  onDateRangeChange: (range: DateRange) => void;
  selectedPresetLabel?: string;
}

export function DateRangeSelector({ dateRange, datePresets, onDateRangeChange, selectedPresetLabel }: DateRangeSelectorProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';
  const [isDateMenuOpen, setIsDateMenuOpen] = React.useState(false);
  const isDark = colorScheme === 'dark';

  const handleDatePresetSelect = React.useCallback(
    (preset: DatePreset) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const newRange = preset.getRange();
      onDateRangeChange(newRange);
      setIsDateMenuOpen(false);
    },
    [onDateRangeChange]
  );

  // Find currently active preset
  const activePreset = React.useMemo(() => {
    if (selectedPresetLabel) return selectedPresetLabel;
    
    for (const preset of datePresets) {
      const presetRange = preset.getRange();
      if (
        dateRange.from?.toDateString() === presetRange.from?.toDateString() &&
        dateRange.to?.toDateString() === presetRange.to?.toDateString()
      ) {
        return preset.label;
      }
    }
    return null;
  }, [dateRange, datePresets, selectedPresetLabel]);

  const renderContent = () => (
    <Pressable
      onPress={!ContextMenu || Platform.OS !== 'ios' ? () => setIsDateMenuOpen(!isDateMenuOpen) : undefined}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 16,
        borderRadius: isIOS ? 16 : 12,
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        borderWidth: 1,
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
        <Icon as={Calendar} size={20} className="text-foreground" strokeWidth={1.5} />
        <Text
          style={{
            fontSize: 15,
            flex: 1,
          }}
          className="text-foreground font-roobert-medium"
        >
          {activePreset || t('usage.selectPeriod', 'Select period')}
        </Text>
      </View>
      <Icon as={ChevronDown} size={18} className="text-muted-foreground" strokeWidth={2} />
    </Pressable>
  );

  return (
    <View style={{ marginBottom: 12 }}>
      {ContextMenu && Platform.OS === 'ios' ? (
        <ContextMenu
          actions={datePresets.map((preset) => ({
            title: preset.label,
            systemIcon: activePreset === preset.label ? 'checkmark' : undefined,
          }))}
          onPress={(e: any) => {
            const index = e.nativeEvent.index;
            if (index >= 0 && index < datePresets.length) {
              handleDatePresetSelect(datePresets[index]);
            }
          }}
          dropdownMenuMode={true}
        >
          {renderContent()}
        </ContextMenu>
      ) : (
        <View>
          {renderContent()}
          
          {/* Android Dropdown Menu */}
          {Platform.OS === 'android' && isDateMenuOpen && (
            <>
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => setIsDateMenuOpen(false)}
              />
              <View
                style={{
                  position: 'absolute',
                  top: 64,
                  left: 0,
                  right: 0,
                  zIndex: 1000,
                  padding: 4,
                  borderRadius: 12,
                  backgroundColor: isDark ? '#1E1E1E' : '#FFFFFF',
                  elevation: 4,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.15,
                  shadowRadius: 8,
                }}
              >
                {datePresets.map((preset, index) => (
                  <Pressable
                    key={index}
                    onPress={() => handleDatePresetSelect(preset)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 14,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      borderBottomWidth: index < datePresets.length - 1 ? StyleSheet.hairlineWidth : 0,
                      borderBottomColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 15,
                        fontWeight: activePreset === preset.label ? '600' : '400',
                      }}
                      className="text-foreground font-roobert"
                    >
                      {preset.label}
                    </Text>
                    {activePreset === preset.label && (
                      <Icon as={Check} size={18} className="text-foreground" strokeWidth={2.5} />
                    )}
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}
