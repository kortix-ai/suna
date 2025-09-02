import { SERVER_URL } from '@/constants/Server';
import { createSupabaseClient } from '@/constants/SupabaseConfig';
import { cacheUploadedFile } from '@/hooks/useImageContent';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

export interface UploadedFile {
  name: string;
  path: string;
  size: number;
  type: string;
  localUri?: string;
  isUploading?: boolean;
  uploadError?: string;
  cachedBlob?: Blob;
}

export interface FileUploadResult {
  success: boolean;
  files: UploadedFile[];
  error?: string;
}

// File size limit (50MB)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Normalize filename to NFC (Unicode normalization)
const normalizeFilenameToNFC = (filename: string): string => {
  return filename.normalize('NFC');
};

// Show file picker options
export const showFilePickerOptions = (): Promise<{ cancelled: boolean; files?: any[] }> => {
  return new Promise((resolve) => {
    Alert.alert(
      'Add Files',
      'Choose how you want to add files',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve({ cancelled: true }) },
        { 
          text: 'Camera', 
          onPress: async () => {
            const result = await pickFromCamera();
            resolve(result);
          }
        },
        { 
          text: 'Photo Library', 
          onPress: async () => {
            const result = await pickFromImageLibrary();
            resolve(result);
          }
        },
        { 
          text: 'Documents', 
          onPress: async () => {
            const result = await pickFromDocuments();
            resolve(result);
          }
        },
      ],
      { cancelable: true, onDismiss: () => resolve({ cancelled: true }) }
    );
  });
};

// Pick from camera
const pickFromCamera = async (): Promise<{ cancelled: boolean; files?: any[] }> => {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  
  if (status !== 'granted') {
    Alert.alert('Permission Required', 'Camera permission is required to take photos.');
    return { cancelled: true };
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.All,
    allowsEditing: false,
    quality: 0.8,
  });

  if (result.canceled) {
    return { cancelled: true };
  }

  return { cancelled: false, files: result.assets };
};

// Pick from image library
const pickFromImageLibrary = async (): Promise<{ cancelled: boolean; files?: any[] }> => {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  
  if (status !== 'granted') {
    Alert.alert('Permission Required', 'Photo library permission is required to select images.');
    return { cancelled: true };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.All,
    allowsEditing: false,
    allowsMultipleSelection: true,
    quality: 0.8,
  });

  if (result.canceled) {
    return { cancelled: true };
  }

  return { cancelled: false, files: result.assets };
};

// Pick from documents
const pickFromDocuments = async (): Promise<{ cancelled: boolean; files?: any[] }> => {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
    copyToCacheDirectory: true,
  });

  if (result.canceled) {
    return { cancelled: true };
  }

  return { cancelled: false, files: result.assets };
};

// Helper function to create blob from file URI
const createBlobFromUri = async (uri: string, mimeType: string): Promise<Blob | null> => {
  try {
    const response = await fetch(uri);
    const blob = await response.blob();
    
    // Ensure correct MIME type
    if (blob.type !== mimeType) {
      return new Blob([blob], { type: mimeType });
    }
    
    return blob;
  } catch (error) {
    console.warn('[FILE_UPLOAD] Failed to create blob from URI:', error);
    return null;
  }
};

// Handle local files (when no sandbox) - show immediately
export const handleLocalFiles = async (
  files: any[],
  setPendingFiles: (files: File[]) => void,
  addUploadedFiles: (files: UploadedFile[]) => void
): Promise<UploadedFile[]> => {
  const validFiles: UploadedFile[] = [];

  for (const file of files) {
    if (file.size && file.size > MAX_FILE_SIZE) {
      Alert.alert('File Too Large', `File size exceeds 50MB limit: ${file.name || 'Unknown file'}`);
      continue;
    }

    const fileName = file.name || file.fileName || 'unknown_file';
    const normalizedName = normalizeFilenameToNFC(fileName);
    const mimeType = file.mimeType || file.type || 'application/octet-stream';
    
    // Create blob for optimistic caching (images only)
    let cachedBlob: Blob | undefined;
    if (file.uri && mimeType.startsWith('image/')) {
      cachedBlob = await createBlobFromUri(file.uri, mimeType) || undefined;
    }
    
    const uploadedFile: UploadedFile = {
      name: normalizedName,
      path: `/workspace/${normalizedName}`,
      size: file.size || 0,
      type: mimeType,
      localUri: file.uri,
      isUploading: false, // Local files don't need uploading
      cachedBlob,
    };

    validFiles.push(uploadedFile);
  }

  if (validFiles.length > 0) {
    addUploadedFiles(validFiles);
  }

  return validFiles;
};

