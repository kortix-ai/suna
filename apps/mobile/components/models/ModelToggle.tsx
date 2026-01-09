/**
 * ModelToggle - Mode switcher between Basic and Advanced
 */

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
    selected: isDark ? '#1f1f21' : '#ffffff',
    text: isDark ? '#f8f8f8' : '#121215',
    muted: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
    border: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
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
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Basic */}
      <Pressable
        onPress={handleBasicPress}
        style={({ pressed }) => [
          styles.option,
          isBasicSelected && [
            styles.optionSelected,
            { backgroundColor: colors.selected, borderColor: colors.border },
          ],
          pressed && !isBasicSelected && { opacity: 0.7 },
        ]}
      >
        <View style={styles.content}>
          <ModeLogo mode="basic" height={14} />
          <Text style={[styles.description, { color: colors.muted }]}>
            Fast & efficient
          </Text>
        </View>
        {isBasicSelected && (
          <Check size={16} strokeWidth={2.5} color={colors.text} />
        )}
      </Pressable>

      {/* Advanced */}
      <Pressable
        onPress={handleAdvancedPress}
        style={({ pressed }) => [
          styles.option,
          isAdvancedSelected && [
            styles.optionSelected,
            { backgroundColor: colors.selected, borderColor: colors.border },
          ],
          !canAccessAdvanced && styles.optionLocked,
          pressed && !isAdvancedSelected && { opacity: 0.7 },
        ]}
      >
        <View style={styles.content}>
          <ModeLogo mode="advanced" height={14} />
          <Text style={[styles.description, { color: colors.muted }]}>
            Maximum intelligence
          </Text>
        </View>
        {isAdvancedSelected ? (
          <Check size={16} strokeWidth={2.5} color={colors.text} />
        ) : !canAccessAdvanced ? (
          <Lock size={14} strokeWidth={2} color={colors.muted} />
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 14,
    padding: 4,
    gap: 4,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 10,
    gap: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionSelected: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  optionLocked: {
    opacity: 0.5,
  },
  content: {
    flex: 1,
    gap: 4,
  },
  description: {
    fontSize: 12,
    fontFamily: 'Roobert',
  },
});

export default ModelToggle;
