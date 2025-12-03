import * as React from 'react';
import { Pressable, View, Switch, ScrollView, Linking } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { useAdvancedFeatures } from '@/hooks';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Layers, Globe, ExternalLink, AlertCircle } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';

interface BetaPageProps {
  visible: boolean;
  onClose: () => void;
}

export function BetaPage({ visible, onClose }: BetaPageProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const { isEnabled: advancedFeaturesEnabled, toggle: toggleAdvancedFeatures } = useAdvancedFeatures();

  const handleClose = React.useCallback(() => {
    console.log('🎯 Beta page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleToggle = React.useCallback(async () => {
    console.log('🎯 Advanced features toggle pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await toggleAdvancedFeatures();
  }, [toggleAdvancedFeatures]);

  const handleVisitWeb = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL('https://kortix.com');
  }, []);

  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />

      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <SettingsHeader
            title={t('beta.title')}
            onClose={handleClose}
          />

          <View className="px-6 pb-8 pt-2">
            {/* Web Support - Prominent */}
            <View className="mb-6">
              <Pressable
                onPress={handleVisitWeb}
                className="bg-primary/10 border border-primary/30 rounded-3xl p-5 active:opacity-80"
              >
                <View className="flex-row items-center gap-4 mb-3">
                  <View className="h-12 w-12 rounded-2xl bg-primary/20 items-center justify-center">
                    <Icon as={Globe} size={22} className="text-primary" strokeWidth={2.5} />
                  </View>
                  <View className="flex-1">
                    <Text className="text-base font-roobert-semibold text-foreground mb-1">
                      {t('beta.webSupportTitle')}
                    </Text>
                    <Text className="text-sm font-roobert text-muted-foreground leading-5">
                      {t('beta.webSupportDescription')}
                    </Text>
                  </View>
                  <Icon as={ExternalLink} size={18} className="text-primary" strokeWidth={2.5} />
                </View>
              </Pressable>
            </View>

            {/* Mobile Beta Toggle */}
            <View className="mb-5">
              <View className={`bg-card border rounded-3xl p-5 ${
                advancedFeaturesEnabled ? 'border-border/50' : 'border-border/30'
              }`}>
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-4 flex-1">
                    <View className={`h-12 w-12 rounded-2xl items-center justify-center ${
                      advancedFeaturesEnabled 
                        ? 'bg-primary' 
                        : 'bg-muted/50 border border-border/50'
                    }`}>
                      <Icon
                        as={Layers}
                        size={22}
                        className={advancedFeaturesEnabled ? 'text-primary-foreground' : 'text-foreground/50'}
                        strokeWidth={2.5}
                      />
                    </View>
                    <View className="flex-1">
                      <Text className={`text-base font-roobert-semibold mb-1 ${
                        advancedFeaturesEnabled ? 'text-foreground' : 'text-foreground/70'
                      }`}>
                        {t('beta.advancedFeatures')}
                      </Text>
                      <Text className="text-xs font-roobert text-muted-foreground">
                        {t('beta.mobileBeta')}
                      </Text>
                    </View>
                  </View>

                  <Switch
                    value={advancedFeaturesEnabled}
                    onValueChange={handleToggle}
                    trackColor={{
                      false: colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7',
                      true: colorScheme === 'dark' ? '#34C759' : '#34C759'
                    }}
                    thumbColor="#FFFFFF"
                    ios_backgroundColor={colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7'}
                  />
                </View>
              </View>
            </View>

            {/* Warning - Subtle */}
            <View className="bg-muted/30 border border-border/30 rounded-2xl p-4">
              <View className="flex-row items-start gap-3">
                <Icon as={AlertCircle} size={16} className="text-muted-foreground mt-0.5" strokeWidth={2} />
                <Text className="text-xs font-roobert text-muted-foreground leading-5 flex-1">
                  {t('beta.mobileWarning')}
                </Text>
              </View>
            </View>
          </View>

          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}
