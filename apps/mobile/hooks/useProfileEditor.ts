/**
 * Profile editing for the signed-in user: the display name and the profile
 * photo. Both live in Supabase auth `user_metadata` (`full_name`,
 * `avatar_url`); photos upload to the public `avatars` storage bucket.
 *
 * Used by the Account page (components/settings/AccountPage.tsx).
 */

import * as React from 'react';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '@/api/supabase';
import { useToast } from '@/components/kortix/toast-provider';
import { useAuthContext, useLanguage } from '@/contexts';
import { haptics } from '@/lib/haptics';

/** Longest display name the name field accepts. */
export const PROFILE_NAME_MAX_LENGTH = 100;

export function useProfileEditor() {
  const { user } = useAuthContext();
  const { t } = useLanguage();
  const toast = useToast();

  const savedName: string = user?.user_metadata?.full_name || user?.email?.split('@')[0] || '';
  const savedAvatar: string = user?.user_metadata?.avatar_url || '';

  // Local copies show a saved change at once. They follow the auth user when
  // it changes (sign-in, token refresh after an edit on another device).
  const [displayName, setDisplayName] = React.useState(savedName);
  const [avatarUrl, setAvatarUrl] = React.useState(savedAvatar);
  React.useEffect(() => setDisplayName(savedName), [savedName]);
  React.useEffect(() => setAvatarUrl(savedAvatar), [savedAvatar]);

  const [isUploadingPhoto, setIsUploadingPhoto] = React.useState(false);
  const [isSavingName, setIsSavingName] = React.useState(false);

  const changePhoto = React.useCallback(async () => {
    if (!user?.id || isUploadingPhoto) return;
    haptics.tap();

    // The system photo picker runs outside the app, so it needs no photo
    // library permission prompt.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    const asset = result.canceled ? null : result.assets?.[0];
    if (!asset?.uri) return;

    setIsUploadingPhoto(true);
    try {
      const contentType = asset.mimeType || 'image/jpeg';
      const extension = (contentType.split('/')[1] || 'jpeg').replace('jpeg', 'jpg');
      const filePath = `${user.id}-${Date.now()}.${extension}`;
      // Supabase Storage stores a React Native Blob or FormData as an empty
      // file. An ArrayBuffer keeps the bytes (Supabase React Native guide).
      const body = await fetch(asset.uri).then((response) => response.arrayBuffer());

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, body, { contentType, cacheControl: '3600', upsert: true });
      if (uploadError) throw uploadError;

      const publicUrl = supabase.storage.from('avatars').getPublicUrl(filePath).data.publicUrl;
      const { error: updateError } = await supabase.auth.updateUser({
        data: { full_name: displayName, avatar_url: publicUrl },
      });
      if (updateError) throw updateError;

      setAvatarUrl(publicUrl);
      haptics.success();
    } catch (error: any) {
      haptics.warning();
      toast.error(error?.message || t('profile.photoFailed', 'Could not update your photo. Try again.'));
    } finally {
      setIsUploadingPhoto(false);
    }
  }, [displayName, isUploadingPhoto, t, toast, user?.id]);

  /** Saves the display name. Resolves `true` on success; failures show a toast. */
  const saveName = React.useCallback(
    async (name: string): Promise<boolean> => {
      const trimmed = name.trim();
      if (!user?.id || !trimmed || trimmed.length > PROFILE_NAME_MAX_LENGTH) return false;

      setIsSavingName(true);
      try {
        const { error } = await supabase.auth.updateUser({
          data: { full_name: trimmed, avatar_url: avatarUrl },
        });
        if (error) throw error;
        setDisplayName(trimmed);
        haptics.success();
        return true;
      } catch (error: any) {
        haptics.warning();
        toast.error(error?.message || t('nameEdit.failedToUpdate', 'Could not update your name. Try again.'));
        return false;
      } finally {
        setIsSavingName(false);
      }
    },
    [avatarUrl, t, toast, user?.id]
  );

  return {
    email: user?.email ?? '',
    displayName,
    avatarUrl,
    isUploadingPhoto,
    isSavingName,
    changePhoto,
    saveName,
  };
}
