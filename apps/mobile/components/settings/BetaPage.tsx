import * as React from 'react';
import { Pressable, View, Switch } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { useAdvancedFeatures } from '@/hooks';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Layers } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';

interface BetaPageProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * BetaPage Component
 * 
 * Beta features settings page for enabling experimental features.
 * 
 * Features:
 * - Advanced Features toggle
 * - Description of what beta features include
 * - Clean, minimal design matching other pages
 */
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
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await toggleAdvancedFeatures();
  }, [toggleAdvancedFeatures]);
  
  if (!visible) return null;
  
  return (
    <View className="absolute inset-0 z-50">
      {/* Backdrop */}
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      {/* Page */}
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <View className="flex-1">
          {/* Header */}
          <SettingsHeader
            title={t('settings.beta') || 'Beta'}
            onClose={handleClose}
          />
          
          {/* Beta Features Toggle */}
          <View className="px-6 mb-6">
            <View className="rounded-2xl bg-secondary border-2 border-transparent">
              <View className="px-4 py-4 flex-row items-center justify-between">
                <View className="flex-row items-center gap-3 flex-1">
                  <View className={`w-10 h-10 rounded-full items-center justify-center ${
                    advancedFeaturesEnabled ? 'bg-primary/10' : 'bg-secondary'
                  }`}>
                    <Icon 
                      as={Layers} 
                      size={20} 
                      className={advancedFeaturesEnabled ? 'text-primary' : 'text-foreground/40'} 
                      strokeWidth={2} 
                    />
                  </View>
                  <View className="flex-1">
                    <Text className="text-base font-roobert-medium text-foreground">
                      {t('settings.advancedFeatures') || 'Advanced Features'}
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
                  thumbColor={colorScheme === 'dark' ? '#FFFFFF' : '#FFFFFF'}
                  ios_backgroundColor={colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7'}
                />
              </View>
              
              {/* Description */}
              <View className="px-4 pb-4 pt-0">
                <Text className="text-sm font-roobert text-muted-foreground leading-5">
                  {t('settings.betaDescription') || 'Experimental features and advanced tools'}
                </Text>
              </View>
            </View>
          </View>
          
          {/* Info Box */}
          <View className="px-6 mt-4 mb-6">
            <View className="p-4 bg-secondary/50 rounded-2xl">
              <Text className="text-sm font-roobert text-muted-foreground leading-5">
                {t('settings.betaWarning') || 'Beta features may be unstable and could change without notice. Use at your own discretion.'}
              </Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

