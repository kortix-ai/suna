import * as React from 'react';
import { View, ScrollView, Pressable, Alert, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  ArrowLeft,
  Plus,
  Plug2,
  Globe,
  ChevronRight,
  Zap
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { SettingsHeader } from './SettingsHeader';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';
import { CustomMcpDialog } from './integrations/CustomMcpDialog';
import { ToolkitIcon } from './integrations/ToolkitIcon';
import { useComposioToolkitIcon } from '@/hooks/useComposio';


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
}

export const AppBubble = React.memo(() => {
  const { data: iconData, isLoading } = useComposioToolkitIcon('gmail');
  const iconUrl = iconData?.success ? iconData.icon_url : null;
  if (isLoading) {
    return (
      <View className="w-12 h-12 rounded-xl bg-secondary items-center justify-center">
        <ActivityIndicator size="small" className="text-primary" />
      </View>
    );
  }

  return (
    <View className='flex-row items-center justify-center'>
      <View className='dark:bg-[#454444] bg-white shadow-xs border border-primary/10 p-1 rounded-full'>
        <ToolkitIcon slug="gmail" name="Gmail" size="xs" />
      </View>
      <View className='dark:bg-[#454444] bg-white shadow-xs border border-primary/10 p-1 rounded-full -ml-2'>
        <ToolkitIcon slug="notion" name="Notion" size="xs" />
      </View>
      <View className='dark:bg-[#454444] bg-white shadow-xs border border-primary/10 p-1 rounded-full -ml-2'>
        <ToolkitIcon slug="linear" name="Linear" size="xs" />
      </View>
    </View>
  );
});

export function IntegrationsPageContent({ onBack, noPadding = false, onFullScreenChange, onNavigate }: IntegrationsPageContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const [isComposioPageVisible, setIsComposioPageVisible] = React.useState(false);
  const [showCustomMcpDialog, setShowCustomMcpDialog] = React.useState(false);

  const handleComposioApps = React.useCallback(() => {
    console.log('🎯 Composio Apps pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onNavigate) {
      onNavigate('composio');
    } else {
      setIsComposioPageVisible(true);
    }
  }, [onNavigate]);

  const handleCustomMcp = React.useCallback(() => {
    console.log('🎯 Custom MCP pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onNavigate) {
      onNavigate('customMcp');
    } else {
      setShowCustomMcpDialog(true);
    }
  }, [onNavigate]);

  React.useEffect(() => {
    const isAnyPageOpen = isComposioPageVisible || showCustomMcpDialog;
    console.log('🔄 MCP Pages state:', { isComposioPageVisible, showCustomMcpDialog, isAnyPageOpen });
    onFullScreenChange?.(isAnyPageOpen);
  }, [isComposioPageVisible, showCustomMcpDialog, onFullScreenChange]);

  return (
    <>
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
      >
        <View className={noPadding ? "pb-6" : "pb-6"}>
          {/* Header with back button, title, and description */}
          <View className="flex-row items-center mb-4">
            {onBack && (
              <Pressable
                onPress={onBack}
                className="flex-row items-center active:opacity-70"
              >
                <ArrowLeft
                  size={20}
                  color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'}
                />
              </Pressable>
            )}
            <View className="flex-1 ml-3">
              <Text
                style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
                className="text-xl font-roobert-semibold"
              >
                {t('integrations.title')}
              </Text>
              <Text
                style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
                className="text-sm font-roobert"
              >
                {t('integrations.description')}
              </Text>
            </View>
          </View>

          <View className={noPadding ? "" : "px-0"}>

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

      <AnimatedPageWrapper visible={showCustomMcpDialog} onClose={() => setShowCustomMcpDialog(false)}>
        <CustomMcpDialog
          open={showCustomMcpDialog}
          onOpenChange={setShowCustomMcpDialog}
          onSave={(config: any) => {
            console.log('Custom MCP saved:', config);
            setShowCustomMcpDialog(false);
          }}
        />
      </AnimatedPageWrapper>
    </>
  );
}

export function IntegrationsPage({ visible, onClose }: IntegrationsPageProps) {
  const { t } = useLanguage();

  const handleClose = React.useCallback(() => {
    console.log('🎯 Integrations page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <SettingsHeader
          title={t('integrations.title')}
          onClose={handleClose}
        />
        <IntegrationsPageContent />
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

const IntegrationSection = React.memo(({
  customIcon,
  icon,
  title,
  description,
  onPress
}: IntegrationSectionProps) => {
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
      className="bg-primary/5 rounded-3xl p-4 mb-4"
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-3 flex-1">
          <View className={`${customIcon ? "" : "h-10 w-10 rounded-xl bg-primary/10"} items-center justify-center`}>
            {icon ? <Icon as={icon} size={20} className="text-primary" strokeWidth={2} /> : customIcon}
          </View>
          <View className="flex-1">
            <Text className="text-lg font-roobert-medium text-foreground">
              {title}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground">
              {description}
            </Text>
          </View>
        </View>
        <Icon
          as={ChevronRight}
          size={16}
          className="text-foreground/40"
          strokeWidth={2}
        />
      </View>
    </AnimatedPressable>
  );
});
