import * as React from 'react';
import { Pressable, View, Switch, ScrollView, Linking, Platform, StyleSheet, TouchableOpacity } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { useAdvancedFeatures } from '@/hooks';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Layers, Globe, ExternalLink, AlertCircle, Rocket, Sparkles } from 'lucide-react-native';
import { NativeHeader } from './NativeHeader';
import * as Haptics from 'expo-haptics';
import Constants from 'expo-constants';
import { log } from '@/lib/logger';

interface BetaPageProps {
  visible: boolean;
  onClose: () => void;
}

export function BetaPage({ visible, onClose }: BetaPageProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const { isEnabled: advancedFeaturesEnabled, toggle: toggleAdvancedFeatures } = useAdvancedFeatures();

  const handleClose = React.useCallback(() => {
    log.log('🎯 Beta page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleToggle = React.useCallback(async () => {
    log.log('🎯 Advanced features toggle pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await toggleAdvancedFeatures();
  }, [toggleAdvancedFeatures]);

  const handleVisitWeb = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL('https://kortix.com');
  }, []);

  if (!visible) return null;

  const backgroundColor = Platform.OS === 'ios'
    ? (colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF')
    : (colorScheme === 'dark' ? '#121212' : '#F5F5F5');

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <NativeHeader
        title={t('beta.title')}
        onBack={handleClose}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16 }}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
      >
        <View style={{ gap: 16 }}>
          <View style={{
            backgroundColor: colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF',
            borderRadius: 20,
            overflow: 'hidden',
          }}>
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, color: colorScheme === 'dark' ? '#FFFFFF' : '#000000' }}>
                  {t('beta.advancedFeatures')}
                </Text>
                <Text style={{ fontSize: 13, color: colorScheme === 'dark' ? '#8E8E93' : '#6E6E73', marginTop: 2 }}>
                  {t('beta.mobileBeta')}
                </Text>
              </View>
              <Switch
                value={advancedFeaturesEnabled}
                onValueChange={handleToggle}
                trackColor={{
                  false: colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7',
                  true: '#34C759'
                }}
                thumbColor="#FFFFFF"
                ios_backgroundColor={colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7'}
              />
            </View>
          </View>
          <View style={{
            backgroundColor: colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF',
            borderRadius: 20,
            padding: 16,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <View style={{
                height: 40,
                width: 40,
                borderRadius: 20,
                backgroundColor: colorScheme === 'dark' ? '#6366F1' : '#6366F1',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Icon as={Rocket} size={20} color="#FFFFFF" strokeWidth={2.5} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '600', color: colorScheme === 'dark' ? '#FFFFFF' : '#000000' }}>
                  App Version
                </Text>
              </View>
            </View>
            <Text style={{ fontSize: 15, color: colorScheme === 'dark' ? '#8E8E93' : '#6E6E73', lineHeight: 20 }}>
              Version: {Constants.expoConfig?.version || 'N/A'}
            </Text>
            {Constants.expoConfig?.extra?.eas?.projectId && (
              <Text style={{ fontSize: 13, color: colorScheme === 'dark' ? '#8E8E93' : '#6E6E73', marginTop: 4 }}>
                Build ID: {Constants.expoConfig.extra.eas.projectId.slice(0, 8)}
              </Text>
            )}
          </View>
          <View style={{
            backgroundColor: colorScheme === 'dark' ? 'rgba(255, 204, 0, 0.1)' : 'rgba(255, 149, 0, 0.1)',
            borderRadius: 16,
            padding: 12,
          }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Icon as={AlertCircle} size={16} color={colorScheme === 'dark' ? '#FFD60A' : '#FF9500'} strokeWidth={2} />
              <Text style={{ 
                fontSize: 13, 
                color: colorScheme === 'dark' ? '#FFD60A' : '#FF9500',
                flex: 1,
                lineHeight: 18,
              }}>
                {t('beta.mobileWarning')}
              </Text>
            </View>
          </View>
        </View>
        <View style={{ height: 80 }} />
      </ScrollView>
    </View>
  );
}
