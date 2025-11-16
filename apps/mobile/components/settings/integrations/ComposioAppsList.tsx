import * as React from 'react';
import { View, ScrollView, Pressable, Image, ActivityIndicator, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  ArrowLeft, 
  Search, 
  Plug2, 
  CheckCircle2,
  AlertCircle 
} from 'lucide-react-native';
import { SettingsHeader } from '../SettingsHeader';
import { useLanguage } from '@/contexts';
import { useComposioApps, type ComposioApp } from '@/hooks/useComposio';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { ComposioAppDetail, ComposioAppDetailContent } from './ComposioAppDetail';
import { ToolkitIcon } from './ToolkitIcon';


const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ComposioAppsListProps {
  visible: boolean;
  onClose: () => void;
}

interface ComposioAppsContentProps {
  onBack?: () => void;
  onAppSelect?: (app: ComposioApp) => void;
  noPadding?: boolean;
}

export function ComposioAppsContent({ onBack, onAppSelect, noPadding = false }: ComposioAppsContentProps) {
  const { t } = useLanguage();
  const { data: appsData, isLoading, error, refetch } = useComposioApps();
  const [selectedApp, setSelectedApp] = React.useState<ComposioApp | null>(null);
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
    } else {
      setSelectedApp(app);
    }
  }, [onAppSelect]);

  const handleBackToList = React.useCallback(() => {
    console.log('🎯 Back to apps list');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedApp(null);
  }, []);

  const handleIntegrationComplete = React.useCallback(() => {
    console.log('✅ Integration completed');
    setSelectedApp(null);
    refetch();
    console.log('✅ Integration added successfully');
  }, [refetch]);

  if (selectedApp && !onAppSelect) {
    return (
      <ComposioAppDetailContent
        app={selectedApp}
        onBack={handleBackToList}
        noPadding={noPadding}
        onComplete={handleIntegrationComplete}
      />
    );
  }

  return (
    <View className="flex-1">
      <View className={noPadding ? "pb-6" : "px-6 pb-6"}>
        {onBack && (
          <Pressable
            onPress={onBack}
            className="items-center justify-center w-10 h-10 mb-4 active:opacity-70 rounded-full bg-primary/10"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
        )}
        
        <Text className="text-2xl font-roobert-bold text-foreground mb-2">
          App Integrations
        </Text>
        
        <Text className="text-sm font-roobert text-muted-foreground mb-6">
          Connect popular apps and services through Composio integrations.
        </Text>

        {error && (
          <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4 mb-6">
            <View className="flex-row items-center gap-2">
              <Icon as={AlertCircle} size={16} className="text-destructive" />
              <Text className="text-sm font-roobert-medium text-destructive">
                Failed to load integrations
              </Text>
            </View>
            <Text className="text-sm font-roobert text-destructive/80 mt-1">
              {error.message || 'Please try again later'}
            </Text>
          </View>
        )}

        {isLoading && !apps.length ? (
          <View className="items-center justify-center py-12">
            <ActivityIndicator size="large" className="text-primary" />
            <Text className="text-sm font-roobert text-muted-foreground mt-4">
              Loading integrations...
            </Text>
          </View>
        ) : (
          <View className="space-y-3">
            {filteredApps.map((app: ComposioApp) => (
              <AppCard 
                key={app.slug} 
                app={app} 
                onPress={() => handleAppPress(app)} 
              />
            ))}
            
            {filteredApps.length === 0 && !isLoading && (
              <View className="items-center justify-center py-12">
                <Icon as={Search} size={48} className="text-muted-foreground/40" />
                <Text className="text-lg font-roobert-medium text-foreground mt-4">
                  No integrations found
                </Text>
                <Text className="text-sm font-roobert text-muted-foreground">
                  Try adjusting your search or check back later
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
      
      <View className="h-20" />
    </View>
  );
}

export function ComposioAppsList({ visible, onClose }: ComposioAppsListProps) {
  const { t } = useLanguage();
  const { data: appsData, isLoading, error, refetch } = useComposioApps();
  const [selectedApp, setSelectedApp] = React.useState<ComposioApp | null>(null);
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

  const handleClose = React.useCallback(() => {
    console.log('🎯 Composio apps list closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleAppPress = React.useCallback((app: ComposioApp) => {
    console.log('🎯 App selected:', app.name);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedApp(app);
  }, []);

  const handleBackToList = React.useCallback(() => {
    console.log('🎯 Back to apps list');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedApp(null);
  }, []);

  const handleIntegrationComplete = React.useCallback(() => {
    console.log('✅ Integration completed');
    setSelectedApp(null);
    refetch();
    console.log('✅ Integration added successfully');
  }, [refetch]);

  if (!visible) return null;

  if (selectedApp) {
    return (
      <ComposioAppDetail
        app={selectedApp}
        visible={true}
        onClose={handleBackToList}
        onComplete={handleIntegrationComplete}
      />
    );
  }

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <SettingsHeader
          title="App Integrations"
          onClose={handleClose}
        />
        
        <ScrollView 
          className="flex-1" 
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isLoading} onRefresh={refetch} />
          }
        >
          <View className="px-6 pb-6">
          <Text className="text-sm font-roobert text-muted-foreground mb-6">
            Connect popular apps and services through Composio integrations.
          </Text>

          {error && (
            <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4 mb-6">
              <View className="flex-row items-center gap-2">
                <Icon as={AlertCircle} size={16} className="text-destructive" />
                <Text className="text-sm font-roobert-medium text-destructive">
                  Failed to load integrations
                </Text>
              </View>
              <Text className="text-sm font-roobert text-destructive/80 mt-1">
                {error.message || 'Please try again later'}
              </Text>
            </View>
          )}

          {isLoading && !apps.length ? (
            <View className="items-center justify-center py-12">
              <ActivityIndicator size="large" className="text-primary" />
              <Text className="text-sm font-roobert text-muted-foreground mt-4">
                Loading integrations...
              </Text>
            </View>
          ) : (
            <View className="space-y-3">
              {filteredApps.map((app: ComposioApp) => (
                <AppCard 
                  key={app.slug} 
                  app={app} 
                  onPress={() => handleAppPress(app)} 
                />
              ))}
              
              {filteredApps.length === 0 && !isLoading && (
                <View className="items-center justify-center py-12">
                  <Icon as={Search} size={48} className="text-muted-foreground/40" />
                  <Text className="text-lg font-roobert-medium text-foreground mt-4">
                    No integrations found
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground">
                    Try adjusting your search or check back later
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
        
        <View className="h-20" />
      </ScrollView>
      </View>
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

  const statusIndicator = React.useMemo(() => {
    if (app.connected) {
      return (
        <View className="flex-row items-center gap-1">
          <Icon as={CheckCircle2} size={14} className="text-green-600" />
          <Text className="text-xs font-roobert-medium text-green-600">
            Connected
          </Text>
        </View>
      );
    }
    return null;
  }, [app.connected]);
  
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="bg-muted/10 dark:bg-muted/30 rounded-3xl p-4 mb-4"
    >
      <View className="flex-row items-center gap-3">
        <View className="w-12 h-12 rounded-xl bg-secondary items-center justify-center">
            <ToolkitIcon 
            slug={app.slug} 
            name={app.name} 
            size="sm" 
            />
        </View>
        
        <View className="flex-1">
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-roobert-medium text-foreground">
              {app.name}
            </Text>
            {statusIndicator}
          </View>
          
          {app.description && (
            <Text 
              className="text-sm font-roobert text-muted-foreground mt-1" 
              numberOfLines={2}
            >
              {app.description}
            </Text>
          )}
          
          {app.categories && app.categories.length > 0 && (
            <View className="flex-row flex-wrap gap-1 mt-2">
              {app.categories.slice(0, 3).map((category, index) => (
                <View 
                  key={index}
                  className="bg-primary/10 px-2 py-1 rounded-md"
                >
                  <Text className="text-xs font-roobert text-primary">
                    {category}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>
    </AnimatedPressable>
  );
});
