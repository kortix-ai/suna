/**
 * Audio Transcription API
 * 
 * Handles audio file transcription using backend Whisper API
 * Uses expo-file-system legacy API for reliable async operations
 */

import { API_URL, getAuthToken } from '@/api/config';
import * as FileSystem from 'expo-file-system/legacy';

export interface TranscriptionResult {
  text: string;
}

export interface TranscriptionError {
  error: string;
  detail?: string;
}

/**
 * Copy audio file from temporary location to permanent cache
 * 
 * This prevents the file from being deleted before transcription completes.
 * expo-audio creates temporary files that may be cleaned up immediately.
 * 
 * Strategy: Read file into memory using legacy API for reliability.
 * 
 * @param temporaryUri - URI of the temporary audio file from expo-audio
 * @returns URI of the cached file
 */
export async function copyAudioToCache(temporaryUri: string): Promise<string> {
  console.log('📋 Copying audio to cache:', temporaryUri);
  
  // Validate the URI
  if (!temporaryUri || temporaryUri.trim() === '') {
    throw new Error('Invalid audio URI: URI is empty or undefined');
  }
  
  // Check if source file exists (using async API)
  console.log('📋 Checking if source file exists...');
  let fileInfo = await FileSystem.getInfoAsync(temporaryUri);
  
  // Retry if file doesn't exist yet (race condition)
  if (!fileInfo.exists) {
    console.warn('⚠️ Source file does not exist yet, waiting...');
    await new Promise(resolve => setTimeout(resolve, 300));
    fileInfo = await FileSystem.getInfoAsync(temporaryUri);
    
    if (!fileInfo.exists) {
      console.error('❌ Source file still does not exist after wait');
      throw new Error(`Source audio file does not exist after wait: ${temporaryUri}`);
    }
    console.log('✅ Source file exists after retry');
  }
  
  console.log('📊 Source file info:', {
    exists: fileInfo.exists,
    size: fileInfo.size,
    uri: temporaryUri,
  });
  
  // Read file as base64
  console.log('📖 Reading file into memory...');
  const base64Data = await FileSystem.readAsStringAsync(temporaryUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  console.log('✅ File read into memory:', base64Data.length, 'chars');
  
  // Write to cache
  const filename = `transcription-${Date.now()}.m4a`;
  const cacheUri = `${FileSystem.cacheDirectory}${filename}`;
  
  console.log('📝 Writing file to cache:', cacheUri);
  await FileSystem.writeAsStringAsync(cacheUri, base64Data, {
    encoding: FileSystem.EncodingType.Base64,
  });
  
  // Verify the copy
  const cachedInfo = await FileSystem.getInfoAsync(cacheUri);
  if (!cachedInfo.exists) {
    throw new Error(`Failed to copy file to cache. Destination file does not exist: ${cacheUri}`);
  }
  
  console.log('✅ Audio copied to cache:', cacheUri);
  console.log('📊 Cached file info:', {
    exists: cachedInfo.exists,
    size: cachedInfo.size,
    uri: cacheUri,
  });
  
  return cacheUri;
}

/**
 * Delete cached audio file
 * 
 * @param uri - URI of the cached audio file to delete
 */
export async function deleteCachedAudio(uri: string): Promise<void> {
  try {
    console.log('🗑️ Deleting cached audio:', uri);
    await FileSystem.deleteAsync(uri, { idempotent: true });
    console.log('✅ Cached audio deleted');
  } catch (error) {
    console.warn('⚠️ Failed to delete cached audio:', error);
    // Don't throw - cleanup failures shouldn't break the flow
  }
}

/**
 * Transcribe audio file to text
 * 
 * @param audioUri - URI of the audio file
 * @param onProgress - Optional callback for upload progress (0-100)
 * @returns Transcribed text
 */
export async function transcribeAudio(
  audioUri: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  try {
    console.log('🎤 Transcribing audio:', audioUri);
    
    // Get auth token
    const token = await getAuthToken();
    if (!token) {
      throw new Error('Authentication required');
    }

    // Extract filename from URI
    const filename = audioUri.split('/').pop() || 'recording.m4a';
    
    // Determine MIME type based on file extension
    let mimeType = 'audio/m4a';
    if (filename.endsWith('.mp3')) {
      mimeType = 'audio/mp3';
    } else if (filename.endsWith('.wav')) {
      mimeType = 'audio/wav';
    } else if (filename.endsWith('.webm')) {
      mimeType = 'audio/webm';
    } else if (filename.endsWith('.mp4')) {
      mimeType = 'audio/mp4';
    }
    
    console.log('📤 Preparing audio file for upload...');
    console.log('📊 File:', filename, 'Type:', mimeType);
    
    // Read file as base64
    console.log('📖 Reading file into memory...');
    const base64 = await FileSystem.readAsStringAsync(audioUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    console.log('✅ File read into memory:', base64.length, 'chars');
    
    // Convert base64 to Blob for upload
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });
    console.log('✅ Blob created:', blob.size, 'bytes');
    
    // Create FormData with the Blob
    const formData = new FormData();
    formData.append('audio_file', blob, filename);
    
    console.log('✅ FormData created with audio blob');

    console.log('📤 Uploading audio for transcription');
    console.log('📊 API URL:', `${API_URL}/transcription`);
    console.log('📊 Auth token (first 20 chars):', token.substring(0, 20) + '...');

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error('⏰ Request timeout after 60 seconds');
      controller.abort();
    }, 60000); // 60 second timeout

    try {
      // Make API request with timeout
      console.log('📤 Sending fetch request...');
      const response = await fetch(`${API_URL}/transcription`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          // Don't set Content-Type - let fetch set it with boundary for FormData
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      console.log('📡 Transcription response status:', response.status);
      console.log('📡 Response headers:', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Transcription failed with status:', response.status);
        console.error('❌ Response text:', errorText);
        
        let errorData: any = {};
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { detail: errorText };
        }
        
        throw new Error(
          errorData.detail || 
          errorData.error || 
          `Transcription failed with status ${response.status}`
        );
      }

      const result: TranscriptionResult = await response.json();
      console.log('✅ Transcription successful');
      console.log('📝 Transcribed text length:', result.text.length);
      console.log('📝 Transcribed text:', result.text);

      return result.text;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      
      if (fetchError.name === 'AbortError') {
        console.error('❌ Transcription timeout (60s)');
        throw new Error('Transcription request timed out. Please try a shorter recording.');
      }
      
      throw fetchError;
    }
  } catch (error: any) {
    console.error('❌ Transcription error:', error);
    console.error('❌ Error details:', {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    });
    
    // Provide user-friendly error messages
    if (error?.message?.includes('Network request failed')) {
      throw new Error(
        'Network error: Cannot reach the transcription server. ' +
        'Please check your internet connection and try again. ' +
        `(Trying to connect to: ${API_URL}/transcription)`
      );
    }
    
    if (error?.message?.includes('Failed to fetch')) {
      throw new Error(
        'Connection error: The transcription service is not responding. ' +
        'Please check if the backend server is running.'
      );
    }
    
    throw error;
  }
}

/**
 * Validate audio file before transcription
 * 
 * @param audioUri - URI of the audio file
 * @returns Validation result
 */
export function validateAudioFile(audioUri: string): {
  valid: boolean;
  error?: string;
} {
  // Check if URI exists
  if (!audioUri) {
    return { valid: false, error: 'No audio file provided' };
  }

  // Check file extension
  const filename = audioUri.split('/').pop() || '';
  const validExtensions = ['.m4a', '.mp3', '.wav', '.webm', '.mp4', '.mpga', '.mpeg'];
  const hasValidExtension = validExtensions.some(ext => filename.toLowerCase().endsWith(ext));
  
  if (!hasValidExtension) {
    return { 
      valid: false, 
      error: `Unsupported audio format. Supported formats: ${validExtensions.join(', ')}` 
    };
  }

  return { valid: true };
}

