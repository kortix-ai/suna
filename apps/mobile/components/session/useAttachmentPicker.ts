/**
 * useAttachmentPicker — opens one attach source directly: the camera, the
 * photo library, or the file browser. `AttachSheet` is the chooser in front of
 * it; there is no native action sheet or alert in between.
 *
 * Picked files go to `onPick`; nothing is uploaded here (see
 * `lib/session/attachments.ts`). The photo library needs no permission on
 * either platform (PHPicker / Android photo picker). The camera does:
 * `onCameraDenied` fires when the user has refused it.
 *
 * If Android kills the host activity mid-pick, this hook's in-flight call
 * never resolves; `useRecoverPendingPick` (`useRecoverPendingPick.ts`)
 * recovers the result on the next mount instead.
 */
import { useCallback } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { useToast } from '@/components/kortix/toast-provider';
import {
  documentAssetToFile,
  imageAssetToFile,
  type AttachSourceId,
} from '@/lib/session/attach-sources';
import type { AttachedFile } from '@/lib/session/attachments';

const OPEN_FAILED: Record<AttachSourceId, string> = {
  camera: 'Unable to open the camera. Try again.',
  photos: 'Unable to open your photos. Try again.',
  files: 'Unable to open your files. Try again.',
};

export function useAttachmentPicker(
  onPick: (files: AttachedFile[]) => void,
  onCameraDenied: () => void,
): (source: AttachSourceId) => void {
  const toast = useToast();

  return useCallback(
    (source: AttachSourceId) => {
      const run = async () => {
        if (source === 'camera') {
          const { granted } = await ImagePicker.requestCameraPermissionsAsync();
          if (!granted) {
            onCameraDenied();
            return;
          }
          const result = await ImagePicker.launchCameraAsync({ quality: 0.9 });
          if (result.canceled) return;
          onPick([imageAssetToFile(result.assets[0], `photo_${Date.now()}.jpg`)]);
          return;
        }

        if (source === 'photos') {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            quality: 0.9,
          });
          if (result.canceled) return;
          onPick(result.assets.map((asset) => imageAssetToFile(asset)));
          return;
        }

        const result = await DocumentPicker.getDocumentAsync({
          multiple: true,
          copyToCacheDirectory: true,
        });
        if (result.canceled) return;
        onPick(result.assets.map(documentAssetToFile));
      };

      // A picker throws when the device has no such source (no camera on a
      // simulator) or when another picker is still open.
      run().catch(() => toast.error(OPEN_FAILED[source]));
    },
    [onPick, onCameraDenied, toast],
  );
}
