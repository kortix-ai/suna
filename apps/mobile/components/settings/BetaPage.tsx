import * as React from 'react';
import { View, Switch, ScrollView, Linking, Platform, StyleSheet, TouchableOpacity, ViewStyle } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { useAdvancedFeatures } from '@/hooks';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AlertCircle, Rocket, Info } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Constants from 'expo-constants';
import { log } from '@/lib/logger';
import { getDrawerBackgroundColor } from '@agentpress/shared';

interface BetaPageProps {
  visible: boolean;
  onClose: () => void;
  isDrawer?: boolean;
}

export function BetaPage({ visible, onClose, isDrawer = false }: BetaPageProps) {
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

  const backgroundColor = getDrawerBackgroundColor(Platform.OS, colorScheme);
  const isIOS = Platform.OS === 'ios';
  
  const groupedBackgroundStyle = isIOS 
    ? { borderRadius: 20, overflow: 'hidden' }
    : { 
        backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF',
        borderRadius: 12,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
      };

  return (
    <View style={{ flex: 1, backgroundColor, width: '100%', overflow: 'hidden' }}>
      <ScrollView
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ padding: 16, width: '100%' }}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
      >
        {/* Advanced Features Toggle */}
        <View 
          style={groupedBackgroundStyle as ViewStyle}
          className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
        >
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: isIOS ? 11 : 14,
              minHeight: isIOS ? 44 : 56,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: isIOS ? 12 : 16, flex: 1 }}>
              <Icon 
                as={Rocket} 
                size={isIOS ? 20 : 24} 
                className="text-foreground"
                strokeWidth={2} 
              />
              <View style={{ flex: 1 }}>
                <Text 
                  style={{ 
                    fontSize: isIOS ? 17 : 16,
                    fontWeight: isIOS ? '400' : '500',
                  }}
                  className="text-foreground"
                >
                  {t('beta.advancedFeatures')}
                </Text>
                <Text 
                  style={{ 
                    fontSize: 13, 
                    marginTop: 2,
                  }}
                  className="text-muted-foreground"
                >
                  {t('beta.mobileBeta')}
                </Text>
              </View>
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

        {/* App Version Info */}
        <View 
          style={[
            groupedBackgroundStyle as ViewStyle,
            { marginTop: isIOS ? 20 : 16 }
          ]}
          className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
        >
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: isIOS ? 11 : 14,
              minHeight: isIOS ? 44 : 56,
              flexDirection: 'row',
              alignItems: 'center',
              gap: isIOS ? 12 : 16,
            }}>
            <Icon 
              as={Info} 
              size={isIOS ? 20 : 24} 
              className="text-foreground"
              strokeWidth={2} 
            />
            <View style={{ flex: 1 }}>
              <Text 
                style={{ 
                  fontSize: isIOS ? 17 : 16,
                  fontWeight: isIOS ? '400' : '500',
                }}
                className="text-foreground"
              >
                {t('beta.appVersion', 'App Version')}
              </Text>
            </View>
          </View>
          
          <View
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
              marginLeft: isIOS ? 52 : 16,
            }}
          />
          
          <View style={{ paddingHorizontal: 16, paddingBottom: isIOS ? 11 : 14, paddingTop: 8 }}>
            <Text 
              style={{ 
                fontSize: 15,
                lineHeight: 20,
              }}
              className="text-foreground"
            >
              {t('beta.version', 'Version')}: {Constants.expoConfig?.version || 'N/A'}
            </Text>
            {Constants.expoConfig?.extra?.eas?.projectId && (
              <Text 
                style={{ 
                  fontSize: 13, 
                  marginTop: 4,
                }}
                className="text-muted-foreground"
              >
                {t('beta.buildId', 'Build ID')}: {Constants.expoConfig.extra.eas.projectId.slice(0, 8)}
              </Text>
            )}
          </View>
        </View>

        {/* Warning Banner */}
        <View style={{
          backgroundColor: colorScheme === 'dark' ? 'rgba(255, 204, 0, 0.1)' : 'rgba(255, 149, 0, 0.1)',
          borderRadius: isIOS ? 20 : 12,
          padding: 16,
          marginTop: isIOS ? 20 : 16,
          ...(isIOS ? {} : {
            elevation: 1,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.05,
            shadowRadius: 2,
          }),
        }}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
            <Icon 
              as={AlertCircle} 
              size={20} 
              color={colorScheme === 'dark' ? '#FFD60A' : '#FF9500'} 
              strokeWidth={2} 
              style={{ marginTop: 2 }}
            />
            <Text 
              style={{ 
                fontSize: 15,
                lineHeight: 20,
                flex: 1,
              }}
              className="text-foreground"
            >
              {t('beta.mobileWarning')}
            </Text>
          </View>
        </View>

        <View style={{ height: 80 }} />
      </ScrollView>
    </View>
  );
}
