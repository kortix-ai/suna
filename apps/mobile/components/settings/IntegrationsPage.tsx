import * as React from 'react';
import { View, ScrollView, Pressable, Alert, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowLeft, Globe, ChevronRight, Zap } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { SettingsHeader } from './SettingsHeader';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { CustomMcpDialog } from './integrations/CustomMcpDialog';
import { ToolkitIcon } from './integrations/ToolkitIcon';
import { useComposioToolkitIcon } from '@/hooks/useComposio';
import { useBillingContext } from '@/contexts/BillingContext';
import { FreeTierBlock } from '@/components/billing/FreeTierBlock';
import { useRouter } from 'expo-router';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface IntegrationsPageProps {
  visible: boolean;
  onClose: () => void;
}

interface IntegrationsPageContentProps {
  onBack?: () => void;
  noPadding?: boolean;
  onFullScreenChange?: (isFullScreen: boolean) => void;
  onNavigate?: (view: string) => void;
  onUpgradePress?: () => void;
}

export const AppBubble = React.memo(() => {
  const { data: iconData, isLoading } = useComposioToolkitIcon('gmail');
  const iconUrl = iconData?.success ? iconData.icon_url : null;
  if (isLoading) {
    return (
      <View className="h-12 w-12 items-center justify-center rounded-xl bg-secondary">
        <ActivityIndicator size="small" className="text-primary" />
      </View>
    );
  }

  return (
    <View className="flex-row items-center justify-center">
      <View className="shadow-xs rounded-full border border-primary/10 bg-white p-1 dark:bg-[#454444]">
        <ToolkitIcon slug="gmail" name="Gmail" size="xs" />
      </View>
      <View className="shadow-xs -ml-2 rounded-full border border-primary/10 bg-white p-1 dark:bg-[#454444]">
        <ToolkitIcon slug="notion" name="Notion" size="xs" />
      </View>
      <View className="shadow-xs -ml-2 rounded-full border border-primary/10 bg-white p-1 dark:bg-[#454444]">
        <ToolkitIcon slug="linear" name="Linear" size="xs" />
      </View>
    </View>
  );
});

export function IntegrationsPageContent({
  onBack,
  noPadding = false,
  onFullScreenChange,
  onNavigate,
  onUpgradePress,
}: IntegrationsPageContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const [isComposioPageVisible, setIsComposioPageVisible] = React.useState(false);
  const [showCustomMcpDialog, setShowCustomMcpDialog] = React.useState(false);
  const { hasFreeTier } = useBillingContext();

  // Handle upgrade press - use provided callback or navigate to plans
  const handleUpgradePress = React.useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if (onUpgradePress) {
      onUpgradePress();
    } else {
      router.push('/plans');
    }
  }, [onUpgradePress, router]);

  const handleComposioApps = React.useCallback(() => {
    log.log('🎯 Composio Apps pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Block free tier users
    if (hasFreeTier) {
      handleUpgradePress();
      return;
    }

    if (onNavigate) {
      onNavigate('composio');
    } else {
      setIsComposioPageVisible(true);
    }
  }, [onNavigate, hasFreeTier, handleUpgradePress]);

  const handleCustomMcp = React.useCallback(() => {
    log.log('🎯 Custom MCP pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onNavigate) {
      onNavigate('customMcp');
    } else {
      setShowCustomMcpDialog(true);
    }
  }, [onNavigate]);

  React.useEffect(() => {
    const isAnyPageOpen = isComposioPageVisible || showCustomMcpDialog;
    log.log('🔄 MCP Pages state:', {
      isComposioPageVisible,
      showCustomMcpDialog,
      isAnyPageOpen,
    });
    onFullScreenChange?.(isAnyPageOpen);
  }, [isComposioPageVisible, showCustomMcpDialog, onFullScreenChange]);

  // Show full card block for free tier users (replaces content)
  if (hasFreeTier) {
    return (
      <View className="flex-1 px-6 py-8">
        {/* Header with back button */}
        <View className="mb-6 flex-row items-center">
          {onBack && (
            <Pressable onPress={onBack} className="flex-row items-center active:opacity-70">
              <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
            </Pressable>
          )}
          <View className="ml-3 flex-1">
            <Text
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="font-roobert-semibold text-xl">
              {t('integrations.title')}
            </Text>
          </View>
        </View>

        <FreeTierBlock variant="integrations" onUpgradePress={handleUpgradePress} style="card" />
      </View>
    );
  }

  return (
    <>
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}>
        <View className={noPadding ? 'pb-6' : 'pb-6'}>
          {/* Header with back button, title, and description */}
          <View className="mb-4 flex-row items-center">
            {onBack && (
              <Pressable onPress={onBack} className="flex-row items-center active:opacity-70">
                <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </Pressable>
            )}
            <View className="ml-3 flex-1">
              <Text
                style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
                className="font-roobert-semibold text-xl">
                {t('integrations.title')}
              </Text>
              <Text
                style={{
                  color:
                    colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
                }}
                className="font-roobert text-sm">
                {t('integrations.description')}
              </Text>
            </View>
          </View>

          <View className={noPadding ? '' : 'px-0'}>
            <View className="space-y-4">
              <IntegrationSection
                customIcon={<AppBubble />}
                title={t('integrations.externalApps')}
                description={t('integrations.externalAppsDescription')}
                onPress={handleComposioApps}
              />

              <IntegrationSection
                icon={Globe}
                title={t('integrations.customMcpServers')}
                description={t('integrations.customMcpDescription')}
                onPress={handleCustomMcp}
              />
            </View>
          </View>
        </View>

        <View className="h-20" />
      </ScrollView>

      <AnimatedPageWrapper
        visible={showCustomMcpDialog}
        onClose={() => setShowCustomMcpDialog(false)}>
        <CustomMcpDialog
          open={showCustomMcpDialog}
          onOpenChange={setShowCustomMcpDialog}
          onSave={(config: any) => {
            log.log('Custom MCP saved:', config);
            setShowCustomMcpDialog(false);
          }}
        />
      </AnimatedPageWrapper>
    </>
  );
}

