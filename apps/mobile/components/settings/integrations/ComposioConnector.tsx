import * as React from 'react';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  TextInput,
  Alert,
  Switch,
} from 'react-native';
import { BottomSheetFlatList, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
  Plus,
  Check,
  X,
  Settings,
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
import * as WebBrowser from 'expo-web-browser';
import { ToolkitIcon } from './ToolkitIcon';
import { log } from '@/lib/logger';

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
  isSaving?: boolean;
  useBottomSheetFlatList?: boolean;
}

enum Step {
  ProfileSelect = 'profile-select',
  ProfileCreate = 'profile-create',
  Connecting = 'connecting',
  Success = 'success',
}

const CUSTOM_OAUTH_REQUIRED_APPS = ['zendesk'];

export function ComposioConnectorContent({
  app,
  onBack,
  onComplete,
  onNavigateToTools,
  mode = 'full',
  agentId,
  noPadding = false,
  isSaving = false,
  useBottomSheetFlatList = false,
}: ComposioConnectorContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();

  const [currentStep, setCurrentStep] = React.useState<Step>(Step.ProfileSelect);
  const [profileName, setProfileName] = React.useState(`${app.name} Profile`);
  const [selectedProfileId, setSelectedProfileId] = React.useState<string>('');
  const [createdProfileId, setCreatedProfileId] = React.useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = React.useState<ComposioProfile | null>(null);
  const [redirectUrl, setRedirectUrl] = React.useState<string | null>(null);
  const [selectedConnectionType, setSelectedConnectionType] = React.useState<
    'existing' | 'new' | null
  >(null);

  const [initiationFields, setInitiationFields] = React.useState<Record<string, string>>({});
  const [initiationFieldsErrors, setInitiationFieldsErrors] = React.useState<
    Record<string, string>
  >({});

  const [useCustomAuth, setUseCustomAuth] = React.useState(false);
  const [customAuthConfig, setCustomAuthConfig] = React.useState<Record<string, string>>({});
  const [customAuthConfigErrors, setCustomAuthConfigErrors] = React.useState<
    Record<string, string>
  >({});

  const { mutate: createProfile, isPending: isCreating } = useCreateComposioProfile();
  const { data: profiles, isLoading: isLoadingProfiles } = useComposioProfiles();

  const { data: toolkitDetails, isLoading: isLoadingToolkitDetails } = useComposioToolkitDetails(
    app.slug
  );

  const { data: nameAvailability, isLoading: isCheckingName } = useCheckProfileNameAvailability(
    app.slug,
    profileName,
    {
      enabled: currentStep === Step.ProfileCreate && profileName.length > 0,
      debounceMs: 500,
    }
  );

  const existingProfiles =
    profiles?.filter((p: ComposioProfile) => p.toolkit_slug === app.slug && p.is_connected) || [];

  const handleInitiationFieldChange = React.useCallback(
    (fieldName: string, value: string) => {
      setInitiationFields((prev) => ({ ...prev, [fieldName]: value }));
      if (initiationFieldsErrors[fieldName]) {
        setInitiationFieldsErrors((prev) => ({ ...prev, [fieldName]: '' }));
      }
    },
    [initiationFieldsErrors]
  );

  const validateInitiationFields = React.useCallback((): boolean => {
    const newErrors: Record<string, string> = {};
    const initiationRequirements = toolkitDetails?.toolkit.connected_account_initiation_fields;

    if (initiationRequirements?.required) {
      for (const field of initiationRequirements.required) {
        if (field.required) {
          const value = initiationFields[field.name];
          const isEmpty = !value || value.trim() === '';

          if (field.type?.toLowerCase() === 'boolean') {
            continue;
          }

          if (
            (field.type?.toLowerCase() === 'number' || field.type?.toLowerCase() === 'double') &&
            value
          ) {
            if (isNaN(Number(value))) {
              newErrors[field.name] = `${field.displayName} must be a valid number`;
              continue;
            }
          }

          if (isEmpty) {
            newErrors[field.name] = `${field.displayName} is required`;
          }
        }
      }
    }

    setInitiationFieldsErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [toolkitDetails, initiationFields]);

  const handleCustomAuthFieldChange = React.useCallback(
    (fieldName: string, value: string) => {
      setCustomAuthConfig((prev) => ({ ...prev, [fieldName]: value }));
      if (customAuthConfigErrors[fieldName]) {
        setCustomAuthConfigErrors((prev) => ({ ...prev, [fieldName]: '' }));
      }
    },
    [customAuthConfigErrors]
  );

  const validateCustomAuthFields = React.useCallback((): boolean => {
    if (!useCustomAuth) return true;

    const newErrors: Record<string, string> = {};
    const authConfigDetails = toolkitDetails?.toolkit.auth_config_details?.[0];
    const authConfigFields = authConfigDetails?.fields?.auth_config_creation;

    if (authConfigFields?.required) {
      for (const field of authConfigFields.required) {
        if (field.required) {
          const value = customAuthConfig[field.name];
          const isEmpty = !value || value.trim() === '';

          if (isEmpty) {
            newErrors[field.name] = `${field.displayName} is required`;
          }
        }
      }
    }

    setCustomAuthConfigErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [useCustomAuth, toolkitDetails, customAuthConfig]);

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
      const profile = existingProfiles.find(
        (p: ComposioProfile) => p.profile_id === selectedProfileId
      );
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
  }, [
    selectedConnectionType,
    selectedProfileId,
    existingProfiles,
    mode,
    agentId,
    onComplete,
    app,
    onNavigateToTools,
  ]);

  const handleCreateProfile = () => {
    if (!profileName.trim()) {
      Alert.alert('Error', 'Profile name is required');
      return;
    }

    if (nameAvailability && !nameAvailability.available) {
      Alert.alert('Error', 'This profile name is already in use. Please choose a different name.');
      return;
    }

    if (!validateCustomAuthFields()) {
      Alert.alert('Error', 'Please fill in all required OAuth configuration fields');
      return;
    }

    if (!validateInitiationFields()) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    log.log('🚀 Creating profile:', profileName, 'for app:', app.slug);

    createProfile(
      {
        toolkit_slug: app.slug,
        profile_name: profileName,
        initiation_fields: Object.keys(initiationFields).length > 0 ? initiationFields : undefined,
        custom_auth_config:
          useCustomAuth && Object.keys(customAuthConfig).length > 0 ? customAuthConfig : undefined,
        use_custom_auth: useCustomAuth,
      },
      {
        onSuccess: (response) => {
          log.log('✅ Profile created successfully:', response);
          setCreatedProfileId(response.profile_id);

          if (response.redirect_url) {
            log.log('🌐 Opening OAuth redirect:', response.redirect_url);
            setRedirectUrl(response.redirect_url);
            setCurrentStep(Step.Connecting);

            // Open browser for OAuth authentication
            WebBrowser.openBrowserAsync(response.redirect_url, {
              presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
              showTitle: true,
              controlsColor: '#000000',
              dismissButtonStyle: 'close',
            }).then((result) => {
              log.log('🔄 WebBrowser result:', result);

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
          log.error('❌ Profile creation failed:', error);
          Alert.alert('Error', error.message || 'Failed to create profile');
        },
      }
    );
  };

  const handleAuthComplete = () => {
    log.log('✅ Authentication completed for profile:', createdProfileId);

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

  // Prepare list data
  const listData = React.useMemo(() => {
    const items: Array<ComposioProfile | { type: 'new' }> = [...existingProfiles];
    items.push({ type: 'new' } as any);
    return items;
  }, [existingProfiles]);

  if (currentStep === Step.ProfileSelect) {
    // When using BottomSheetFlatList, render with fixed header and footer
    if (useBottomSheetFlatList) {
      return (
        <View style={{ flex: 1 }}>
          {/* Fixed header */}
          <View
            style={{
              paddingHorizontal: 24,
              paddingTop: 16,
              paddingBottom: 16,
              backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
            }}>
            <Text
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="mb-1 font-roobert-semibold text-xl">
              {app.name}
            </Text>
            <Text
              style={{
                color:
                  colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
              }}
              className="font-roobert text-sm">
              {existingProfiles.length > 0
                ? t('integrations.connector.selectConnection')
                : t('integrations.connector.createFirstConnection')}
            </Text>
          </View>

          {/* Scrollable list */}
          <BottomSheetFlatList
            data={listData}
            style={{ flex: 1 }}
            keyExtractor={(item: any, index: number) =>
              item.type === 'new' ? 'new-connection' : item.profile_id || `profile-${index}`
            }
            renderItem={({ item }: { item: any }) => {
              if (item.type === 'new') {
                return (
                  <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
                    <Pressable
                      onPress={() => {
                        setSelectedConnectionType('new');
                        setSelectedProfileId('new');
                      }}
                      className={`flex-row items-center rounded-2xl p-4 active:opacity-80 ${
                        selectedConnectionType === 'new' ? 'bg-primary/10' : 'bg-muted/5'
                      }`}>
                      <View
                        className={`h-10 w-10 items-center justify-center rounded-xl ${
                          selectedConnectionType === 'new' ? 'bg-primary' : 'bg-muted/30'
                        }`}>
                        <Icon
                          as={Plus}
                          size={20}
                          className={
                            selectedConnectionType === 'new'
                              ? 'text-primary-foreground'
                              : 'text-muted-foreground'
                          }
                          strokeWidth={2.5}
                        />
                      </View>
                      <View className="ml-3 flex-1">
                        <Text className="font-roobert-semibold text-base text-foreground">
                          {t('integrations.connector.createNewConnection')}
                        </Text>
                      </View>
                      {selectedConnectionType === 'new' && (
                        <View className="h-5 w-5 items-center justify-center rounded-full bg-primary">
                          <Icon
                            as={Check}
                            size={14}
                            className="text-primary-foreground"
                            strokeWidth={3}
                          />
                        </View>
                      )}
                    </Pressable>
                  </View>
                );
              }

              return (
                <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
                  <ProfileListItem
                    profile={item}
                    isSelected={
                      selectedProfileId === item.profile_id && selectedConnectionType === 'existing'
                    }
                    onPress={() => {
                      setSelectedConnectionType('existing');
                      setSelectedProfileId(item.profile_id);
                    }}
                  />
                </View>
              );
            }}
            contentContainerStyle={{ paddingTop: 8, paddingBottom: 16, flexGrow: 1 }}
            showsVerticalScrollIndicator={false}
          />

          {/* Fixed footer button */}
          <View
            style={{
              paddingHorizontal: 24,
              paddingTop: 16,
              paddingBottom: 24,
              backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
            }}>
            <ContinueButton
              onPress={handleMainAction}
              disabled={
                isSaving ||
                !selectedConnectionType ||
                (selectedConnectionType === 'existing' && !selectedProfileId)
              }
              isLoading={isSaving}
              label={
                isSaving
                  ? t('integrations.connector.connecting')
                  : selectedConnectionType === 'new'
                    ? t('integrations.connector.continue')
                    : selectedConnectionType === 'existing' && selectedProfileId
                      ? t('integrations.connector.continue')
                      : t('integrations.connector.selectAnOption')
              }
            />
          </View>
        </View>
      );
    }

    // Regular scrollable view (for non-BottomSheet usage)
    return (
      <View className="mb-4 flex-1" style={{ flex: 1, position: 'relative' }}>
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
              {app.name}
            </Text>
            <Text
              style={{
                color:
                  colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
              }}
              className="font-roobert text-sm">
              {existingProfiles.length > 0
                ? t('integrations.connector.selectConnection')
                : t('integrations.connector.createFirstConnection')}
            </Text>
          </View>
        </View>

        <View className={noPadding ? 'mb-4 flex-1' : 'mb-4 flex-1 px-0'}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="space-y-3">
              {existingProfiles.map((profile: ComposioProfile) => (
                <ProfileListItem
                  key={profile.profile_id}
                  profile={profile}
                  isSelected={
                    selectedProfileId === profile.profile_id &&
                    selectedConnectionType === 'existing'
                  }
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
                className={`flex-row items-center rounded-3xl p-4 active:opacity-80 ${
                  selectedConnectionType === 'new' ? 'bg-primary/10' : 'bg-muted/5'
                }`}>
                <View
                  className={`h-10 w-10 items-center justify-center rounded-xl ${
                    selectedConnectionType === 'new' ? 'bg-primary' : 'bg-muted/30'
                  }`}>
                  <Icon
                    as={Plus}
                    size={20}
                    className={
                      selectedConnectionType === 'new'
                        ? 'text-primary-foreground'
                        : 'text-muted-foreground'
                    }
                    strokeWidth={2.5}
                  />
                </View>
                <View className="ml-3 flex-1">
                  <Text className="font-roobert-semibold text-base text-foreground">
                    {t('integrations.connector.createNewConnection')}
                  </Text>
                </View>
                {selectedConnectionType === 'new' && (
                  <View className="h-5 w-5 items-center justify-center rounded-full bg-primary">
                    <Icon
                      as={Check}
                      size={14}
                      className="text-primary-foreground"
                      strokeWidth={3}
                    />
                  </View>
                )}
              </Pressable>
            </View>
          </ScrollView>
        </View>

        {/* Sticky button at bottom */}
        <View>
          <ContinueButton
            onPress={handleMainAction}
            disabled={
              isSaving ||
              !selectedConnectionType ||
              (selectedConnectionType === 'existing' && !selectedProfileId)
            }
            isLoading={isSaving}
            label={
              isSaving
                ? t('integrations.connector.connecting')
                : selectedConnectionType === 'new'
                  ? t('integrations.connector.continue')
                  : selectedConnectionType === 'existing' && selectedProfileId
                    ? t('integrations.connector.continue')
                    : t('integrations.connector.selectAnOption')
            }
          />
        </View>
      </View>
    );
  }

  if (currentStep === Step.ProfileCreate) {
    // Content for profile creation form
    const profileCreateContent = (
      <>
        <View className="mb-8">
          <Text className="mb-3 font-roobert-medium text-sm uppercase tracking-wider text-muted-foreground">
            {t('integrations.connector.profileName')}
          </Text>
          <View className="relative">
            <TextInput
              value={profileName}
              onChangeText={setProfileName}
              placeholder={t('integrations.connector.profileNamePlaceholder', { app: app.name })}
              className={`rounded-2xl bg-muted/5 px-4 py-4 pr-12 font-roobert text-base text-foreground ${
                nameAvailability && !nameAvailability.available
                  ? 'border-2 border-red-500/50'
                  : nameAvailability && nameAvailability.available && profileName.length > 0
                    ? 'border border-border/40'
                    : 'border border-border/40'
              }`}
              placeholderTextColor="rgba(156, 163, 175, 0.5)"
              autoFocus
            />
            <View className="absolute right-4 top-1/2 -translate-y-1/2">
              {isCheckingName && profileName.length > 0 && (
                <ActivityIndicator size="small" color="#999" />
              )}
              {!isCheckingName &&
                nameAvailability &&
                profileName.length > 0 &&
                (nameAvailability.available ? (
                  <View className="h-6 w-6 items-center justify-center rounded-full bg-green-500/10">
                    <Icon as={Check} size={16} className="text-green-600" strokeWidth={2.5} />
                  </View>
                ) : (
                  <View className="h-6 w-6 items-center justify-center rounded-full bg-red-500/10">
                    <Icon as={X} size={16} className="text-red-600" strokeWidth={2.5} />
                  </View>
                ))}
            </View>
          </View>

          {nameAvailability && !nameAvailability.available && (
            <View className="mt-3">
              <Text className="mb-2 font-roobert text-sm text-red-600">
                {t('integrations.connector.nameAlreadyTaken')}
              </Text>
              {nameAvailability.suggestions.length > 0 && (
                <View className="flex-row flex-wrap gap-2">
                  {nameAvailability.suggestions.map((suggestion: string) => (
                    <Pressable
                      key={suggestion}
                      onPress={() => setProfileName(suggestion)}
                      className="rounded-full border border-border/40 bg-muted/10 px-3 py-1.5 active:opacity-70">
                      <Text className="font-roobert-medium text-xs text-foreground">
                        {suggestion}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}
        </View>

        {/* Initiation Fields */}
        {!isLoadingToolkitDetails &&
          toolkitDetails?.toolkit.connected_account_initiation_fields?.required?.length > 0 && (
            <View className="mb-8">
              <View className="mb-4 flex-row items-center">
                <Icon as={Settings} size={14} className="mr-1.5 text-muted-foreground" />
                <Text className="font-roobert-medium text-sm text-foreground">
                  Connection Details
                </Text>
              </View>
              <View className="space-y-4">
                {toolkitDetails.toolkit.connected_account_initiation_fields.required.map(
                  (field: any) => {
                    const fieldType = field.type?.toLowerCase() || 'string';
                    const isBoolean = fieldType === 'boolean';
                    const isNumber = fieldType === 'number' || fieldType === 'double';

                    return (
                      <View key={field.name} className="space-y-1">
                        <Text className="font-roobert-medium text-xs text-foreground">
                          {field.displayName}
                          {field.required && <Text className="ml-1 text-red-500">*</Text>}
                        </Text>

                        {isBoolean ? (
                          <View className="flex-row items-center">
                            <Switch
                              value={initiationFields[field.name] === 'true'}
                              onValueChange={(checked) =>
                                handleInitiationFieldChange(field.name, checked ? 'true' : 'false')
                              }
                              trackColor={{
                                false: '#e5e7eb',
                                true: '#3b82f6',
                              }}
                              thumbColor="#ffffff"
                            />
                            <Text className="ml-3 font-roobert text-xs text-muted-foreground">
                              {field.description || 'Enable'}
                            </Text>
                          </View>
                        ) : (
                          <>
                            <TextInput
                              value={initiationFields[field.name] || ''}
                              onChangeText={(value) =>
                                handleInitiationFieldChange(field.name, value)
                              }
                              placeholder={
                                field.default ||
                                field.description ||
                                `Enter ${field.displayName.toLowerCase()}`
                              }
                              className={`rounded-2xl border bg-muted/5 px-4 py-4 font-roobert text-base text-foreground ${
                                initiationFieldsErrors[field.name]
                                  ? 'border-red-500/50'
                                  : 'border-border/40'
                              }`}
                              placeholderTextColor="rgba(156, 163, 175, 0.5)"
                              secureTextEntry={fieldType === 'password'}
                              keyboardType={
                                fieldType === 'email'
                                  ? 'email-address'
                                  : fieldType === 'url'
                                    ? 'url'
                                    : isNumber
                                      ? 'numeric'
                                      : 'default'
                              }
                            />
                            {field.description && (
                              <Text className="mt-1 font-roobert text-[10px] text-muted-foreground">
                                {field.description}
                              </Text>
                            )}
                          </>
                        )}

                        {initiationFieldsErrors[field.name] && (
                          <Text className="font-roobert text-[10px] text-red-600">
                            {initiationFieldsErrors[field.name]}
                          </Text>
                        )}
                      </View>
                    );
                  }
                )}
              </View>
            </View>
          )}

        {/* Custom Auth Config Fields */}
        {useCustomAuth &&
          !isLoadingToolkitDetails &&
          toolkitDetails?.toolkit.auth_config_details?.[0]?.fields?.auth_config_creation?.required
            ?.length > 0 && (
            <View className="mb-8">
              <View className="mb-4 flex-row items-center">
                <Icon as={Settings} size={14} className="mr-1.5 text-muted-foreground" />
                <Text className="font-roobert-medium text-sm text-foreground">
                  OAuth Configuration
                </Text>
              </View>
              <View className="space-y-4">
                {toolkitDetails.toolkit.auth_config_details[0].fields.auth_config_creation.required.map(
                  (field: any) => {
                    const fieldType = field.type?.toLowerCase() || 'string';
                    const isNumber = fieldType === 'number' || fieldType === 'double';

                    return (
                      <View key={field.name} className="space-y-1">
                        <Text className="font-roobert-medium text-xs text-foreground">
                          {field.displayName}
                          {field.required && <Text className="ml-1 text-red-500">*</Text>}
                        </Text>
                        <TextInput
                          value={customAuthConfig[field.name] || ''}
                          onChangeText={(value) => handleCustomAuthFieldChange(field.name, value)}
                          placeholder={
                            field.default ||
                            field.description ||
                            `Enter ${field.displayName.toLowerCase()}`
                          }
                          className={`rounded-2xl border bg-muted/5 px-4 py-4 font-roobert text-base text-foreground ${
                            customAuthConfigErrors[field.name]
                              ? 'border-red-500/50'
                              : 'border-border/40'
                          }`}
                          placeholderTextColor="rgba(156, 163, 175, 0.5)"
                          secureTextEntry={fieldType === 'password'}
                          keyboardType={
                            fieldType === 'email'
                              ? 'email-address'
                              : fieldType === 'url'
                                ? 'url'
                                : isNumber
                                  ? 'numeric'
                                  : 'default'
                          }
                        />
                        {field.description && (
                          <Text className="mt-1 font-roobert text-[10px] text-muted-foreground">
                            {field.description}
                          </Text>
                        )}
                        {customAuthConfigErrors[field.name] && (
                          <Text className="font-roobert text-[10px] text-red-600">
                            {customAuthConfigErrors[field.name]}
                          </Text>
                        )}
                      </View>
                    );
                  }
                )}
              </View>
            </View>
          )}

        {isLoadingToolkitDetails && (
          <View className="mb-8">
            <ActivityIndicator size="small" color="#999" />
          </View>
        )}
      </>
    );

    // When using BottomSheetFlatList, use proper drawer layout
    if (useBottomSheetFlatList) {
      return (
        <View style={{ flex: 1 }}>
          {/* Fixed Header */}
          <View
            style={{
              paddingHorizontal: 24,
              paddingTop: 16,
              paddingBottom: 16,
              backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
            }}>
            <Text
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="mb-1 font-roobert-semibold text-xl">
              {app.name}
            </Text>
            <Text
              style={{
                color:
                  colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
              }}
              className="font-roobert text-sm">
              {t('integrations.connector.chooseNameForConnection')}
            </Text>
          </View>

          {/* Scrollable Content */}
          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}
            showsVerticalScrollIndicator={false}>
            {profileCreateContent}
          </BottomSheetScrollView>

          {/* Fixed Footer Button */}
          <View
            style={{
              paddingHorizontal: 24,
              paddingTop: 16,
              paddingBottom: 24,
              backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
            }}>
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
              label={
                isCreating
                  ? t('integrations.connector.creating')
                  : t('integrations.connector.continue')
              }
              rounded="2xl"
            />
          </View>
        </View>
      );
    }

    // Regular layout (non-drawer)
    return (
      <View className="mb-4">
        {/* Header with back button, title, and description */}
        <View className="mb-4 flex-row items-center">
          <Pressable onPress={handleBack} className="flex-row items-center active:opacity-70">
            <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
          </Pressable>
          <View className="ml-3 flex-1">
            <Text
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="font-roobert-semibold text-xl">
              {app.name}
            </Text>
            <Text
              style={{
                color:
                  colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
              }}
              className="font-roobert text-sm">
              {t('integrations.connector.chooseNameForConnection')}
            </Text>
          </View>
        </View>

        <View className={noPadding ? '' : 'px-0'}>
          {profileCreateContent}

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
            label={
              isCreating
                ? t('integrations.connector.creating')
                : t('integrations.connector.continue')
            }
            rounded="2xl"
          />
        </View>
      </View>
    );
  }

  if (currentStep === Step.Connecting) {
    const connectingContent = (
      <View
        className="items-center pb-12 pt-12"
        style={{ paddingHorizontal: useBottomSheetFlatList ? 24 : 0 }}>
        <View className="mb-6 h-20 w-20 items-center justify-center rounded-2xl border border-border/40 bg-muted/5">
          <Icon as={ExternalLink} size={40} className="text-foreground" strokeWidth={2} />
        </View>
        <Text className="mb-2 text-center font-roobert-bold text-2xl text-foreground">
          {t('integrations.connector.completeInBrowser')}
        </Text>
        <Text className="mb-8 px-8 text-center font-roobert text-base leading-relaxed text-muted-foreground">
          {t('integrations.connector.authenticateInstructions')}
        </Text>

        {redirectUrl && (
          <Pressable
            onPress={() => redirectUrl && WebBrowser.openBrowserAsync(redirectUrl)}
            className="mb-6 active:opacity-70">
            <Text className="font-roobert-medium text-sm text-foreground underline">
              {t('integrations.connector.reopenBrowser')}
            </Text>
          </Pressable>
        )}
      </View>
    );

    if (useBottomSheetFlatList) {
      return (
        <View style={{ flex: 1 }}>
          <View style={{ flex: 1, justifyContent: 'center' }}>{connectingContent}</View>

          {/* Fixed Footer Button */}
          <View
            style={{
              paddingHorizontal: 24,
              paddingTop: 16,
              paddingBottom: 24,
              backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
            }}>
            <ContinueButton
              onPress={handleAuthComplete}
              label={t('integrations.connector.completedAuthentication')}
            />
            <Pressable onPress={handleBack} className="mt-4 items-center py-2 active:opacity-70">
              <Text className="font-roobert text-sm text-muted-foreground">
                {t('integrations.connector.goBack')}
              </Text>
            </Pressable>
          </View>
        </View>
      );
    }

    return (
      <View className="mb-4">
        {connectingContent}

        <View style={{ paddingHorizontal: noPadding ? 0 : 24 }}>
          <ContinueButton
            onPress={handleAuthComplete}
            label={t('integrations.connector.completedAuthentication')}
          />

          <Pressable onPress={handleBack} className="mt-4 py-2 active:opacity-70">
            <Text className="font-roobert text-sm text-muted-foreground">
              {t('integrations.connector.goBack')}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (currentStep === Step.Success) {
    const successContent = (
      <View
        className="items-center pb-12 pt-16"
        style={{ paddingHorizontal: useBottomSheetFlatList ? 24 : 0 }}>
        <View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-green-500/10">
          <Icon as={CheckCircle2} size={44} className="text-green-600" strokeWidth={2} />
        </View>
        <Text className="mb-2 font-roobert-bold text-2xl text-foreground">
          {t('integrations.connector.allSet')}
        </Text>
        <Text className="px-8 text-center font-roobert text-base text-muted-foreground">
          {t('integrations.connector.connectionReady', { app: app.name })}
        </Text>
      </View>
    );

    if (useBottomSheetFlatList) {
      return <View style={{ flex: 1, justifyContent: 'center' }}>{successContent}</View>;
    }

    return <View className="mb-4">{successContent}</View>;
  }

  return null;
}

export function ComposioConnector({
  app,
  visible,
  onClose,
  onComplete,
  mode = 'full',
  agentId,
}: ComposioConnectorProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();

  if (!visible) return null;

  return (
    <View className="flex-1">
      <View className="px-6 pt-6">
        {/* Header with back button */}
        <View className="mb-4 flex-row items-center">
          <Pressable onPress={onClose} className="flex-row items-center active:opacity-70">
            <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
          </Pressable>
          <View className="ml-3 flex-1">
            <Text
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="font-roobert-semibold text-xl">
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

const ContinueButton = React.memo(
  ({
    onPress,
    disabled = false,
    label,
    isLoading = false,
    rounded = 'full',
  }: ContinueButtonProps) => {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        className={`flex-row items-center justify-center gap-2 rounded-xl p-4 ${
          disabled ? 'bg-primary/50 opacity-50' : 'bg-primary active:opacity-80'
        }`}>
        {isLoading ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
        <Text className="font-roobert-semibold text-base text-primary-foreground">{label}</Text>
      </Pressable>
    );
  }
);

interface ProfileListItemProps {
  profile: ComposioProfile;
  isSelected: boolean;
  onPress: () => void;
}

const ProfileListItem = React.memo(({ profile, isSelected, onPress }: ProfileListItemProps) => {
  return (
    <Pressable
      onPress={onPress}
      className={`mb-2 flex-row items-center rounded-2xl p-4 active:opacity-80 ${
        isSelected ? 'bg-primary/10' : 'bg-muted/5'
      }`}>
      <View
        className={`h-10 w-10 items-center justify-center rounded-xl ${
          isSelected ? 'bg-primary' : 'bg-muted/30'
        }`}>
        <Icon
          as={CheckCircle2}
          size={20}
          className={isSelected ? 'text-primary-foreground' : 'text-muted-foreground'}
          strokeWidth={2.5}
        />
      </View>
      <View className="ml-3 flex-1">
        <Text className="font-roobert-semibold text-base text-foreground">
          {profile.profile_name}
        </Text>
      </View>
      {isSelected && (
        <View className="h-5 w-5 items-center justify-center rounded-full bg-primary">
          <Icon as={Check} size={14} className="text-primary-foreground" strokeWidth={3} />
        </View>
      )}
    </Pressable>
  );
});