// Upload files to sandbox - show immediately with loading state
export const uploadFilesToSandbox = async (
  files: any[],
  sandboxId: string,
  addUploadedFiles: (files: UploadedFile[]) => void,
  updateFileStatus: (path: string, status: { isUploading?: boolean; uploadError?: string }) => void
): Promise<FileUploadResult> => {
  const uploadedFiles: UploadedFile[] = [];
  const filesToShow: UploadedFile[] = [];

  // First, show all files immediately with loading state + optimistic caching
  for (const file of files) {
    if (file.size && file.size > MAX_FILE_SIZE) {
      Alert.alert('File Too Large', `File size exceeds 50MB limit: ${file.name || 'Unknown file'}`);
      continue;
    }

    const fileName = file.name || file.fileName || 'unknown_file';
    const normalizedName = normalizeFilenameToNFC(fileName);
    const uploadPath = `/workspace/${normalizedName}`;
    const mimeType = file.mimeType || file.type || 'application/octet-stream';

    // Create blob for optimistic caching (images only)
    let cachedBlob: Blob | undefined;
    if (file.uri && mimeType.startsWith('image/')) {
      cachedBlob = await createBlobFromUri(file.uri, mimeType) || undefined;
      
      // Cache optimistically
      if (cachedBlob) {
        cacheUploadedFile(sandboxId, uploadPath, cachedBlob);
        console.log(`[FILE_UPLOAD] Cached image optimistically: ${uploadPath}`);
      }
    }

    const uploadedFile: UploadedFile = {
      name: normalizedName,
      path: uploadPath,
      size: file.size || 0,
      type: mimeType,
      localUri: file.uri,
      isUploading: true, // Show loading immediately
      cachedBlob,
    };

    filesToShow.push(uploadedFile);
  }

  // Show files immediately
  if (filesToShow.length > 0) {
    addUploadedFiles(filesToShow);
  }

  // Now upload each file
  for (const file of files) {
    if (file.size && file.size > MAX_FILE_SIZE) {
      continue;
    }

    const fileName = file.name || file.fileName || 'unknown_file';
    const normalizedName = normalizeFilenameToNFC(fileName);
    const uploadPath = `/workspace/${normalizedName}`;

    try {
      // Create FormData
      const formData = new FormData();
      
      // Add file to FormData
      formData.append('file', {
        uri: file.uri,
        name: normalizedName,
        type: file.mimeType || file.type || 'application/octet-stream',
      } as any);
      
      formData.append('path', uploadPath);

      // Get auth token
      const supabase = createSupabaseClient();
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        throw new Error('Authentication required');
      }

      // Upload to server
      const response = await fetch(`${SERVER_URL}/sandboxes/${sandboxId}/files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Upload failed');
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      // Update file status to success
      updateFileStatus(uploadPath, { isUploading: false });

      const uploadedFile: UploadedFile = {
        name: normalizedName,
        path: uploadPath,
        size: file.size || 0,
        type: file.mimeType || file.type || 'application/octet-stream',
        localUri: file.uri,
        isUploading: false
      };

      uploadedFiles.push(uploadedFile);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      
      // Update file status to error
      updateFileStatus(uploadPath, { 
        isUploading: false, 
        uploadError: errorMessage 
      });

      console.error(`Failed to upload ${normalizedName}:`, error);
    }
  }

  return { success: uploadedFiles.length > 0, files: uploadedFiles };
};

// Main file picker function
export const pickFiles = async (): Promise<{ cancelled: boolean; files?: any[] }> => {
  return await showFilePickerOptions();
}; 