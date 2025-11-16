import * as React from 'react';
import { View, ScrollView, Pressable, Image, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  ArrowLeft, 
  Plug2, 
  Plus,
  Settings,
  CheckCircle2,
  AlertCircle, 
  Wrench
} from 'lucide-react-native';
import { SettingsHeader } from '../SettingsHeader';
import { useLanguage } from '@/contexts';
import { 
  useComposioProfiles, 
  useComposioToolkitDetails, 
  useComposioToolsBySlug,
  type ComposioApp, 
  type ComposioProfile 
} from '@/hooks/useComposio';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { ComposioConnector } from './ComposioConnector';
import { ComposioToolsSelector } from './ComposioToolsSelector';
import { ToolkitIcon } from './ToolkitIcon';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ComposioAppDetailProps {
  app: ComposioApp;
  visible: boolean;
  onClose: () => void;
  onComplete: () => void;
}

interface ComposioAppDetailContentProps {
  app: ComposioApp;
  onBack?: () => void;
  noPadding?: boolean;
  onComplete?: () => void;
  onNavigateToConnector?: (app: ComposioApp, profile?: ComposioProfile) => void;
  onNavigateToTools?: (app: ComposioApp, profile: ComposioProfile) => void;
}

export function ComposioAppDetailContent({ 
  app, 
  onBack, 
  noPadding = false, 
  onComplete,
  onNavigateToConnector,
  onNavigateToTools
}: ComposioAppDetailContentProps) {
  const { t } = useLanguage();
  const { data: profiles, isLoading: profilesLoading } = useComposioProfiles();
  const { data: toolkitDetails, isLoading: detailsLoading } = useComposioToolkitDetails(app.slug);
  const { data: toolsResponse, isLoading: toolsLoading } = useComposioToolsBySlug(app.slug, { limit: 50 });
  
  const [activeView, setActiveView] = React.useState<'main' | 'connector' | 'tools'>('main');
  const [selectedProfile, setSelectedProfile] = React.useState<ComposioProfile | null>(null);
  const [showProfileOptions, setShowProfileOptions] = React.useState(false);

  const appProfiles = React.useMemo(() => {
    if (!profiles || !app) return [];
    
    const filteredProfiles = profiles.filter((profile: ComposioProfile) => {
      const isConnected = profile.is_connected || profile.connection_status === 'active';
      return profile.toolkit_slug === app.slug && isConnected;
    });
    
    return filteredProfiles;
  }, [profiles, app]);

  const availableTools = toolsResponse?.tools || [];
  const hasProfiles = appProfiles.length > 0;

  const handleCreateNew = React.useCallback(() => {
    console.log('🎯 Create new profile');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    if (onNavigateToConnector) {
      onNavigateToConnector(app);
    } else {
      setSelectedProfile(null);
      setActiveView('connector');
    }
  }, [onNavigateToConnector, app]);

  const handleConnectExisting = React.useCallback((profile: ComposioProfile) => {
    console.log('🎯 Connect existing profile:', profile.profile_name);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    if (onNavigateToTools) {
      onNavigateToTools(app, profile);
    } else {
      setSelectedProfile(profile);
      setActiveView('tools');
    }
  }, [onNavigateToTools, app]);

  const handleBackToDetail = React.useCallback(() => {
    console.log('🎯 Back to detail');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveView('main');
    setSelectedProfile(null);
  }, []);

  const handleConnectorComplete = React.useCallback((profileId: string, appName: string, appSlug: string) => {
    console.log('✅ Connector completed with profile:', profileId);
    // Integration completed successfully - refresh and go back to main view
    setActiveView('main');
    onComplete?.();
  }, [onComplete]);

  const handleToolsComplete = React.useCallback(() => {
    console.log('✅ Tools configuration completed');
    onComplete?.();
  }, [onComplete]);

  const handleMainAction = React.useCallback(() => {
    console.log('🎯 Main action pressed - hasProfiles:', hasProfiles, 'onNavigateToConnector:', !!onNavigateToConnector);
    
    if (onNavigateToConnector) {
      onNavigateToConnector(app);
    } else {
      if (hasProfiles) {
        setShowProfileOptions(true);
      } else {
        handleCreateNew();
      }
    }
  }, [hasProfiles, handleCreateNew, onNavigateToConnector, app]);

  if (activeView === 'connector') {
    return (
      <ComposioConnector
        app={app}
        visible={true}
        onClose={handleBackToDetail}
        onComplete={handleConnectorComplete}
        mode="profile-only"
      />
    );
  }

  if (activeView === 'tools' && selectedProfile) {
    return (
      <ComposioToolsSelector
        app={app}
        profile={selectedProfile}
        visible={true}
        onClose={handleBackToDetail}
        onComplete={handleToolsComplete}
      />
    );
  }

  return (
    <View className="flex-1">
      <ScrollView 
        className="flex-1" 
        showsVerticalScrollIndicator={false}
      >
        <View className={noPadding ? "pb-6" : "px-6 pb-6"}>
        {onBack && (
          <Pressable
            onPress={onBack}
            className="items-center justify-center w-10 h-10 mb-4 active:opacity-70 rounded-full bg-primary/10"
          >
            <ArrowLeft size={20} className="text-muted-foreground" />
          </Pressable>
        )}
        <View className="mb-6">
          <View className="flex-row gap-4 mb-4">
            <View className="w-16 h-16 rounded-3xl bg-primary/5 items-center justify-center">
              <ToolkitIcon 
                slug={app.slug} 
                name={app.name} 
                size="sm" 
              />
            </View>
            <View className="flex-1">
              <Text className="text-xl font-roobert-bold text-foreground mb-1">
                {app.name}
              </Text>
              
              {app.description && (
                <Text 
                  className="text-sm font-roobert text-muted-foreground leading-relaxed mb-3"
                  numberOfLines={2}
                  ellipsizeMode="tail"
                >
                  {app.description}
                </Text>
              )}
              <AnimatedPressable
                onPress={handleMainAction}
                className="self-start px-6 py-2 rounded-full bg-primary active:opacity-90"
              >
                <Text className="text-sm font-roobert-semibold text-white">
                  {hasProfiles ? 'CONNECT' : 'SETUP'}
                </Text>
              </AnimatedPressable>
            </View>
          </View>
          <View className="flex-row items-center justify-between pt-4 border-t border-border/20">
            <View className="flex-1">
              <Text className="text-xs font-roobert text-muted-foreground uppercase tracking-wider">
                Developer
              </Text>
              <Text className="text-sm font-roobert-medium text-foreground">
                Composio
              </Text>
            </View>
            
            <View className="flex-1 items-center">
              <Text className="text-xs font-roobert text-muted-foreground uppercase tracking-wider">
                Tools
              </Text>
              <Text className="text-sm font-roobert-medium text-foreground">
                {availableTools.length > 0 ? availableTools.length : '—'}
              </Text>
            </View>
          </View>
          
          {hasProfiles && (
            <View className="mt-3 flex-row items-center justify-center gap-2">
              <View className="w-2 h-2 rounded-full bg-green-500" />
              <Text className="text-xs font-roobert-medium text-muted-foreground">
                {appProfiles.length} connection{appProfiles.length !== 1 ? 's' : ''} ready
              </Text>
            </View>
          )}
        </View>
        {detailsLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="large" className="text-primary" />
            <Text className="text-sm font-roobert text-muted-foreground mt-2">
              Loading integration details...
            </Text>
          </View>
        ) : (
          <>
            {availableTools.length > 0 && (
              <View className="mb-8">
                <View className="flex-row flex-wrap gap-2">
                  {availableTools.slice(0, 12).map((tool: any, index: number) => (
                    <View 
                      key={tool.slug || tool.name || index}
                      className="flex-col items-start gap-3 p-3 bg-primary/5 rounded-2xl"
                      style={{ width: '48%' }}
                    >
                      <View className="w-8 h-8 bg-primary rounded-full items-center justify-center">
                        <Icon as={Wrench} size={16} className="text-primary-foreground" />
                      </View>
                      <View className="flex-1">
                        <Text className="text-sm font-roobert-medium text-foreground">
                          {tool.name || `Tool ${index + 1}`}
                        </Text>
                        {tool.description && (
                          <Text 
                            className="text-xs font-roobert text-muted-foreground mt-0.5"
                            numberOfLines={2}
                            ellipsizeMode="tail"
                          >
                            {tool.description}
                          </Text>
                        )}
                        {!tool.description && tool.tags && tool.tags.length > 0 && (
                          <Text className="text-xs font-roobert text-muted-foreground mt-0.5">
                            {tool.tags[0]}
                          </Text>
                        )}
                        {!tool.description && (!tool.tags || tool.tags.length === 0) && (
                          <Text className="text-xs font-roobert text-muted-foreground mt-0.5">
                            Automation tool for {app.name}
                          </Text>
                        )}
                      </View>
                    </View>
                  ))}
                  
                  {availableTools.length > 6 && (
                    <View className="p-3 bg-muted/5 border border-border/30 rounded-xl" style={{ width: '48%' }}>
                      <Text className="text-sm font-roobert text-muted-foreground text-center">
                        +{availableTools.length - 6} more tools available after setup
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            )}

            {toolkitDetails?.tools && toolkitDetails.tools.length === 0 && (
              <View className="mb-8 p-6 bg-muted/5 border border-border/30 rounded-xl text-center">
                <Text className="text-sm font-roobert text-muted-foreground">
                  No tools found for this integration
                </Text>
              </View>
            )}

            {detailsLoading && (
              <View className="mb-8">
                <View className="mb-4">
                  <Text className="text-lg font-roobert-semibold text-foreground mb-1">
                    Available Tools
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground">
                    Loading automation tools...
                  </Text>
                </View>
                <View className="space-y-2">
                  {[1, 2, 3].map((index) => (
                    <View 
                      key={index}
                      className="flex-row items-center gap-3 p-3 bg-muted/5 rounded-xl"
                    >
                      <View className="w-8 h-8 bg-muted/20 rounded-lg" />
                      <View className="flex-1">
                        <View className="h-4 bg-muted/20 rounded w-3/4 mb-1" />
                        <View className="h-3 bg-muted/10 rounded w-1/2" />
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            )}
            {hasProfiles && onNavigateToConnector && (
              <View className="mb-6">
                <Text className="text-lg font-roobert-semibold text-foreground mb-4">
                  Connection Options
                </Text>
                
                <View className="space-y-3">
                  <ProfileOptionCard
                    icon={Plus}
                    iconBg="bg-primary/20"
                    iconColor="text-primary"
                    title="Create New Connection"
                    description="Set up a fresh profile with new credentials"
                    onPress={handleCreateNew}
                  />

                  {appProfiles.map((profile: ComposioProfile) => (
                    <ProfileOptionCard
                      key={profile.profile_id}
                      icon={CheckCircle2}
                      iconBg="bg-green-500/20"
                      iconColor="text-green-600"
                      title={profile.profile_name}
                      description={profile.is_connected ? 'Connected and ready to use' : 'Requires authentication'}
                      badge={profile.is_connected ? 'Ready' : 'Auth needed'}
                      badgeColor={profile.is_connected ? 'bg-green-500' : 'bg-orange-500'}
                      onPress={() => handleConnectExisting(profile)}
                    />
                  ))}
                </View>
              </View>
            )}

            {/* Ugly modal only for standalone usage */}
            {showProfileOptions && !onNavigateToConnector && (
              <View className="absolute inset-0 bg-black/60 items-end justify-end z-50">
                <Animated.View 
                  className="bg-background w-full rounded-t-3xl"
                  style={{
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: -4 },
                    shadowOpacity: 0.25,
                    shadowRadius: 16,
                    elevation: 16,
                  }}
                >
                  <View className="w-12 h-1 bg-muted/30 rounded-full mx-auto mt-3" />
                  
                  <View className="p-6 pb-8">
                    <Text className="text-lg font-roobert-semibold text-foreground mb-1 text-center">
                      Connect to {app.name}
                    </Text>
                    <Text className="text-sm text-muted-foreground text-center mb-6">
                      Choose how you'd like to connect
                    </Text>
                    
                    <View className="space-y-3">
                      <ProfileOptionCard
                        icon={Plus}
                        iconBg="bg-primary/20"
                        iconColor="text-primary"
                        title="Create New Connection"
                        description="Set up a new profile with fresh credentials"
                        onPress={() => {
                          setShowProfileOptions(false);
                          handleCreateNew();
                        }}
                      />

                      {appProfiles.map((profile: ComposioProfile) => (
                        <ProfileOptionCard
                          key={profile.profile_id}
                          icon={CheckCircle2}
                          iconBg="bg-green-500/20"
                          iconColor="text-green-600"
                          title={profile.profile_name}
                          description={profile.is_connected ? 'Connected and ready to use' : 'Requires authentication'}
                          badge={profile.is_connected ? 'Ready' : 'Auth needed'}
                          badgeColor={profile.is_connected ? 'bg-green-500' : 'bg-orange-500'}
                          onPress={() => {
                            setShowProfileOptions(false);
                            handleConnectExisting(profile);
                          }}
                        />
                      ))}
                    </View>

                    <Pressable
                      onPress={() => setShowProfileOptions(false)}
                      className="w-full mt-6 py-4 items-center active:opacity-70"
                    >
                      <Text className="text-muted-foreground font-roobert-medium">Cancel</Text>
                    </Pressable>
                  </View>
                </Animated.View>
              </View>
            )}
          </>
        )}
        </View>
        
        <View className="h-6" />
      </ScrollView>
    </View>
  );
}

export function ComposioAppDetail({ 
  app, 
  visible, 
  onClose, 
  onComplete 
}: ComposioAppDetailProps) {
  const { t } = useLanguage();
  const { data: profiles, isLoading: profilesLoading } = useComposioProfiles();
  const { data: toolkitDetails, isLoading: detailsLoading } = useComposioToolkitDetails(app.slug);
  
  const [activeView, setActiveView] = React.useState<'main' | 'connector' | 'tools'>('main');
  const [selectedProfile, setSelectedProfile] = React.useState<ComposioProfile | null>(null);

  const appProfiles = React.useMemo(() => {
    if (!profiles || !app) return [];
    
    const filteredProfiles = profiles.filter((profile: ComposioProfile) => {
      const isConnected = profile.is_connected || profile.connection_status === 'active';
      return profile.toolkit_slug === app.slug && isConnected;
    });
    
    return filteredProfiles;
  }, [profiles, app]);

  const hasProfiles = appProfiles.length > 0;

  const handleClose = React.useCallback(() => {
    console.log('🎯 App detail closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveView('main');
    onClose();
  }, [onClose]);

  const handleCreateNew = React.useCallback(() => {
    console.log('🎯 Create new profile');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedProfile(null);
    setActiveView('connector');
  }, []);

  const handleConnectExisting = React.useCallback((profile: ComposioProfile) => {
    console.log('🎯 Connect existing profile:', profile.profile_name);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedProfile(profile);
    setActiveView('tools');
  }, []);

  const handleBackToDetail = React.useCallback(() => {
    console.log('🎯 Back to detail');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveView('main');
    setSelectedProfile(null);
  }, []);

  const handleConnectorComplete = React.useCallback((profileId: string, appName: string, appSlug: string) => {
    console.log('✅ Connector completed with profile:', profileId);
    setActiveView('main');
    onComplete();
  }, [onComplete]);

  const handleToolsComplete = React.useCallback(() => {
    console.log('✅ Tools configuration completed');
    onComplete();
  }, [onComplete]);

  if (!visible) return null;

  if (activeView === 'connector') {
    return (
      <ComposioConnector
        app={app}
        visible={true}
        onClose={handleBackToDetail}
        onComplete={handleConnectorComplete}
        mode="profile-only"
      />
    );
  }

  if (activeView === 'tools' && selectedProfile) {
    return (
      <ComposioToolsSelector
        app={app}
        profile={selectedProfile}
        visible={true}
        onClose={handleBackToDetail}
        onComplete={handleToolsComplete}
      />
    );
  }

  return (
    <View className="flex-1">
      <SettingsHeader
        title={app.name}
        onClose={handleClose}
      />
      
      <ScrollView 
        className="flex-1" 
        showsVerticalScrollIndicator={false}
      >
        <View className="px-6 pb-6">
          <View className="items-center py-6">
            <ToolkitIcon 
              slug={app.slug} 
              name={app.name} 
              size="lg" 
              className="mb-4"
            />
            <Text className="text-xl font-roobert-semibold text-foreground text-center mb-2">
              {app.name}
            </Text>
            {app.description && (
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                {app.description}
              </Text>
            )}
          </View>
          {detailsLoading ? (
            <View className="items-center py-8">
              <ActivityIndicator size="large" className="text-primary" />
              <Text className="text-sm font-roobert text-muted-foreground mt-2">
                Loading integration details...
              </Text>
            </View>
          ) : (
            <View className="space-y-6">
              <View>
                <Text className="text-lg font-roobert-semibold text-foreground mb-4">
                  Setup Options
                </Text>
                <OptionCard
                  icon={Plus}
                  title="Create New Profile"
                  description="Set up a new connection with your credentials"
                  onPress={handleCreateNew}
                  badge="Recommended"
                />
                {hasProfiles && (
                  <View className="mt-4">
                    <Text className="text-base font-roobert-medium text-foreground mb-3">
                      Connect Existing Profile
                    </Text>
                    <Text className="text-sm font-roobert text-muted-foreground mb-4">
                      Use a profile you've already configured:
                    </Text>
                    
                    <View className="space-y-3">
                      {appProfiles.map((profile: ComposioProfile) => (
                        <ProfileCard
                          key={profile.profile_id}
                          profile={profile}
                          onPress={() => handleConnectExisting(profile)}
                        />
                      ))}
                    </View>
                  </View>
                )}
              </View>
              {toolkitDetails?.tools && (
                <View>
                  <Text className="text-base font-roobert-medium text-foreground mb-3">
                    Available Tools
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground mb-4">
                    This integration provides {toolkitDetails.tools.length} tools:
                  </Text>
                  <View className="bg-muted/10 dark:bg-muted/30 rounded-xl p-4">
                    <View className="flex-row flex-wrap gap-2">
                      {toolkitDetails.tools.slice(0, 6).map((tool: any, index: number) => (
                        <View 
                          key={index}
                          className="bg-primary/10 px-3 py-1.5 rounded-lg"
                        >
                          <Text className="text-xs font-roobert-medium text-primary">
                            {tool.name}
                          </Text>
                        </View>
                      ))}
                      {toolkitDetails.tools.length > 6 && (
                        <View className="bg-muted/20 px-3 py-1.5 rounded-lg">
                          <Text className="text-xs font-roobert-medium text-muted-foreground">
                            +{toolkitDetails.tools.length - 6} more
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                </View>
              )}
            </View>
          )}
        </View>
        <View className="h-6" />
      </ScrollView>
    </View>
  );
}

interface OptionCardProps {
  icon: typeof Plus;
  title: string;
  description: string;
  onPress: () => void;
  badge?: string;
}

const OptionCard = React.memo(({ 
  icon, 
  title, 
  description, 
  onPress, 
  badge 
}: OptionCardProps) => {
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
      className="bg-primary/5 border border-primary/20 rounded-2xl p-4"
    >
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 rounded-xl bg-primary/10 items-center justify-center">
          <Icon as={icon} size={20} className="text-primary" strokeWidth={2} />
        </View>
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-base font-roobert-medium text-foreground">
              {title}
            </Text>
            {badge && (
              <View className="bg-primary px-2 py-0.5 rounded-full">
                <Text className="text-xs font-roobert-medium text-white">
                  {badge}
                </Text>
              </View>
            )}
          </View>
          <Text className="text-sm font-roobert text-muted-foreground">
            {description}
          </Text>
        </View>
      </View>
    </AnimatedPressable>
  );
});

interface ProfileCardProps {
  profile: ComposioProfile;
  onPress: () => void;
}

const ProfileCard = React.memo(({ profile, onPress }: ProfileCardProps) => {
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

  const statusIcon = React.useMemo(() => {
    switch (profile.connection_status) {
      case 'active':
        return <Icon as={CheckCircle2} size={16} className="text-green-600" />;
      case 'error':
        return <Icon as={AlertCircle} size={16} className="text-destructive" />;
      default:
        return <Icon as={Settings} size={16} className="text-orange-500" />;
    }
  }, [profile.connection_status]);

  const statusText = React.useMemo(() => {
    switch (profile.connection_status) {
      case 'active':
        return 'Connected';
      case 'error':
        return 'Error';
      default:
        return 'Needs Auth';
    }
  }, [profile.connection_status]);
  
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="bg-muted/10 dark:bg-muted/30 rounded-xl p-3"
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="text-base font-roobert-medium text-foreground">
            {profile.profile_name}
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground">
            Created {new Date(profile.created_at).toLocaleDateString()}
          </Text>
        </View>
        
        <View className="flex-row items-center gap-1">
          {statusIcon}
          <Text className={`text-sm font-roobert-medium ${
            profile.connection_status === 'active' 
              ? 'text-green-600' 
              : profile.connection_status === 'error'
              ? 'text-destructive'
              : 'text-orange-500'
          }`}>
            {statusText}
          </Text>
        </View>
      </View>
    </AnimatedPressable>
  );
});

interface ProfileOptionCardProps {
  icon: typeof Plus;
  iconBg: string;
  iconColor: string;
  title: string;
  description: string;
  badge?: string;
  badgeColor?: string;
  onPress: () => void;
}

const ProfileOptionCard = React.memo(({ 
  icon, 
  iconBg, 
  iconColor, 
  title, 
  description, 
  badge, 
  badgeColor, 
  onPress 
}: ProfileOptionCardProps) => {
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = React.useCallback(() => {
    scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
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
      className="p-4 bg-muted/5 border border-border/30 rounded-2xl active:opacity-80"
    >
      <View className="flex-row items-center gap-4">
        <View className={`w-12 h-12 ${iconBg} rounded-2xl items-center justify-center`}>
          <Icon as={icon} size={20} className={iconColor} strokeWidth={2} />
        </View>
        
        <View className="flex-1">
          <View className="flex-row items-center gap-2 mb-1">
            <Text className="font-roobert-semibold text-foreground text-base">
              {title}
            </Text>
            {badge && (
              <View className={`px-2 py-1 ${badgeColor} rounded-full`}>
                <Text className="text-xs font-roobert-medium text-white">
                  {badge}
                </Text>
              </View>
            )}
          </View>
          <Text className="text-sm text-muted-foreground font-roobert">
            {description}
          </Text>
        </View>
        
        <Icon as={ArrowLeft} size={16} className="text-muted-foreground rotate-180" />
      </View>
    </AnimatedPressable>
  );
});
