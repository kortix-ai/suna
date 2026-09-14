import * as React from 'react';
import { Alert, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Camera, Globe, Mail, Trash2, User } from 'lucide-react-native';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useAuthContext, useLanguage } from '@/contexts';
import { supabase } from '@/api/supabase';
import * as ImagePicker from 'expo-image-picker';
import { haptics } from '@/lib/haptics';
import { ProfilePicture } from '@/components/settings/ProfilePicture';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { BottomSheetModal, BottomSheetTextInput, BottomSheetView } from '@gorhom/bottom-sheet';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';
import { THEME, withAlpha } from '@/lib/utils/theme';

export default function GeneralSettingsScreen() {
  const sheetBg = useSheetBackground();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const { t } = useLanguage();
  const isDark = colorScheme === 'dark';
  const fgColor = isDark ? THEME.dark.foreground : THEME.light.foreground;

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
    haptics.tap();

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== 'granted') {
      haptics.warning();
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
      haptics.success();
    } catch (error: any) {
      haptics.warning();
      Alert.alert(t('common.error'), error?.message || 'Failed to update avatar');
    } finally {
      setIsUploadingAvatar(false);
    }
  }, [displayName, isUploadingAvatar, t, user?.id]);

  const openEditProfileSheet = React.useCallback(() => {
    setEditName(displayName);
    haptics.medium();
    editProfileSheetRef.current?.present();
  }, [displayName]);

  const handleSaveName = React.useCallback(async () => {
    const trimmed = editName.trim();
    if (!trimmed) {
      haptics.warning();
      Alert.alert(t('common.error'), t('nameEdit.nameRequired'));
      return;
    }
    if (trimmed.length > 100) {
      haptics.warning();
      Alert.alert(t('common.error'), t('nameEdit.nameTooLong'));
      return;
    }
    if (!user?.id) return;

    haptics.tap();
    setIsSavingName(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        data: {
          full_name: trimmed,
          avatar_url: avatarUrl,
        },
      });
      if (updateError) throw updateError;

      setDisplayName(trimmed);
      haptics.success();
      editProfileSheetRef.current?.dismiss();
    } catch (error: any) {
      haptics.warning();
      Alert.alert(t('common.error'), error?.message || t('nameEdit.failedToUpdate'));
    } finally {
      setIsSavingName(false);
    }
  }, [avatarUrl, editName, t, user?.id]);


  return (
    <>
      <SettingsPage
        header={
          <View className="items-center pt-1">
            <Pressable
              onPress={pickAndUploadAvatar}
              disabled={isUploadingAvatar}
              accessibilityLabel="Change profile photo"
              className="active:opacity-85">
              <View>
                <ProfilePicture
                  imageUrl={avatarUrl}
                  size={13}
                  fallbackText={displayName || user?.email?.split('@')[0] || 'U'}
                />
                <View className="absolute bottom-[-2px] right-[-2px] h-7 w-7 items-center justify-center rounded-full bg-card">
                  <Icon as={Camera} size={12} className="text-foreground/70" strokeWidth={2.3} />
                </View>
              </View>
            </Pressable>
            <Text variant="large" className="mt-2">
              {displayName}
            </Text>
          </View>
        }>
        <SettingsGroup title="Profile">
          <SettingsRow icon={User} label="Edit profile" onPress={openEditProfileSheet} />
          <SettingsRow
            icon={Globe}
            label="Language"
            onPress={() => {
              haptics.tap();
              router.push('/(settings)/language');
            }}
          />
          <SettingsRow
            icon={Mail}
            label="Email"
            value={user?.email || t('nameEdit.notAvailable')}
          />
        </SettingsGroup>

        {(deletionStatus?.supported ?? true) && (
          <SettingsGroup title="Account">
            <SettingsRow
              icon={Trash2}
              label={deletionStatus?.has_pending_deletion ? 'Deletion scheduled' : 'Delete account'}
              badge={deletionStatus?.has_pending_deletion ? 'Scheduled' : undefined}
              destructive
              onPress={() => {
                haptics.tap();
                router.push('/(settings)/account-deletion');
              }}
            />
          </SettingsGroup>
        )}
      </SettingsPage>

      <BottomSheetModal
        ref={editProfileSheetRef}
        index={0}
        snapPoints={snapPoints}
        enablePanDownToClose
        backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.35} />}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
        backgroundStyle={{
          backgroundColor: sheetBg,
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
              color: isDark ? withAlpha(THEME.dark.foreground, 0.4) : withAlpha(THEME.light.foreground, 0.4),
            }}
          >
            Set your display name
          </Text>

          <BottomSheetTextInput
            value={editName}
            onChangeText={setEditName}
            placeholder={t('nameEdit.yourNamePlaceholder')}
            placeholderTextColor={isDark ? withAlpha(THEME.dark.foreground, 0.25) : withAlpha(THEME.light.foreground, 0.3)}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={100}
            editable={!isSavingName}
            returnKeyType="done"
            onSubmitEditing={handleSaveName}
            style={{
              marginTop: 16,
              marginBottom: 20,
              backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
              borderWidth: 1,
              borderColor: isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.08),
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
                  ? THEME.dark.foreground
                  : THEME.light.foreground
                : isDark
                  ? withAlpha(THEME.dark.foreground, 0.08)
                  : withAlpha(THEME.light.foreground, 0.06),
              borderRadius: 14,
              paddingVertical: 15,
              alignItems: 'center',
              opacity: canSaveName ? 1 : 0.5,
            }}
          >
            <Text
              className="text-[15px] font-roobert-semibold"
              style={{
                color: // Sits on the filled (foreground-colored) button — invert vs. the
                // usual isDark mapping so it reads dark-on-light / light-on-dark.
                canSaveName
                  ? isDark
                    ? THEME.light.foreground
                    : THEME.dark.foreground
                  : isDark
                    ? withAlpha(THEME.dark.foreground, 0.3)
                    : withAlpha(THEME.light.foreground, 0.3),
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
