import * as React from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Camera, ChevronRight, Globe, Mail, Trash2, User } from 'lucide-react-native';
import { useAuthContext, useLanguage } from '@/contexts';
import { supabase } from '@/api/supabase';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { ProfilePicture } from '@/components/settings/ProfilePicture';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetTextInput,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { getSheetBg } from '@/lib/theme-colors';

export default function GeneralSettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const { t } = useLanguage();
  const isDark = colorScheme === 'dark';
  const fgColor = isDark ? '#f8f8f8' : '#121215';

  const currentName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || '';
  const currentAvatar = user?.user_metadata?.avatar_url || '';

  const [displayName, setDisplayName] = React.useState(currentName);
  const [avatarUrl, setAvatarUrl] = React.useState(currentAvatar);
  const [isUploadingAvatar, setIsUploadingAvatar] = React.useState(false);
  const [isSavingName, setIsSavingName] = React.useState(false);
  const [editName, setEditName] = React.useState(currentName);
  const editProfileSheetRef = React.useRef<BottomSheetModal>(null);
  const snapPoints = React.useMemo(() => [280], []);
  const { data: deletionStatus } = useAccountDeletionStatus({ enabled: !!user });
  const trimmedEditName = editName.trim();
  const canSaveName = trimmedEditName.length > 0 && trimmedEditName !== displayName.trim();

  React.useEffect(() => {
    setDisplayName(currentName);
    setEditName(currentName);
  }, [currentName]);

  const pickAndUploadAvatar = React.useCallback(async () => {
    if (!user?.id || isUploadingAvatar) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== 'granted') {
      Alert.alert('Permission required', 'Please allow photo library access to update your avatar.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });

    if (result.canceled || !result.assets?.[0]?.uri) return;

    const uri = result.assets[0].uri;
    setIsUploadingAvatar(true);

    try {
      const response = await fetch(uri);
      const blob = await response.blob();
      const fileExt = (uri.split('.').pop() || 'jpg').toLowerCase();
      const filePath = `${user.id}-${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, blob, {
          cacheControl: '3600',
          upsert: true,
          contentType: result.assets[0].mimeType || 'image/jpeg',
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data } = supabase.storage.from('avatars').getPublicUrl(filePath);
      const publicUrl = data.publicUrl;

      const { error: userUpdateError } = await supabase.auth.updateUser({
        data: {
          full_name: displayName,
          avatar_url: publicUrl,
        },
      });

      if (userUpdateError) throw userUpdateError;

      setAvatarUrl(publicUrl);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error: any) {
      Alert.alert(t('common.error'), error?.message || 'Failed to update avatar');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsUploadingAvatar(false);
    }
  }, [displayName, isUploadingAvatar, t, user?.id]);

  const openEditProfileSheet = React.useCallback(() => {
    setEditName(displayName);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    editProfileSheetRef.current?.present();
  }, [displayName]);

  const handleSaveName = React.useCallback(async () => {
    const trimmed = editName.trim();
    if (!trimmed) {
      Alert.alert(t('common.error'), t('nameEdit.nameRequired'));
      return;
    }
    if (trimmed.length > 100) {
      Alert.alert(t('common.error'), t('nameEdit.nameTooLong'));
      return;
    }
    if (!user?.id) return;

    setIsSavingName(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        data: {
          full_name: trimmed,
          avatar_url: avatarUrl,
        },
      });
      if (updateError) throw updateError;

      try {
        await supabase.rpc('update_account', {
          name: trimmed,
          account_id: user.id,
        });
      } catch {
      }

      setDisplayName(trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      editProfileSheetRef.current?.dismiss();
    } catch (error: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(t('common.error'), error?.message || t('nameEdit.failedToUpdate'));
    } finally {
      setIsSavingName(false);
    }
  }, [avatarUrl, editName, t, user?.id]);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />
    ),
    [],
  );

  return (
    <>
      <ScrollView
        className="flex-1 bg-background"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="px-5 pt-1" style={{ gap: 18 }}>
        <View className="items-center pt-1">
          <Pressable
            onPress={pickAndUploadAvatar}
            disabled={isUploadingAvatar}
            className="active:opacity-85"
          >
            <View>
              <ProfilePicture
                imageUrl={avatarUrl}
                size={13}
                fallbackText={displayName || user?.email?.split('@')[0] || 'U'}
              />
              <View className="absolute bottom-[-2px] right-[-2px] h-7 w-7 items-center justify-center rounded-full border border-border/50 bg-card">
                <Icon as={Camera} size={12} className="text-foreground/70" strokeWidth={2.3} />
              </View>
            </View>
          </Pressable>
          <Text className="mt-2 font-roobert-medium text-[18px] text-foreground">{displayName}</Text>
          <Text className="mt-0.5 font-roobert text-[11px] text-muted-foreground">
            Tap avatar to change photo
          </Text>
        </View>

        <View className="px-1">
          <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
            Profile
          </Text>
          <View>
            <GeneralRow
              icon={User}
              title="Edit Profile"
              description="Update your display name"
              onPress={openEditProfileSheet}
              showDivider
            />
            <GeneralRow
              icon={Globe}
              title="Language"
              description="App display language"
              onPress={() => router.push('/(settings)/language')}
              showDivider
            />
            <GeneralRow
              icon={Mail}
              title={t('nameEdit.emailAddress')}
              description={user?.email || t('nameEdit.notAvailable')}
              onPress={undefined}
              hideChevron
              showDivider={false}
            />
          </View>
        </View>

        {(deletionStatus?.supported ?? true) && (
          <View className="px-1">
            <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
              Account
            </Text>
            <GeneralRow
              icon={Trash2}
              title={deletionStatus?.has_pending_deletion ? 'Deletion Scheduled' : 'Delete Account'}
              description={deletionStatus?.has_pending_deletion
                ? 'Manage or cancel your scheduled deletion'
                : 'Request account deletion and data removal'}
              onPress={() => router.push('/(settings)/account-deletion')}
              destructive
              badge={deletionStatus?.has_pending_deletion ? 'Scheduled' : undefined}
              showDivider={false}
            />
          </View>
        )}
        </View>
      </ScrollView>

      <BottomSheetModal
        ref={editProfileSheetRef}
        index={0}
        snapPoints={snapPoints}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
        backgroundStyle={{
          backgroundColor: getSheetBg(isDark),
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
      >
        <BottomSheetView
          style={{
            paddingHorizontal: 24,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 20) + 16,
          }}
        >
          <Text className="text-lg font-roobert-semibold" style={{ color: fgColor }}>
            Edit Profile
          </Text>
          <Text
            className="mt-0.5 text-xs font-roobert"
            style={{
              color: isDark ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)',
            }}
          >
            Set your display name
          </Text>

          <BottomSheetTextInput
            value={editName}
            onChangeText={setEditName}
            placeholder={t('nameEdit.yourNamePlaceholder')}
            placeholderTextColor={isDark ? 'rgba(248, 248, 248, 0.25)' : 'rgba(18, 18, 21, 0.3)'}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={100}
            editable={!isSavingName}
            returnKeyType="done"
            onSubmitEditing={handleSaveName}
            style={{
              marginTop: 16,
              marginBottom: 20,
              backgroundColor: isDark
                ? 'rgba(248, 248, 248, 0.06)'
                : 'rgba(18, 18, 21, 0.04)',
              borderWidth: 1,
              borderColor: isDark
                ? 'rgba(248, 248, 248, 0.1)'
                : 'rgba(18, 18, 21, 0.08)',
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
              fontFamily: 'Roobert',
              color: fgColor,
            }}
          />

          <Pressable
            onPress={handleSaveName}
            disabled={!canSaveName || isSavingName}
            style={{
              backgroundColor: canSaveName
                ? isDark
                  ? '#f8f8f8'
                  : '#121215'
                : isDark
                  ? 'rgba(248, 248, 248, 0.08)'
                  : 'rgba(18, 18, 21, 0.06)',
              borderRadius: 14,
              paddingVertical: 15,
              alignItems: 'center',
              opacity: canSaveName ? 1 : 0.5,
            }}
          >
            <Text
              className="text-[15px] font-roobert-semibold"
              style={{
                color: canSaveName
                  ? isDark
                    ? '#121215'
                    : '#f8f8f8'
                  : isDark
                    ? 'rgba(248, 248, 248, 0.3)'
                    : 'rgba(18, 18, 21, 0.3)',
              }}
            >
              {isSavingName ? t('nameEdit.saving') : t('nameEdit.saveChanges')}
            </Text>
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    </>
  );
}

function GeneralRow({
  icon,
  title,
  description,
  onPress,
  destructive = false,
  hideChevron = false,
  badge,
  showDivider = true,
}: {
  icon: typeof User;
  title: string;
  description: string;
  onPress?: () => void;
  destructive?: boolean;
  hideChevron?: boolean;
  badge?: string;
  showDivider?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} className="active:opacity-85">
      <View className="py-3.5">
        <View className="flex-row items-center">
          <Icon as={icon} size={18} className={destructive ? 'text-destructive' : 'text-foreground/80'} strokeWidth={2.2} />
          <View className="ml-4 flex-1">
            <View className="flex-row items-center">
              <Text className={`font-roobert-medium text-[15px] ${destructive ? 'text-destructive' : 'text-foreground'}`}>
                {title}
              </Text>
              {!!badge && (
                <View className="ml-2 rounded-full bg-destructive/15 px-2 py-0.5">
                  <Text className="text-[10px] font-roobert-medium text-destructive">{badge}</Text>
                </View>
              )}
            </View>
            <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">{description}</Text>
          </View>
          {!hideChevron && <Icon as={ChevronRight} size={16} className="text-muted-foreground/50" strokeWidth={2.2} />}
        </View>
      </View>

      {showDivider && <View className="h-px bg-border/35" />}
    </Pressable>
  );
}
