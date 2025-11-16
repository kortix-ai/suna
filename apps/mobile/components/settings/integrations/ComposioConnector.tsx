import * as React from 'react';
import { View, ScrollView, Pressable, Image, ActivityIndicator, TextInput, Alert, Switch } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  ArrowLeft, 
  Plug2, 
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Plus,
  User,
  Settings,
  Check,
  X,
  Loader2,
  Info,
  Shield
} from 'lucide-react-native';
import { SettingsHeader } from '../SettingsHeader';
import { useLanguage } from '@/contexts';
import { 
  useCreateComposioProfile,
  useComposioProfiles, 
  useComposioToolkitDetails,
  useCheckProfileNameAvailability,
  useUpdateComposioTools,
  type ComposioApp,
  type ComposioProfile,
  type CreateComposioProfileRequest,
  type AuthConfigField
} from '@/hooks/useComposio';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import * as WebBrowser from 'expo-web-browser';
import { ToolkitIcon } from './ToolkitIcon';
import { ComposioToolsSelector } from './ComposioToolsSelector';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ComposioConnectorProps {
  app: ComposioApp;
  visible: boolean;
  onClose: () => void;
  onComplete: (profileId: string, appName: string, appSlug: string) => void;
  mode?: 'full' | 'profile-only';
  agentId?: string;
}

interface ComposioConnectorContentProps {
  app: ComposioApp;
  onBack?: () => void;
  onComplete: (profileId: string, appName: string, appSlug: string) => void;
  onNavigateToTools?: (app: ComposioApp, profile: ComposioProfile) => void;
  mode?: 'full' | 'profile-only';
  agentId?: string;
  noPadding?: boolean;
}

enum Step {
  ProfileSelect = 'profile-select',
  ProfileCreate = 'profile-create',
  Connecting = 'connecting',
  ToolsSelection = 'tools-selection',
  Success = 'success'
}

const CUSTOM_OAUTH_REQUIRED_APPS = [
  'zendesk',
];

