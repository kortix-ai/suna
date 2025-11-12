import * as React from 'react';
import { Pressable, View, Switch, ScrollView } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { useAdvancedFeatures } from '@/hooks';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Layers, Sparkles, Zap, AlertCircle } from 'lucide-react-native';
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
            title="Beta Features"
            onClose={handleClose}
          />
          
          <View className="px-6 pb-8">
            <View className="mb-8 items-center pt-4">
              <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Icon as={Sparkles} size={28} className="text-primary" strokeWidth={2} />
              </View>
              <Text className="mb-1 text-2xl font-roobert-semibold text-foreground tracking-tight">
                Experimental Features
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                Get early access to new capabilities
              </Text>
            </View>

            <View className="mb-6">
              <View className="bg-card border border-border/40 rounded-2xl p-5">
                <View className="flex-row items-center justify-between mb-4">
                  <View className="flex-row items-center gap-3 flex-1">
                    <View className={`h-11 w-11 rounded-full items-center justify-center ${
                      advancedFeaturesEnabled ? 'bg-primary' : 'bg-primary/10'
                    }`}>
                      <Icon 
                        as={Layers} 
                        size={20} 
                        className={advancedFeaturesEnabled ? 'text-primary-foreground' : 'text-primary'} 
                        strokeWidth={2.5} 
                      />
                    </View>
                    <View className="flex-1">
                      <Text className="text-base font-roobert-semibold text-foreground mb-0.5">
                        Advanced Features
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
                
                <View className="pt-3 border-t border-border/40">
                  <Text className="text-sm font-roobert text-muted-foreground leading-5">
                    Access experimental features and advanced tools before they're released to everyone
                  </Text>
                </View>
              </View>
            </View>

            {advancedFeaturesEnabled && (
              <View className="mb-6">
                <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                  What's Included
                </Text>
                <View className="gap-3">
                  <FeatureCard
                    icon={Zap}
                    title="Experimental Tools"
                    description="Try out new capabilities before official release"
                  />
                  <FeatureCard
                    icon={Layers}
                    title="Advanced Settings"
                    description="Fine-tune your experience with power user options"
                  />
                </View>
              </View>
            )}

            <View className="bg-destructive/5 border border-destructive/20 rounded-2xl p-5">
              <View className="flex-row items-start gap-3 mb-3">
                <View className="h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
                  <Icon as={AlertCircle} size={18} className="text-destructive" strokeWidth={2.5} />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-roobert-semibold text-foreground mb-1">
                    Please Note
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground leading-5">
                    Beta features may be unstable and could change without notice. Use at your own discretion.
                  </Text>
                </View>
              </View>
            </View>
          </View>

          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

interface FeatureCardProps {
  icon: any;
  title: string;
  description: string;
}

function FeatureCard({ icon: IconComponent, title, description }: FeatureCardProps) {
  return (
    <View className="bg-primary/5 rounded-2xl p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 rounded-full bg-primary/10 items-center justify-center">
          <Icon as={IconComponent} size={18} className="text-primary" strokeWidth={2.5} />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-roobert-semibold text-foreground mb-0.5">
            {title}
          </Text>
          <Text className="text-xs font-roobert text-muted-foreground">
            {description}
          </Text>
        </View>
      </View>
    </View>
  );
}
