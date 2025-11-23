import * as React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowLeft, Search, CheckCircle2 } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { useComposioApps, type ComposioApp } from '@/hooks/useComposio';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';
import { ToolkitIcon } from './ToolkitIcon';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ComposioAppsContentProps {
  onBack?: () => void;
  onAppSelect?: (app: ComposioApp) => void;
  noPadding?: boolean;
}

export function ComposioAppsContent({ onBack, onAppSelect, noPadding = false }: ComposioAppsContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { data: appsData, isLoading, error, refetch } = useComposioApps();
  const [searchQuery, setSearchQuery] = React.useState('');

  const apps = appsData?.toolkits || [];

  const filteredApps = React.useMemo(() => {
    if (!searchQuery.trim()) return apps;

    const query = searchQuery.toLowerCase();
    return apps.filter((app: ComposioApp) =>
      app.name.toLowerCase().includes(query) ||
      app.description?.toLowerCase().includes(query) ||
      app.categories?.some(cat => cat.toLowerCase().includes(query))
    );
  }, [apps, searchQuery]);

  const handleAppPress = React.useCallback((app: ComposioApp) => {
    console.log('🎯 App selected:', app.name);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (onAppSelect) {
      onAppSelect(app);
    }
  }, [onAppSelect]);

  return (
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
            {t('integrations.composioApps')}
          </Text>
          <Text
            style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
            className="text-sm font-roobert"
          >
            {t('integrations.composioAppsDescription')}
          </Text>
        </View>
      </View>

      {isLoading ? (
        <View className="items-center py-8">
          <ActivityIndicator size="large" className="text-primary" />
          <Text className="text-sm font-roobert text-muted-foreground mt-2">
            {t('integrations.loadingIntegrations')}
          </Text>
        </View>
      ) : error ? (
        <View className="items-center py-8">
          <Text className="text-lg font-roobert-medium text-foreground mb-2">
            {t('integrations.failedToLoad')}
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground mb-4">
            {error.message}
          </Text>
          <Pressable
            onPress={() => refetch()}
            className="px-6 py-3 bg-primary rounded-2xl"
          >
            <Text className="text-white font-roobert-medium">
              {t('integrations.retry')}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View className="space-y-4">
          {filteredApps.map((app: ComposioApp) => (
            <AppCard
              key={app.slug}
              app={app}
              onPress={() => handleAppPress(app)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

interface AppCardProps {
  app: ComposioApp;
  onPress: () => void;
}

const AppCard = React.memo(({ app, onPress }: AppCardProps) => {
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
      className="flex-row gap-4 items-center p-4 bg-primary/5 mb-4 rounded-3xl"
    >
      <ToolkitIcon slug={app.slug} name={app.name} size="sm" />
      <View className="flex-1">
        <Text className="text-base font-roobert-semibold text-foreground">
          {app.name}
        </Text>
        <Text
          className="text-sm text-muted-foreground"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {app.description}
        </Text>
      </View>

      {app.connected && (
        <View className="w-6 h-6 bg-green-500 rounded-full items-center justify-center">
          <Icon as={CheckCircle2} size={16} className="text-white" />
        </View>
      )}
    </AnimatedPressable>
  );
});
