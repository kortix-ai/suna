/**
 * useAttachmentPicker — the "add photos or files" chooser shared by the thread
 * composer (SessionChatInput) and the project home composer.
 *
 * iOS: action sheet with Photo Library, Camera, Browse Files. Android: alert
 * with Photo Library and Browse Files. Picked files go to `onPick`; nothing is
 * uploaded here (see `lib/session/attachments.ts`).
 */
import { useCallback } from 'react';
import { ActionSheetIOS, Alert, Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import type { AttachedFile } from '@/lib/session/attachments';

export function useAttachmentPicker(onPick: (files: AttachedFile[]) => void): () => void {
  return useCallback(() => {
    const pickImages = async () => {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.9,
      });
      if (result.canceled) return;
      onPick(
        result.assets.map((a) => ({
          uri: a.uri,
          name: a.fileName || a.uri.split('/').pop() || 'image.jpg',
          mimeType: a.mimeType || 'image/jpeg',
          size: a.fileSize,
          isImage: true,
        })),
      );
    };

    const takePhoto = async () => {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission required', 'Camera access is needed to take photos.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.9 });
      if (result.canceled) return;
      const photo = result.assets[0];
      onPick([
        {
          uri: photo.uri,
          name: photo.fileName || `photo_${Date.now()}.jpg`,
          mimeType: photo.mimeType || 'image/jpeg',
          size: photo.fileSize,
          isImage: true,
        },
      ]);
    };

    const browseFiles = async () => {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      onPick(
        result.assets.map((a) => ({
          uri: a.uri,
          name: a.name,
          mimeType: a.mimeType || 'application/octet-stream',
          size: a.size,
          isImage: (a.mimeType || '').startsWith('image/'),
        })),
      );
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Photo Library', 'Camera', 'Browse Files'], cancelButtonIndex: 0 },
        (buttonIndex) => {
          if (buttonIndex === 1) void pickImages();
          else if (buttonIndex === 2) void takePhoto();
          else if (buttonIndex === 3) void browseFiles();
        },
      );
      return;
    }

    Alert.alert('Attach file', 'Choose source', [
      { text: 'Photo Library', onPress: () => void pickImages() },
      { text: 'Browse Files', onPress: () => void browseFiles() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [onPick]);
}
