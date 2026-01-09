import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/text';
import { Lock, Check } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { ModeLogo } from './ModeLogo';
import type { Model } from '@/api/types';

interface ModelToggleProps {
  models: Model[];
  selectedModelId: string | undefined;
  onModelChange: (modelId: string) => void;
  canAccessModel: (model: Model) => boolean;
  onUpgradeRequired?: () => void;
}

export function ModelToggle({
  models,
  selectedModelId,
  onModelChange,
  canAccessModel,
  onUpgradeRequired,
}: ModelToggleProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const colors = {
    bg: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
    bgPressed: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    selected: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    text: isDark ? '#f8f8f8' : '#121215',
    muted: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
    border: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
    accent: isDark ? '#ffffff' : '#000000',
  };

  const basicModel = React.useMemo(() => {
    return models.find(m =>
      m.id === 'kortix/basic' ||
      m.id === 'kortix-basic' ||
      m.id.includes('claude-haiku-4-5')
    );
  }, [models]);

  const advancedModel = React.useMemo(() => {
    return models.find(m =>
      m.id === 'kortix/power' ||
      m.id === 'kortix-power' ||
      m.id.includes('claude-sonnet-4-5')
    );
  }, [models]);

  const isAdvancedSelected = advancedModel && selectedModelId === advancedModel.id;
  const isBasicSelected = !isAdvancedSelected;
  const canAccessAdvanced = advancedModel ? canAccessModel(advancedModel) : false;

  const handleBasicPress = () => {
    if (basicModel && !isBasicSelected) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onModelChange(basicModel.id);
    }
  };

  const handleAdvancedPress = () => {
    if (!advancedModel) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (canAccessAdvanced) {
      if (!isAdvancedSelected) {
        onModelChange(advancedModel.id);
      }
    } else {
      onUpgradeRequired?.();
    }
  };

  if (!basicModel && !advancedModel) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Pressable
        onPress={handleBasicPress}
        style={[
          styles.option,
          isBasicSelected && { backgroundColor: colors.selected, borderColor: colors.border },
        ]}
      >
        <View style={styles.row}>
          <View style={styles.content}>
            <ModeLogo mode="basic" height={15} />
            <Text style={[styles.subtitle, { color: colors.muted }]}>
              Fast & efficient
            </Text>
          </View>
          <View
            style={[
              styles.radio,
              {
                borderColor: isBasicSelected ? colors.accent : colors.border,
                backgroundColor: isBasicSelected ? colors.accent : 'transparent',
              },
            ]}
          >
            {isBasicSelected && (
              <Check size={14} strokeWidth={3} color={isDark ? '#000000' : '#ffffff'} />
            )}
          </View>
        </View>
      </Pressable>

      <Pressable
        onPress={handleAdvancedPress}
        style={[
          styles.option,
          isAdvancedSelected && { backgroundColor: colors.selected, borderColor: colors.border },
          !canAccessAdvanced && styles.locked,
        ]}
      >
        <View style={styles.row}>
          <View style={styles.content}>
            <ModeLogo mode="advanced" height={15} />
            <Text style={[styles.subtitle, { color: colors.muted }]}>
              Maximum intelligence
            </Text>
          </View>
          <View
            style={[
              styles.radio,
              {
                borderColor: isAdvancedSelected ? colors.accent : !canAccessAdvanced ? 'transparent' : colors.border,
                backgroundColor: isAdvancedSelected ? colors.accent : 'transparent',
              },
            ]}
          >
            {isAdvancedSelected ? (
              <Check size={14} strokeWidth={3} color={isDark ? '#000000' : '#ffffff'} />
            ) : !canAccessAdvanced ? (
              <Lock size={14} strokeWidth={2} color={colors.muted} />
            ) : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  option: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  content: {
    flex: 1,
    gap: 2,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Roobert',
  },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locked: {
    opacity: 0.5,
  },
});

export default ModelToggle;