export function IntegrationsPage({ visible, onClose }: IntegrationsPageProps) {
  const { t } = useLanguage();
  const router = useRouter();

  const handleClose = React.useCallback(() => {
    log.log('🎯 Integrations page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleUpgradePress = React.useCallback(() => {
    onClose();
    setTimeout(() => {
      router.push('/plans');
    }, 100);
  }, [onClose, router]);

  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable onPress={handleClose} className="absolute inset-0 bg-black/50" />
      <View className="absolute bottom-0 left-0 right-0 top-0 bg-background">
        <SettingsHeader title={t('integrations.title')} onClose={handleClose} />
        <IntegrationsPageContent onUpgradePress={handleUpgradePress} />
      </View>
    </View>
  );
}

interface IntegrationSectionProps {
  customIcon?: React.ReactNode;
  icon?: typeof Zap;
  title: string;
  description: string;
  onPress: () => void;
}

const IntegrationSection = React.memo(
  ({ customIcon, icon, title, description, onPress }: IntegrationSectionProps) => {
    const scale = useSharedValue(1);

    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ scale: scale.value }],
    }));

    const handlePressIn = React.useCallback(() => {
      scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
    }, [scale]);

    const handlePressOut = React.useCallback(() => {
      scale.value = withSpring(1, { damping: 15, stiffness: 400 });
    }, [scale]);

    return (
      <AnimatedPressable
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={animatedStyle}
        className="mb-4 rounded-3xl bg-primary/5 p-4">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 flex-row items-center gap-3">
            <View
              className={`${customIcon ? '' : 'h-10 w-10 rounded-xl'} items-center justify-center bg-primary/10`}>
              {icon ? (
                <Icon as={icon} size={20} className="text-primary" strokeWidth={2} />
              ) : (
                customIcon
              )}
            </View>
            <View className="flex-1">
              <Text className="font-roobert-medium text-lg text-foreground">{title}</Text>
              <Text className="font-roobert text-sm text-muted-foreground">{description}</Text>
            </View>
          </View>
          <Icon as={ChevronRight} size={16} className="text-foreground/40" strokeWidth={2} />
        </View>
      </AnimatedPressable>
    );
  }
);