export function ComposioConnectorContent({
  app,
  onBack,
  onComplete,
  onNavigateToTools,
  mode = 'full',
  agentId,
  noPadding = false
}: ComposioConnectorContentProps) {
  const { t } = useLanguage();
  
  const [currentStep, setCurrentStep] = React.useState<Step>(Step.ProfileSelect);
  const [profileName, setProfileName] = React.useState(`${app.name} Profile`);
  const [selectedProfileId, setSelectedProfileId] = React.useState<string>('');
  const [createdProfileId, setCreatedProfileId] = React.useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = React.useState<ComposioProfile | null>(null);
  const [redirectUrl, setRedirectUrl] = React.useState<string | null>(null);
  const [selectedConnectionType, setSelectedConnectionType] = React.useState<'existing' | 'new' | null>(null);
  
  const [initiationFields, setInitiationFields] = React.useState<Record<string, string>>({});
  const [initiationFieldsErrors, setInitiationFieldsErrors] = React.useState<Record<string, string>>({});
  
  const [useCustomAuth, setUseCustomAuth] = React.useState(false);
  const [customAuthConfig, setCustomAuthConfig] = React.useState<Record<string, string>>({});
  const [customAuthConfigErrors, setCustomAuthConfigErrors] = React.useState<Record<string, string>>({});
  
  const [selectedTools, setSelectedTools] = React.useState<string[]>([]);

  const { mutate: createProfile, isPending: isCreating } = useCreateComposioProfile();
  const { data: profiles, isLoading: isLoadingProfiles } = useComposioProfiles();
  
  const { data: toolkitDetails, isLoading: isLoadingToolkitDetails } = useComposioToolkitDetails(app.slug);
  
  const { data: nameAvailability, isLoading: isCheckingName } = useCheckProfileNameAvailability(
    app.slug,
    profileName,
    {
      enabled: currentStep === Step.ProfileCreate && profileName.length > 0,
      debounceMs: 500
    }
  );
  
  const { mutate: updateTools } = useUpdateComposioTools();

  const existingProfiles = profiles?.filter((p: ComposioProfile) =>
    p.toolkit_slug === app.slug && p.is_connected
  ) || [];

  React.useEffect(() => {
    const requiresCustomAuth = CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug);
    setCurrentStep(Step.ProfileSelect);
    setProfileName(`${app.name} Profile`);
    setSelectedProfileId('');
    setSelectedProfile(null);
    setCreatedProfileId(null);
    setRedirectUrl(null);
    setSelectedConnectionType(null);
    setSelectedTools([]);
    setInitiationFields({});
    setInitiationFieldsErrors({});
    setUseCustomAuth(requiresCustomAuth);
    setCustomAuthConfig({});
    setCustomAuthConfigErrors({});
  }, [app.name, app.slug]);

  const handleMainAction = React.useCallback(() => {
    if (selectedConnectionType === 'new') {
      setCurrentStep(Step.ProfileCreate);
    } else if (selectedConnectionType === 'existing' && selectedProfileId) {
      const profile = existingProfiles.find((p: ComposioProfile) => p.profile_id === selectedProfileId);
      if (profile) {
        setSelectedProfile(profile);
        setCreatedProfileId(profile.profile_id);
        if (mode === 'full' && agentId) {
          if (onNavigateToTools) {
            onNavigateToTools(app, profile);
          } else {
            setCurrentStep(Step.ToolsSelection);
          }
        } else {
          onComplete(profile.profile_id, app.name, app.slug);
        }
      }
    }
  }, [selectedConnectionType, selectedProfileId, existingProfiles, mode, agentId, onComplete, app]);

  const handleSaveTools = async () => {
    if (!selectedProfile || !agentId) return;
    updateTools({
      agentId,
      profileId: selectedProfile.profile_id,
      selectedTools
    }, {
      onSuccess: () => {
        Alert.alert('Success', `Added ${selectedTools.length} ${selectedProfile.toolkit_name} tools to your agent!`);
        onComplete(selectedProfile.profile_id, app.name, app.slug);
      },
      onError: (error: any) => {
        Alert.alert('Error', error.message || 'Failed to save tools');
      }
    });
  };

  const handleInitiationFieldChange = (fieldName: string, value: string) => {
    setInitiationFields(prev => ({ ...prev, [fieldName]: value }));
    if (initiationFieldsErrors[fieldName]) {
      setInitiationFieldsErrors(prev => ({ ...prev, [fieldName]: '' }));
    }
  };

  const handleCreateProfile = () => {
    if (!profileName.trim()) {
      Alert.alert('Error', 'Profile name is required');
      return;
    }

    if (nameAvailability && !nameAvailability.available) {
      Alert.alert('Error', 'This profile name is already in use. Please choose a different name.');
      return;
    }

    createProfile({
      toolkit_slug: app.slug,
      profile_name: profileName,
      initiation_fields: Object.keys(initiationFields).length > 0 ? initiationFields : undefined,
      custom_auth_config: useCustomAuth && Object.keys(customAuthConfig).length > 0 ? customAuthConfig : undefined,
      use_custom_auth: useCustomAuth,
    }, {
      onSuccess: (response) => {
        setCreatedProfileId(response.profile_id);
        if (response.redirect_url) {
          setRedirectUrl(response.redirect_url);
          setCurrentStep(Step.Connecting);
          WebBrowser.openBrowserAsync(response.redirect_url, {
            presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
            showTitle: true,
          });
        } else {
          setCurrentStep(Step.Success);
          setTimeout(() => {
            onComplete(response.profile_id, app.name, app.slug);
          }, 1500);
        }
      },
      onError: (error: any) => {
        Alert.alert('Error', error.message || 'Failed to create profile');
      }
    });
  };

  const handleAuthComplete = () => {
    if (createdProfileId) {
      setCurrentStep(Step.Success);
      setTimeout(() => {
        onComplete(createdProfileId, app.name, app.slug);
      }, 1500);
    }
  };

  const handleBack = () => {
    switch (currentStep) {
      case Step.ProfileCreate:
        setCurrentStep(Step.ProfileSelect);
        break;
      case Step.Connecting:
        setCurrentStep(Step.ProfileCreate);
        break;
      case Step.ToolsSelection:
        setCurrentStep(Step.ProfileSelect);
        break;
      default:
        onBack?.();
        break;
    }
  };

  // Profile Selection Step
  if (currentStep === Step.ProfileSelect) {
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
          
          <View className="items-center py-6">
            <ToolkitIcon 
              slug={app.slug} 
              name={app.name} 
              size="lg" 
              className="mb-4"
            />
            
            <Text className="text-xl font-roobert-semibold text-foreground text-center mb-2">
              Connect to {app.name}
            </Text>
            
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              Choose an existing profile or create a new connection
            </Text>
          </View>

          <View className="space-y-4">
            {existingProfiles.length > 0 && (
              <ConnectionOption
                icon={Check}
                title="Use Existing Connection"
                description={`${existingProfiles.length} profile${existingProfiles.length > 1 ? 's' : ''} already connected`}
                isSelected={selectedConnectionType === 'existing'}
                onPress={() => {
                  if (selectedConnectionType === 'existing') {
                    setSelectedConnectionType(null);
                    setSelectedProfileId('');
                  } else {
                    setSelectedConnectionType('existing');
                    setSelectedProfileId(existingProfiles[0]?.profile_id || '');
                  }
                }}
              >
                {selectedConnectionType === 'existing' && (
                  <View className="mt-4 pt-4 border-t border-border/30">
                    {existingProfiles.map((profile: ComposioProfile) => (
                      <Pressable
                        key={profile.profile_id}
                        onPress={() => setSelectedProfileId(profile.profile_id)}
                        className={`p-3 rounded-xl border mb-2 ${
                          selectedProfileId === profile.profile_id 
                            ? 'border-primary bg-primary/5' 
                            : 'border-border/30'
                        }`}
                      >
                        <Text className="font-roobert-medium text-foreground">
                          {profile.profile_name}
                        </Text>
                        <Text className="text-sm text-muted-foreground">
                          Created {new Date(profile.created_at).toLocaleDateString()}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </ConnectionOption>
            )}

            <ConnectionOption
              icon={Plus}
              title="Create New Connection"
              description={`Connect a new ${app.name} account`}
              isSelected={selectedConnectionType === 'new'}
              onPress={() => {
                if (selectedConnectionType === 'new') {
                  setSelectedConnectionType(null);
                  setSelectedProfileId('');
                } else {
                  setSelectedConnectionType('new');
                  setSelectedProfileId('new');
                }
              }}
            />
          </View>

          <View className="mt-8 flex-row gap-3">
            {onBack && (
              <Pressable 
                onPress={onBack}
                className="flex-1 py-4 items-center rounded-2xl border border-border/30"
              >
                <Text className="font-roobert-medium text-muted-foreground">Cancel</Text>
              </Pressable>
            )}
            
            <Pressable 
              onPress={handleMainAction}
              disabled={!selectedConnectionType || (selectedConnectionType === 'existing' && !selectedProfileId)}
              className={`flex-1 py-4 items-center rounded-2xl ${
                !selectedConnectionType || (selectedConnectionType === 'existing' && !selectedProfileId)
                  ? 'bg-muted/30'
                  : 'bg-primary'
              }`}
            >
              <Text className={`font-roobert-medium ${
                !selectedConnectionType || (selectedConnectionType === 'existing' && !selectedProfileId)
                  ? 'text-muted-foreground'
                  : 'text-primary-foreground'
              }`}>
                {selectedConnectionType === 'new' ? 'Create Connection' : 
                 selectedConnectionType === 'existing' && selectedProfileId ? 
                   'Use Profile' : 
                   'Continue'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // Profile Creation Step
  if (currentStep === Step.ProfileCreate) {
    return (
      <View className="flex-1">
        <View className={noPadding ? "pb-6" : "px-6 pb-6"}>
          <Pressable
            onPress={handleBack}
            className="items-center justify-center w-10 h-10 mb-4 active:opacity-70 rounded-full bg-primary/10"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          
          <View className="items-center py-6">
            <ToolkitIcon 
              slug={app.slug} 
              name={app.name} 
              size="lg" 
              className="mb-4"
            />
            
            <Text className="text-xl font-roobert-semibold text-foreground text-center mb-2">
              Create New Profile
            </Text>
            
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              Set up a new connection to {app.name}
            </Text>
          </View>

          <View className="space-y-6">
            <View>
              <Text className="text-base font-roobert-medium text-foreground mb-3">
                Profile Name
              </Text>
              <View className="relative">
                <TextInput
                  value={profileName}
                  onChangeText={setProfileName}
                  placeholder={`e.g., ${app.name} Production`}
                  className={`bg-muted/10 dark:bg-muted/30 rounded-xl px-4 py-3 text-base font-roobert text-foreground pr-12 ${
                    nameAvailability && !nameAvailability.available ? 'border border-red-500' :
                    nameAvailability && nameAvailability.available && profileName.length > 0 ? 'border border-green-500' :
                    'border border-transparent'
                  }`}
                  placeholderTextColor="rgba(156, 163, 175, 0.6)"
                />
                <View className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isCheckingName && profileName.length > 0 && (
                    <ActivityIndicator size="small" color="#666" />
                  )}
                  {!isCheckingName && nameAvailability && profileName.length > 0 && (
                    nameAvailability.available ? (
                      <Icon as={Check} size={16} className="text-green-500" />
                    ) : (
                      <Icon as={X} size={16} className="text-red-500" />
                    )
                  )}
                </View>
              </View>
              
              {nameAvailability && !nameAvailability.available && (
                <View className="mt-2">
                  <Text className="text-sm text-red-500">
                    This name is already in use
                  </Text>
                  {nameAvailability.suggestions.length > 0 && (
                    <View className="flex-row flex-wrap gap-2 mt-2">
                      {nameAvailability.suggestions.map((suggestion: string) => (
                        <Pressable
                          key={suggestion}
                          onPress={() => setProfileName(suggestion)}
                          className="px-2 py-1 bg-muted/20 rounded"
                        >
                          <Text className="text-xs text-muted-foreground">
                            {suggestion}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
              )}
              {nameAvailability && nameAvailability.available && profileName.length > 0 && (
                <Text className="text-sm text-green-600 mt-2">
                  Name available
                </Text>
              )}
            </View>

            <View className="flex-row gap-3">
              <Pressable 
                onPress={handleBack}
                disabled={isCreating}
                className="flex-1 py-4 items-center rounded-2xl border border-border/30"
              >
                <Text className="font-roobert-medium text-muted-foreground">Back</Text>
              </Pressable>
              
              <Pressable 
                onPress={handleCreateProfile}
                disabled={
                  isCreating ||
                  isLoadingToolkitDetails ||
                  !profileName.trim() ||
                  isCheckingName ||
                  (nameAvailability && !nameAvailability.available)
                }
                className={`flex-1 py-4 items-center rounded-2xl ${
                  isCreating ||
                  isLoadingToolkitDetails ||
                  !profileName.trim() ||
                  isCheckingName ||
                  (nameAvailability && !nameAvailability.available)
                    ? 'bg-muted/30'
                    : 'bg-primary'
                }`}
              >
                <View className="flex-row items-center gap-2">
                  {isCreating && <ActivityIndicator size="small" color="#fff" />}
                  <Text className={`font-roobert-medium ${
                    isCreating ||
                    isLoadingToolkitDetails ||
                    !profileName.trim() ||
                    isCheckingName ||
                    (nameAvailability && !nameAvailability.available)
                      ? 'text-muted-foreground'
                      : 'text-primary-foreground'
                  }`}>
                    {isCreating ? 'Creating...' : 'Connect'}
                  </Text>
                </View>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    );
  }

  // Connecting Step
  if (currentStep === Step.Connecting) {
    return (
      <View className="flex-1">
        <View className={noPadding ? "pb-6" : "px-6 pb-6"}>
          <View className="items-center py-12">
            <View className="w-20 h-20 rounded-2xl bg-primary/10 items-center justify-center mb-6">
              <Icon as={ExternalLink} size={40} className="text-primary" />
            </View>
            <Text className="text-lg font-roobert-semibold text-foreground mb-2">
              Complete Authentication
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center mb-6">
              A browser window has opened for you to authorize your {app.name} connection.
              Complete the process there and return here.
            </Text>
            
            {redirectUrl && (
              <View className="bg-muted/10 border border-muted/30 rounded-2xl p-4 mb-6">
                <Text className="text-sm font-roobert text-muted-foreground text-center">
                  If the window didn't open,{' '}
                  <Text 
                    onPress={() => redirectUrl && WebBrowser.openBrowserAsync(redirectUrl)}
                    className="text-primary underline"
                  >
                    tap here to authenticate
                  </Text>
                </Text>
              </View>
            )}
            
            <Pressable
              onPress={handleAuthComplete}
              className="w-full bg-primary rounded-2xl py-4 items-center"
            >
              <Text className="text-base font-roobert-medium text-primary-foreground">
                I've Completed Authentication
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }
 
  if (currentStep === Step.ToolsSelection && selectedProfile && !onNavigateToTools) {
    return (
      <View className="flex-1">
        <View className={noPadding ? "pb-6" : "px-6 pb-6"}>
          <Pressable
            onPress={handleBack}
            className="items-center justify-center w-10 h-10 mb-4 active:opacity-70 rounded-full bg-primary/10"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          
          <View className="items-center py-6">
            <ToolkitIcon 
              slug={app.slug} 
              name={app.name} 
              size="lg" 
              className="mb-4"
            />
            
            <Text className="text-xl font-roobert-semibold text-foreground text-center mb-2">
              Configure {app.name} Tools
            </Text>
            
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              Select tools to add to your agent
            </Text>
          </View>

          <ComposioToolsSelector
            app={app}
            profile={selectedProfile}
            visible={true}
            onClose={handleBack}
            onComplete={() => {
              Alert.alert('Success', `${app.name} tools configured successfully!`);
              onComplete(selectedProfile.profile_id, app.name, app.slug);
            }}
          />
        </View>
      </View>
    );
  }

  // Success Step
  if (currentStep === Step.Success) {
    return (
      <View className="flex-1">
        <View className={noPadding ? "pb-6" : "px-6 pb-6"}>
          <View className="items-center py-12">
            <View className="w-20 h-20 rounded-full bg-green-100 items-center justify-center mb-6">
              <Icon as={CheckCircle2} size={40} className="text-green-600" />
            </View>
            <Text className="text-lg font-roobert-semibold text-foreground mb-2">
              Successfully Connected!
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              Your {app.name} integration is ready.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return null;
}

export function ComposioConnector({ 
  app, 
  visible, 
  onClose, 
  onComplete,
  mode = 'full',
  agentId
}: ComposioConnectorProps) {
  if (!visible) return null;

  return (
    <View className="flex-1">
      <SettingsHeader
        title={`Connect ${app.name}`}
        onClose={onClose}
      />
      
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <ComposioConnectorContent
          app={app}
          onBack={onClose}
          onComplete={onComplete}
          mode={mode}
          agentId={agentId}
          noPadding={false}
        />
        
        <View className="h-6" />
      </ScrollView>
    </View>
  );
}

interface ConnectionOptionProps {
  icon: typeof Plus;
  title: string;
  description: string;
  isSelected: boolean;
  onPress: () => void;
  children?: React.ReactNode;
}

const ConnectionOption = React.memo(({ 
  icon, 
  title, 
  description, 
  isSelected, 
  onPress,
  children
}: ConnectionOptionProps) => {
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
      className={`border rounded-2xl p-4 ${
        isSelected ? 'border-primary bg-primary/5' : 'border-border/30'
      }`}
    >
      <View className="flex-row items-center gap-3">
        <View className={`w-12 h-12 rounded-2xl items-center justify-center ${
          isSelected ? 'bg-primary/20' : 'bg-muted/20'
        }`}>
          <Icon as={icon} size={20} className={isSelected ? 'text-primary' : 'text-muted-foreground'} />
        </View>
        <View className="flex-1">
          <Text className="font-roobert-medium text-foreground">
            {title}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {description}
          </Text>
        </View>
      </View>
      {children}
    </AnimatedPressable>
  );
});
