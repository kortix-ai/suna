import * as React from 'react';
import { Pressable, View, TextInput, Alert, Keyboard, ScrollView, Linking } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Save, Mail, AlertTriangle, Bell } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { supabase } from '@/api/supabase';
import * as Haptics from 'expo-haptics';
import { KortixLoader } from '@/components/ui';
import { ProfilePicture } from './ProfilePicture';
import { useAuthDrawerStore } from '@/stores/auth-drawer-store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_URL, getAuthHeaders } from '@/api/config';
import { Switch, Platform } from 'react-native';
// import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export const placeholderImageUrl = 'https://i.ibb.co/ksprrY46/Screenshot-2025-11-12-at-2-28-27-AM.png';

interface NotificationSettings {
  email_enabled: boolean;
  push_enabled: boolean;
  in_app_enabled: boolean;
}
  
interface NameEditPageProps {
  visible: boolean;
  currentName: string;
  onClose: () => void;
  onNameUpdated?: (newName: string) => void;
  isGuestMode?: boolean;
}

export function NameEditPage({ 
  visible, 
  currentName, 
  onClose,
  onNameUpdated,
  isGuestMode = false
}: NameEditPageProps) {
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  
  const [name, setName] = React.useState(currentName);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<TextInput>(null);
  const [localSettings, setLocalSettings] = React.useState<NotificationSettings | null>(null);

  const { data: settings } = useQuery({
    queryKey: ['notification-settings'],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/notifications/settings`, {
        headers,
      });
      if (!response.ok) {
        throw new Error('Failed to fetch notification settings');
      }
      const data = await response.json();
      return data.settings;
    },
    enabled: visible && !isGuestMode,
  });

  React.useEffect(() => {
    if (settings) {
      setLocalSettings(settings);
    }
  }, [settings]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (updates: Partial<NotificationSettings>) => {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/notifications/settings`, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      });
      if (!response.ok) {
        throw new Error('Failed to update notification settings');
      }
      return response.json();
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
    },
    onError: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(t('common.error'), t('notifications.settingsFailed'));
      if (settings) {
        setLocalSettings(settings);
      }
    },
  });

  const registerDeviceTokenMutation = useMutation({
    mutationFn: async (token: string) => {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/notifications/device-token`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          device_token: token,
          device_type: Platform.OS,
          provider: 'fcm',
        }),
      });
      if (!response.ok) {
        throw new Error('Failed to register device token');
      }
      return response.json();
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(t('common.error'), t('notifications.deviceRegistrationFailed'));
    },
  });

  const handleNotificationToggle = React.useCallback(
    (key: keyof NotificationSettings, value: boolean) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      
      setLocalSettings(prev => prev ? { ...prev, [key]: value } : null);
      
      updateSettingsMutation.mutate({ [key]: value });

      if (key === 'push_enabled' && value && Device.isDevice) {
        // registerForPushNotifications();
      }
    },
    [updateSettingsMutation]
  );

  // const registerForPushNotifications = async () => {
  //   try {
  //     const { status: existingStatus } = await Notifications.getPermissionsAsync();
  //     let finalStatus = existingStatus;

  //     if (existingStatus !== 'granted') {
  //       const { status } = await Notifications.requestPermissionsAsync({
  //         ios: {
  //           allowAlert: true,
  //           allowBadge: true,
  //           allowSound: true,
  //         },
  //       });
  //       finalStatus = status;
  //     }

  //     if (finalStatus !== 'granted') {
  //       setLocalSettings(prev => prev ? { ...prev, push_enabled: false } : null);
        
  //       Alert.alert(
  //         t('notifications.permissionRequired'),
  //         t('notifications.permissionMessage'),
  //         [
  //           { 
  //             text: t('common.cancel'), 
  //             style: 'cancel',
  //             onPress: () => {
  //               updateSettingsMutation.mutate({ push_enabled: false });
  //             }
  //           },
  //           {
  //             text: t('notifications.openSettings'),
  //             onPress: () => {
  //               Linking.openSettings();
  //             },
  //           },
  //         ]
  //       );
  //       return;
  //     }

  //     if (Platform.OS === 'android') {
  //       await Notifications.setNotificationChannelAsync('default', {
  //         name: 'Default',
  //         importance: Notifications.AndroidImportance.MAX,
  //         vibrationPattern: [0, 250, 250, 250],
  //         lightColor: '#FF231F7C',
  //       });
  //     }

  //     const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  //     const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      
  //     registerDeviceTokenMutation.mutate(token);
  //   } catch (error) {
  //     console.error('Error registering for push notifications:', error);
  //     setLocalSettings(prev => prev ? { ...prev, push_enabled: false } : null);
  //     updateSettingsMutation.mutate({ push_enabled: false });
  //     Alert.alert(t('common.error'), t('notifications.deviceRegistrationFailed'));
  //   }
  // };
  

  React.useEffect(() => {
    if (visible) {
      setName(currentName);
      setError(null);
    }
  }, [visible, currentName]);
  
  const handleClose = () => {
    console.log('🎯 Name edit page closing');
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };
  
  const validateName = (name: string): string | null => {
    if (!name.trim()) {
      return t('nameEdit.nameRequired');
    }
    if (name.length > 100) {
      return t('nameEdit.nameTooLong');
    }
    return null;
  };
  
  const handleInputFocus = () => {
    if (isGuestMode) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      inputRef.current?.blur();
      useAuthDrawerStore.getState().openAuthDrawer({
        title: 'Sign up to continue',
        message: 'Create an account to customize your profile'
      });
    }
  };

  const handleSave = async () => {
    console.log('🎯 Save name pressed');
    
    if (isGuestMode) {
      handleInputFocus();
      return;
    }
    
    const trimmedName = name.trim();
    const validationError = validateName(trimmedName);
    
    if (validationError) {
      setError(validationError);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    
    if (trimmedName === currentName) {
      handleClose();
      return;
    }
    
    setIsLoading(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    try {
      console.log('📝 Updating user name');
      console.log('User ID:', user?.id);
      console.log('New name:', trimmedName);
      
      // Update user metadata using Supabase Auth
      const { data: updatedUser, error: updateError } = await supabase.auth.updateUser({
        data: {
          full_name: trimmedName,
        }
      });
      
      if (updateError) {
        throw updateError;
      }
      
      console.log('✅ Name updated successfully:', updatedUser);
      
      // Try to update the account table via RPC if it exists
      try {
        await supabase.rpc('update_account', {
          name: trimmedName,
          account_id: user?.id
        });
        console.log('✅ Account table also updated');
      } catch (rpcError) {
        console.warn('⚠️ RPC update failed (may not exist):', rpcError);
        // Ignore RPC errors - not all setups have this function
      }
      
      // Notify parent component
      onNameUpdated?.(trimmedName);
      
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      // Close page first
      handleClose();
      
      // Show success message after a short delay
      setTimeout(() => {
        Alert.alert(
          t('common.success'),
          t('nameEdit.nameUpdated')
        );
      }, 300);
    } catch (err: any) {
      console.error('❌ Failed to update name:', err);
      const errorMessage = err.message || t('nameEdit.failedToUpdate');
      setError(errorMessage);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      
      Alert.alert(
        t('common.error'),
        errorMessage
      );
    } finally {
      setIsLoading(false);
    }
  };
  
  if (!visible) return null;

  const hasChanges = name.trim() !== currentName && name.trim().length > 0;
  
  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView 
          className="flex-1"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          keyboardShouldPersistTaps="handled"
        >
          <SettingsHeader
            title={t('nameEdit.title')}
            onClose={handleClose}
            disabled={isLoading}
          />
          
          <View className="px-6 pb-8">
            <View className="mb-8 items-center pt-8">
              <ProfilePicture imageUrl={placeholderImageUrl} size={24} />
              <View className="mt-6 w-full">
                <TextInput
                  ref={inputRef}
                  value={name}
                  onChangeText={(text) => {
                    if (!isGuestMode) {
                      setName(text);
                      setError(null);
                    }
                  }}
                  onFocus={handleInputFocus}
                  placeholder={t('nameEdit.yourNamePlaceholder')}
                  placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
                  className="text-3xl font-roobert-semibold text-foreground text-center tracking-tight"
                  editable={!isLoading && !isGuestMode}
                  maxLength={100}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleSave}
                />
                <Text className="text-sm font-roobert text-muted-foreground text-center mt-2">
                  {t('nameEdit.displayName')}
                </Text>
              </View>
            </View>

            {error && (
              <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4 mb-6">
                <View className="flex-row items-start gap-2">
                  <Icon as={AlertTriangle} size={16} className="text-destructive mt-0.5" strokeWidth={2} />
                  <Text className="text-sm font-roobert-medium text-destructive flex-1">
                    {error}
                  </Text>
                </View>
              </View>
            )}

            <View className="mb-6">
              <View className="bg-primary/5 rounded-3xl p-5">
                <View className="flex-row items-center gap-3">
                  <View className="h-11 w-11 rounded-full bg-primary/10 items-center justify-center">
                    <Icon as={Mail} size={20} className="text-primary" strokeWidth={2.5} />
                  </View>
                  <View className="flex-1">
                    <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">
                      {t('nameEdit.emailAddress')}
                    </Text>
                    <Text className="text-sm font-roobert-semibold text-foreground">
                      {user?.email || t('nameEdit.notAvailable')}
                    </Text>
                  </View>
                </View>
              </View>
            </View>

            {!isGuestMode && localSettings && (
              <View className="mb-6">
                <View className="mb-4">
                  <View className="flex-row items-center gap-2 mb-2">
                    <Icon as={Bell} size={16} className="text-muted-foreground" strokeWidth={2} />
                    <Text className="text-sm font-roobert-semibold text-foreground">
                      {t('notifications.title')}
                    </Text>
                  </View>
                  <Text className="text-xs text-muted-foreground">
                    {t('notifications.description')}
                  </Text>
                </View>
                
                <View className="gap-3">
                  <NotificationToggle
                    label={t('notifications.emailNotifications')}
                    description={t('notifications.emailDescription')}
                    enabled={localSettings.email_enabled}
                    onToggle={(value) => handleNotificationToggle('email_enabled', value)}
                  />
                  <NotificationToggle
                    label={t('notifications.pushNotifications')}
                    description={t('notifications.pushDescription')}
                    enabled={localSettings.push_enabled}
                    onToggle={(value) => handleNotificationToggle('push_enabled', value)}
                  />
                  <NotificationToggle
                    label={t('notifications.inAppNotifications')}
                    description={t('notifications.inAppDescription')}
                    enabled={localSettings.in_app_enabled}
                    onToggle={(value) => handleNotificationToggle('in_app_enabled', value)}
                  />
                </View>
              </View>
            )}

            {!isGuestMode && (
              <SaveButton
                onPress={handleSave}
                disabled={!hasChanges || isLoading}
                isLoading={isLoading}
                hasChanges={hasChanges}
              />
            )}
          </View>
          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

interface SaveButtonProps {
  onPress: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  hasChanges?: boolean;
}

function SaveButton({ onPress, disabled, isLoading, hasChanges }: SaveButtonProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = () => {
    if (!disabled) {
      scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
    }
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };
  
  if (!hasChanges && !isLoading) {
    return null;
  }
  
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      disabled={disabled}
      className={`rounded-full items-center justify-center flex-row gap-2 px-6 py-4 ${
        disabled ? 'bg-muted/50' : 'bg-primary'
      }`}
    >
      {isLoading ? (
        <>
          <KortixLoader 
            size="small" 
            forceTheme={colorScheme === 'dark' ? 'dark' : 'light'}
          />
          <Text className="text-primary-foreground text-sm font-roobert-medium">
            {t('nameEdit.saving')}
          </Text>
        </>
      ) : (
        <>
          <Icon 
            as={Save} 
            size={16} 
            className="text-primary-foreground" 
            strokeWidth={2.5} 
          />
          <Text className="text-primary-foreground text-sm font-roobert-medium">
            {t('nameEdit.saveChanges')}
          </Text>
        </>
      )}
    </AnimatedPressable>
  );
}

interface NotificationToggleProps {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (value: boolean) => void;
}

function NotificationToggle({ label, description, enabled, onToggle }: NotificationToggleProps) {
  const { colorScheme } = useColorScheme();

  return (
    <View className="flex-row items-center justify-between py-3 border-b border-border">
      <View className="flex-1 pr-4">
        <Text className="text-sm font-roobert-medium text-foreground mb-0.5">
          {label}
        </Text>
        <Text className="text-xs font-roobert text-muted-foreground">
          {description}
        </Text>
      </View>
      <Switch
        value={enabled}
        onValueChange={onToggle}
        trackColor={{
          false: colorScheme === 'dark' ? '#3f3f46' : '#e4e4e7',
          true: colorScheme === 'dark' ? '#ffffff' : '#18181b',
        }}
        thumbColor={colorScheme === 'dark' ? '#18181b' : '#ffffff'}
        ios_backgroundColor={colorScheme === 'dark' ? '#3f3f46' : '#e4e4e7'}
      />
    </View>
  );
}
