import * as React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, TextInput, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
  Plus,
  Check,
  X,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import {
  useCreateComposioProfile,
  useComposioProfiles,
  useComposioToolkitDetails,
  useCheckProfileNameAvailability,
  type ComposioApp,
  type ComposioProfile,
} from '@/hooks/useComposio';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';
import * as WebBrowser from 'expo-web-browser';
import { ToolkitIcon } from './ToolkitIcon';

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
  const { colorScheme } = useColorScheme();

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
        if (mode === 'full' && agentId && onNavigateToTools) {
          onNavigateToTools(app, profile);
        } else {
          onComplete(profile.profile_id, app.name, app.slug);
        }
      }
    }
  }, [selectedConnectionType, selectedProfileId, existingProfiles, mode, agentId, onComplete, app, onNavigateToTools]);

  const handleCreateProfile = () => {
    if (!profileName.trim()) {
      Alert.alert('Error', 'Profile name is required');
      return;
    }

    if (nameAvailability && !nameAvailability.available) {
      Alert.alert('Error', 'This profile name is already in use. Please choose a different name.');
      return;
    }

    console.log('🚀 Creating profile:', profileName, 'for app:', app.slug);

    createProfile({
      toolkit_slug: app.slug,
      profile_name: profileName,
      initiation_fields: Object.keys(initiationFields).length > 0 ? initiationFields : undefined,
      custom_auth_config: useCustomAuth && Object.keys(customAuthConfig).length > 0 ? customAuthConfig : undefined,
      use_custom_auth: useCustomAuth,
    }, {
      onSuccess: (response) => {
        console.log('✅ Profile created successfully:', response);
        setCreatedProfileId(response.profile_id);

        if (response.redirect_url) {
          console.log('🌐 Opening OAuth redirect:', response.redirect_url);
          setRedirectUrl(response.redirect_url);
          setCurrentStep(Step.Connecting);

          // Open browser for OAuth authentication
          WebBrowser.openBrowserAsync(response.redirect_url, {
            presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
            showTitle: true,
            controlsColor: '#000000',
            dismissButtonStyle: 'close',
          }).then((result) => {
            console.log('🔄 WebBrowser result:', result);

            if (result.type === 'dismiss' || result.type === 'cancel') {
              // User closed browser, assume auth completed
              handleAuthComplete();
            }
          });
        } else {
          // No OAuth required, direct success
          setCurrentStep(Step.Success);
          setTimeout(() => {
            onComplete(response.profile_id, app.name, app.slug);
          }, 1500);
        }
      },
      onError: (error: any) => {
        console.error('❌ Profile creation failed:', error);
        Alert.alert('Error', error.message || 'Failed to create profile');
      }
    });
  };

  const handleAuthComplete = () => {
    console.log('✅ Authentication completed for profile:', createdProfileId);

    if (createdProfileId) {
      if (mode === 'full' && agentId && onNavigateToTools) {
        // Navigate to tools selection
        const newProfile = {
          profile_id: createdProfileId,
          profile_name: profileName,
          display_name: profileName,
          toolkit_name: app.name,
          toolkit_slug: app.slug,
          mcp_url: '',
          is_connected: true,
          is_default: false,
          connection_status: 'active' as const,
          created_at: new Date().toISOString(),
        };
        onNavigateToTools(app, newProfile);
      } else {
        setCurrentStep(Step.Success);
        setTimeout(() => {
          onComplete(createdProfileId, app.name, app.slug);
        }, 1500);
      }
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
      default:
        onBack?.();
        break;
    }
  };

  if (currentStep === Step.ProfileSelect) {
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
              {app.name}
            </Text>
            <Text
              style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
              className="text-sm font-roobert"
            >
              {existingProfiles.length > 0 ? t('integrations.connector.selectConnection') : t('integrations.connector.createFirstConnection')}
            </Text>
          </View>
        </View>

        <View className={noPadding ? "" : "px-0"}>

          <View className="space-y-3 mb-8">
            {existingProfiles.map((profile: ComposioProfile) => (
              <ProfileListItem
                key={profile.profile_id}
                profile={profile}
                isSelected={selectedProfileId === profile.profile_id && selectedConnectionType === 'existing'}
                onPress={() => {
                  setSelectedConnectionType('existing');
                  setSelectedProfileId(profile.profile_id);
                }}
              />
            ))}

            <Pressable
              onPress={() => {
                setSelectedConnectionType('new');
                setSelectedProfileId('new');
              }}
              className={`flex-row items-center p-4 rounded-3xl active:opacity-80 ${selectedConnectionType === 'new'
                ? 'bg-primary/10'
                : 'bg-muted/5'
                }`}
            >
              <View className={`w-10 h-10 rounded-xl items-center justify-center ${selectedConnectionType === 'new' ? 'bg-primary' : 'bg-muted/30'
                }`}>
                <Icon as={Plus} size={20} className={selectedConnectionType === 'new' ? 'text-primary-foreground' : 'text-muted-foreground'} strokeWidth={2.5} />
              </View>
              <View className="flex-1 ml-3">
                <Text className="text-base font-roobert-semibold text-foreground">
                  {t('integrations.connector.createNewConnection')}
                </Text>
              </View>
              {selectedConnectionType === 'new' && (
                <View className="w-5 h-5 rounded-full bg-primary items-center justify-center">
                  <Icon as={Check} size={14} className="text-primary-foreground" strokeWidth={3} />
                </View>
              )}
            </Pressable>
          </View>

          <ContinueButton
            onPress={handleMainAction}
            disabled={!selectedConnectionType || (selectedConnectionType === 'existing' && !selectedProfileId)}
            label={selectedConnectionType === 'new' ? t('integrations.connector.continue') :
              selectedConnectionType === 'existing' && selectedProfileId ?
                t('integrations.connector.continue') :
                t('integrations.connector.selectAnOption')}
          />
        </View>
      </View>
    );
  }

  if (currentStep === Step.ProfileCreate) {
    return (
      <View className={noPadding ? "pb-6" : "pb-6"}>
        {/* Header with back button, title, and description */}
        <View className="flex-row items-center mb-4">
          <Pressable
            onPress={handleBack}
            className="flex-row items-center active:opacity-70"
          >
            <ArrowLeft
              size={20}
              color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'}
            />
          </Pressable>
          <View className="flex-1 ml-3">
            <Text
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="text-xl font-roobert-semibold"
            >
              {app.name}
            </Text>
            <Text
              style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
              className="text-sm font-roobert"
            >
              {t('integrations.connector.chooseNameForConnection')}
            </Text>
          </View>
        </View>

        <View className={noPadding ? "" : "px-0"}>

          <View className="mb-8">
            <Text className="text-sm font-roobert-medium text-muted-foreground mb-3 uppercase tracking-wider">
              {t('integrations.connector.profileName')}
            </Text>
            <View className="relative">
              <TextInput
                value={profileName}
                onChangeText={setProfileName}
                placeholder={t('integrations.connector.profileNamePlaceholder', { app: app.name })}
                className={`bg-muted/5 rounded-2xl px-4 py-4 text-base font-roobert text-foreground pr-12 ${nameAvailability && !nameAvailability.available ? 'border-2 border-red-500/50' :
                  nameAvailability && nameAvailability.available && profileName.length > 0 ? 'border border-border/40' :
                    'border border-border/40'
                  }`}
                placeholderTextColor="rgba(156, 163, 175, 0.5)"
                autoFocus
              />
              <View className="absolute right-4 top-1/2 -translate-y-1/2">
                {isCheckingName && profileName.length > 0 && (
                  <ActivityIndicator size="small" color="#999" />
                )}
                {!isCheckingName && nameAvailability && profileName.length > 0 && (
                  nameAvailability.available ? (
                    <View className="w-6 h-6 rounded-full bg-green-500/10 items-center justify-center">
                      <Icon as={Check} size={16} className="text-green-600" strokeWidth={2.5} />
                    </View>
                  ) : (
                    <View className="w-6 h-6 rounded-full bg-red-500/10 items-center justify-center">
                      <Icon as={X} size={16} className="text-red-600" strokeWidth={2.5} />
                    </View>
                  )
                )}
              </View>
            </View>

            {nameAvailability && !nameAvailability.available && (
              <View className="mt-3">
                <Text className="text-sm font-roobert text-red-600 mb-2">
                  {t('integrations.connector.nameAlreadyTaken')}
                </Text>
                {nameAvailability.suggestions.length > 0 && (
                  <View className="flex-row flex-wrap gap-2">
                    {nameAvailability.suggestions.map((suggestion: string) => (
                      <Pressable
                        key={suggestion}
                        onPress={() => setProfileName(suggestion)}
                        className="px-3 py-1.5 bg-muted/10 border border-border/40 rounded-full active:opacity-70"
                      >
                        <Text className="text-xs font-roobert-medium text-foreground">
                          {suggestion}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>

          <ContinueButton
            onPress={handleCreateProfile}
            disabled={
              isCreating ||
              isLoadingToolkitDetails ||
              !profileName.trim() ||
              isCheckingName ||
              (nameAvailability && !nameAvailability.available)
            }
            isLoading={isCreating}
            label={isCreating ? t('integrations.connector.creating') : t('integrations.connector.continue')}
            rounded="2xl"
          />
        </View>
      </View>
    );
  }

  if (currentStep === Step.Connecting) {
    return (
      <View className={noPadding ? "pb-6" : "pb-6"}>
        <View className="items-center pt-12 pb-12">
          <View className="w-20 h-20 rounded-2xl bg-muted/5 border border-border/40 items-center justify-center mb-6">
            <Icon as={ExternalLink} size={40} className="text-foreground" strokeWidth={2} />
          </View>
          <Text className="text-2xl font-roobert-bold text-foreground mb-2 text-center">
            {t('integrations.connector.completeInBrowser')}
          </Text>
          <Text className="text-base font-roobert text-muted-foreground text-center mb-8 px-8 leading-relaxed">
            {t('integrations.connector.authenticateInstructions')}
          </Text>

          {redirectUrl && (
            <Pressable
              onPress={() => redirectUrl && WebBrowser.openBrowserAsync(redirectUrl)}
              className="mb-6 active:opacity-70"
            >
              <Text className="text-sm font-roobert-medium text-foreground underline">
                {t('integrations.connector.reopenBrowser')}
              </Text>
            </Pressable>
          )}

          <ContinueButton
            onPress={handleAuthComplete}
            label={t('integrations.connector.completedAuthentication')}
          />

          <Pressable
            onPress={handleBack}
            className="py-2 mt-4 active:opacity-70"
          >
            <Text className="text-sm font-roobert text-muted-foreground">
              {t('integrations.connector.goBack')}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (currentStep === Step.Success) {
    return (
      <View className={noPadding ? "pb-6" : "pb-6"}>
        <View className="items-center pt-16 pb-12">
          <View className="w-20 h-20 rounded-full bg-green-500/10 items-center justify-center mb-6">
            <Icon as={CheckCircle2} size={44} className="text-green-600" strokeWidth={2} />
          </View>
          <Text className="text-2xl font-roobert-bold text-foreground mb-2">
            {t('integrations.connector.allSet')}
          </Text>
          <Text className="text-base font-roobert text-muted-foreground text-center px-8">
            {t('integrations.connector.connectionReady', { app: app.name })}
          </Text>
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
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();

  if (!visible) return null;

  return (
    <View className="flex-1">
      <View className="px-6 pt-6">
        {/* Header with back button */}
        <View className="flex-row items-center mb-4">
          <Pressable
            onPress={onClose}
            className="flex-row items-center active:opacity-70"
          >
            <ArrowLeft
              size={20}
              color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'}
            />
          </Pressable>
          <View className="flex-1 ml-3">
            <Text
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="text-xl font-roobert-semibold"
            >
              {t('integrations.connector.connectTo', { app: app.name })}
            </Text>
          </View>
        </View>
      </View>

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

interface ContinueButtonProps {
  onPress: () => void;
  disabled?: boolean;
  label: string;
  isLoading?: boolean;
  rounded?: 'full' | '2xl';
}

const ContinueButton = React.memo(({
  onPress,
  disabled = false,
  label,
  isLoading = false,
}: ContinueButtonProps) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = React.useCallback(() => {
    if (!disabled) {
      scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
    }
  }, [scale, disabled]);

  const handlePressOut = React.useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  }, [scale]);

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      disabled={disabled}
      className={`w-full py-4 items-center rounded-full ${disabled ? 'bg-muted/20' : 'bg-foreground'
        }`}
    >
      <View className="flex-row items-center gap-2">
        {isLoading && <ActivityIndicator size="small" color="#fff" />}
        <Text className={`text-base font-roobert-semibold ${disabled ? 'text-muted-foreground' : 'text-background'
          }`}>
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
});

interface ProfileListItemProps {
  profile: ComposioProfile;
  isSelected: boolean;
  onPress: () => void;
}

const ProfileListItem = React.memo(({ profile, isSelected, onPress }: ProfileListItemProps) => {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center p-4 rounded-3xl active:opacity-80 mb-2 ${isSelected
        ? 'bg-primary/10'
        : 'bg-muted/5'
        }`}
    >
      <View className={`w-10 h-10 rounded-xl items-center justify-center ${isSelected ? 'bg-primary' : 'bg-muted/30'
        }`}>
        <Icon as={CheckCircle2} size={20} className={isSelected ? 'text-primary-foreground' : 'text-muted-foreground'} strokeWidth={2.5} />
      </View>
      <View className="flex-1 ml-3">
        <Text className="text-base font-roobert-semibold text-foreground">
          {profile.profile_name}
        </Text>
      </View>
      {isSelected && (
        <View className="w-5 h-5 rounded-full bg-primary items-center justify-center">
          <Icon as={Check} size={14} className="text-primary-foreground" strokeWidth={3} />
        </View>
      )}
    </Pressable>
  );
});
