import * as React from 'react';
import { View, TouchableOpacity, Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronLeft } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { isLiquidGlassAvailable, GlassView } from 'expo-glass-effect';

interface NativeHeaderProps {
  title: string;
  onBack: () => void;
  onSave?: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
  backLabel?: string;
  loading?: boolean;
}

export function NativeHeader({
  title,
  onBack,
  onSave,
  saveLabel = 'Save',
  saveDisabled = false,
  backLabel,
  loading = false,
}: NativeHeaderProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onBack();
  };

  const handleSave = () => {
    if (onSave && !saveDisabled && !loading) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onSave();
    }
  };

  const backgroundColor = Platform.OS === 'ios'
            ? (colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF')
            : (colorScheme === 'dark' ? '#121212' : '#F5F5F5')

  return (
    <View
      style={{
        paddingTop: 10,
        backgroundColor,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          height: isIOS ? 44 : 56,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: isIOS ? 16 : 4,
        }}>
        <TouchableOpacity
          onPress={handleBack}
          activeOpacity={0.6}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
          }}>
          {isLiquidGlassAvailable() ? (
            <GlassView
              glassEffectStyle="regular"
              tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                height: 44,
                width: 44,
                paddingHorizontal: backLabel ? 12 : 8,
                borderRadius: 22,
              }}>
              <Icon
                as={ChevronLeft}
                size={isIOS ? 22 : 22}
                className="text-foreground"
              />
              {backLabel && isIOS && (
                <Text
                  className="text-foreground"
                  style={{
                    fontSize: 17,
                    marginLeft: -2,
                  }}>
                  {backLabel}
                </Text>
              )}
            </GlassView>
          ) : (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                height: 36,
                paddingHorizontal: backLabel ? 12 : 8,
                borderRadius: 18,
                backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#E8E8ED',
              }}>
              <Icon
                as={ChevronLeft}
                size={isIOS ? 24 : 22}
                className="text-foreground"
                strokeWidth={2.5}
              />
              {backLabel && isIOS && (
                <Text
                  className="text-foreground"
                  style={{
                    fontSize: 17,
                    marginLeft: -2,
                  }}>
                  {backLabel}
                </Text>
              )}
            </View>
          )}
        </TouchableOpacity>
        <View style={{ position: 'absolute', left: 0, right: 0, alignItems: 'center', pointerEvents: 'none' }}>
          <Text
            numberOfLines={1}
            className="font-roobert-medium text-foreground"
            style={{
              fontSize: isIOS ? 17 : 20,
              color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}>
            {title}
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleSave}
          activeOpacity={onSave ? 0.6 : 1}
          disabled={!onSave || saveDisabled || loading}>
          {onSave && (
            <>
              {isLiquidGlassAvailable() ? (
                <GlassView
                  glassEffectStyle="regular"
                  tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                  style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: 44,
                    paddingHorizontal: 16,
                    borderRadius: 22,
                    opacity: saveDisabled || loading ? 0.4 : 1,
                  }}>
                  <Text
                    className="font-roobert-bold text-foreground">
                    {loading ? '...' : saveLabel}
                  </Text>
                </GlassView>
              ) : (
                <View
                  style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: 36,
                    paddingHorizontal: 16,
                    borderRadius: 18,
                    backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#E8E8ED',
                    opacity: saveDisabled || loading ? 0.4 : 1,
                  }}>
                  <Text
                    className="text-foreground"
                    style={{
                      fontSize: 17,
                      fontWeight: isIOS ? '600' : '500',
                    }}>
                    {loading ? '...' : saveLabel}
                  </Text>
                </View>
              )}
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}
