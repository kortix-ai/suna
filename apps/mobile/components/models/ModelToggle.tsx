import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Lock, Check } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { ModeLogo } from './ModeLogo';
import type { Model } from '@/api/types';
import { THEME, withAlpha } from '@/lib/utils/theme';

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
  const c = isDark ? THEME.dark : THEME.light;

  const colors = {
    // Exact match for the app's low-alpha "pressed/selected" overlay token.
    selected: c.hover,
    muted: withAlpha(c.foreground, 0.45),
    border: c.border,
    accent: c.foreground,
    // Contrast color against the accent-filled radio (background inverts vs. foreground).
    onAccent: c.background,
  };

  const basicModel = React.useMemo(() => {
    return models.find(m =>
      m.id === 'kortix/claude-sonnet-4.6' ||
      m.id === 'claude-sonnet-4.6' ||
      m.id.includes('claude-sonnet')
    );
  }, [models]);

  const advancedModel = React.useMemo(() => {
    return models.find(m =>
      m.id === 'kortix/claude-opus-4.8' ||
      m.id === 'claude-opus-4.8' ||
      m.id.includes('claude-opus')
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
              <Check size={14} strokeWidth={3} color={colors.onAccent} />
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
              <Check size={14} strokeWidth={3} color={colors.onAccent} />
            ) : !canAccessAdvanced ? (
              <Lock size={14} strokeWidth={2} color={colors.muted} />
            ) : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = {
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
} as const;

export default ModelToggle;
