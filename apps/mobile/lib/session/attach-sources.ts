/**
 * The Add sheet's three sources and the mapping from a picker asset to an
 * `AttachedFile`. Pure: no React Native, no icons (`AttachSheet` owns those).
 */
import type { AttachedFile } from './attachments';

export type AttachSourceId = 'camera' | 'photos' | 'files';

export interface AttachSource {
  id: AttachSourceId;
  label: string;
  /** Spoken after the label by a screen reader. */
  hint: string;
}

export const ATTACH_SOURCES: readonly AttachSource[] = [
  { id: 'camera', label: 'Camera', hint: 'Takes a photo and adds it to the message' },
  { id: 'photos', label: 'Photos', hint: 'Opens your photo library' },
  { id: 'files', label: 'Files', hint: 'Opens your files' },
];

/** The fields of an `expo-image-picker` asset this module reads. */
export interface ImageAssetLike {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}

/** The fields of an `expo-document-picker` asset this module reads. */
export interface DocumentAssetLike {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}

export function imageAssetToFile(asset: ImageAssetLike, fallbackName = 'image.jpg'): AttachedFile {
  return {
    uri: asset.uri,
    name: asset.fileName || asset.uri.split('/').pop() || fallbackName,
    mimeType: asset.mimeType || 'image/jpeg',
    size: asset.fileSize ?? undefined,
    isImage: true,
  };
}

export function documentAssetToFile(asset: DocumentAssetLike): AttachedFile {
  const mimeType = asset.mimeType || 'application/octet-stream';
  return {
    uri: asset.uri,
    name: asset.name,
    mimeType,
    size: asset.size ?? undefined,
    isImage: mimeType.startsWith('image/'),
  };
}
