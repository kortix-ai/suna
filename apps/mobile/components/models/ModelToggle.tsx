/**
 * Model Toggle Component
 * 
 * A toggle switcher between Kortix Basic and Power modes
 * Matches the frontend's unified-config-menu ModeToggle design
 */

import React, { useCallback, useMemo } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Lock } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import KortixSymbol from '@/assets/brand/kortix-symbol.svg';
import type { Model } from '@/api/types';

// Color constants for light and dark modes
const COLORS = {
  light: {
    containerBg: 'rgba(18, 18, 21, 0.06)', // Muted background
    selectedBg: '#FFFFFF', // White background for selected
    foreground: '#121215', // Dark text
    mutedForeground: 'rgba(18, 18, 21, 0.6)', // Muted text
    disabledForeground: 'rgba(18, 18, 21, 0.3)', // Very muted text
    primary: '#121215', // Primary color (for Power text when selected)
  },
  dark: {
    containerBg: 'rgba(248, 248, 248, 0.08)', // Muted background
    selectedBg: '#232324', // Dark card background for selected
    foreground: '#f8f8f8', // Light text
    mutedForeground: 'rgba(248, 248, 248, 0.6)', // Muted text
    disabledForeground: 'rgba(248, 248, 248, 0.3)', // Very muted text
    primary: '#f8f8f8', // Primary color (for Power text when selected)
  },
};

interface ModelToggleProps {
  models: Model[];
  selectedModelId: string | undefined;
  onModelChange: (modelId: string) => void;
  canAccessModel: (model: Model) => boolean;
  onUpgradeRequired?: () => void;
  compact?: boolean;
}

export function ModelToggle({
  models,
  selectedModelId,
  onModelChange,
  canAccessModel,
  onUpgradeRequired,
  compact = false,
}: ModelToggleProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const colors = isDark ? COLORS.dark : COLORS.light;

  // Find Basic and Power models
  const basicModel = useMemo(() => {
    return models.find(m => 
      m.id === 'kortix/basic' || 
      m.id === 'kortix-basic' || 
      m.id.includes('claude-haiku-4-5')
    );
  }, [models]);

  const powerModel = useMemo(() => {
    return models.find(m => 
      m.id === 'kortix/power' || 
      m.id === 'kortix-power' || 
      m.id.includes('claude-sonnet-4-5')
    );
  }, [models]);

  const canAccessPower = powerModel ? canAccessModel(powerModel) : false;
  const isPowerSelected = powerModel && selectedModelId === powerModel.id;
  // If neither Basic nor Power is selected, treat Basic as selected by default
  const isBasicSelected = basicModel && (selectedModelId === basicModel.id || (!isPowerSelected && !selectedModelId));

  // Auto-select Basic if no model is selected and Basic is available
  React.useEffect(() => {
    if (!selectedModelId && basicModel) {
      onModelChange(basicModel.id);
    }
  }, [selectedModelId, basicModel, onModelChange]);

  const handleBasicPress = useCallback(() => {
    if (basicModel) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onModelChange(basicModel.id);
    }
  }, [basicModel, onModelChange]);

  const handlePowerPress = useCallback(() => {
    if (powerModel) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (canAccessPower) {
        onModelChange(powerModel.id);
      } else {
        onUpgradeRequired?.();
      }
    }
  }, [powerModel, canAccessPower, onModelChange, onUpgradeRequired]);

  // Don't render if models aren't available
  if (!basicModel && !powerModel) {
    return null;
  }

  return (
    <View 
      className="flex-row items-center p-1 rounded-xl"
      style={{ 
        gap: 6,
        backgroundColor: colors.containerBg,
      }}
    >
      {/* Basic Mode */}
      <Pressable
        onPress={handleBasicPress}
        className={`flex-1 flex-row items-center justify-center rounded-lg ${
          compact ? 'px-3 py-1.5' : 'px-4 py-2.5'
        }`}
        style={{
          backgroundColor: isBasicSelected ? colors.selectedBg : 'transparent',
          ...(isBasicSelected && {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: isDark ? 0.4 : 0.08,
            shadowRadius: 3,
            elevation: 2,
          }),
        }}
      >
        <Text
          style={{
            fontFamily: 'Roobert-Medium',
            fontSize: compact ? 12 : 14,
            color: isBasicSelected ? colors.foreground : colors.mutedForeground,
          }}
        >
          Basic
        </Text>
      </Pressable>
      
      {/* Power Mode */}
      <Pressable
        onPress={handlePowerPress}
        className={`flex-1 flex-row items-center justify-center rounded-lg ${
          compact ? 'px-3 py-1.5' : 'px-4 py-2.5'
        }`}
        style={{
          gap: 6,
          backgroundColor: isPowerSelected ? colors.selectedBg : 'transparent',
          ...(isPowerSelected && {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: isDark ? 0.4 : 0.08,
            shadowRadius: 3,
            elevation: 2,
          }),
        }}
      >
        <KortixSymbol
          width={compact ? 10 : 14}
          height={compact ? 10 : 14}
          color={isPowerSelected 
            ? colors.foreground 
            : canAccessPower 
              ? colors.mutedForeground
              : colors.disabledForeground
          }
        />
        <Text
          style={{
            fontFamily: 'Roobert-SemiBold',
            fontSize: compact ? 10 : 12,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: isPowerSelected 
              ? colors.primary 
              : canAccessPower 
                ? colors.mutedForeground
                : colors.disabledForeground,
          }}
        >
          Power
        </Text>
        {!canAccessPower && (
          <Lock 
            size={compact ? 12 : 14} 
            color={colors.disabledForeground} 
          />
        )}
      </Pressable>
    </View>
  );
}

export default ModelToggle;
