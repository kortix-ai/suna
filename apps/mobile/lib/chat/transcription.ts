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
 * Save audio recording to permanent file in the file system
 * 
 * Reads the audio file from expo-audio's temporary location and saves it
 * to a permanent location in the cache directory.
 * 
 * @param temporaryUri - URI of the temporary audio file from expo-audio
 * @returns URI of the saved file in cache directory
 */
/**
 * Wait for file to exist by polling
 */
async function waitForFileToExist(uri: string, maxRetries: number = 10, initialDelay: number = 200): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const delay = initialDelay + (i * 100); // Exponential backoff
    console.log(`🔍 Retry ${i + 1}/${maxRetries}: Waiting ${delay}ms before checking file...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      const fileInfo = await FileSystem.getInfoAsync(uri);
      if (fileInfo.exists) {
        console.log(`✅ File exists after retry ${i + 1}!`);
        return true;
      }
      console.log(`⚠️ File still doesn't exist (attempt ${i + 1}/${maxRetries})`);
    } catch (error) {
      console.log(`⚠️ Error checking file (attempt ${i + 1}/${maxRetries}):`, error);
    }
  }
  return false;
}

export async function saveAudioToFileSystem(temporaryUri: string): Promise<string> {
  console.log('💾 Saving audio to file system:', temporaryUri);
  
  // Validate the URI
  if (!temporaryUri || temporaryUri.trim() === '') {
    throw new Error('Invalid audio URI: URI is empty or undefined');
  }
  
  // Wait for file to exist with retries
  console.log('⏳ Waiting for audio file to be written to disk...');
  const fileExists = await waitForFileToExist(temporaryUri);
  
  if (!fileExists) {
    console.error('❌ File never appeared on disk after all retries');
    throw new Error(`Source audio file does not exist: ${temporaryUri}`);
  }
  
  // Read the file
  console.log('📖 Reading audio file...');
  const base64Data = await FileSystem.readAsStringAsync(temporaryUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  console.log('✅ Audio data read:', base64Data.length, 'chars');
  
  // Save to permanent location
  const timestamp = Date.now();
  const filename = `audio-recording-${timestamp}.m4a`;
  const permanentPath = `${FileSystem.cacheDirectory}${filename}`;
  
  console.log('💾 Writing to permanent file:', permanentPath);
  await FileSystem.writeAsStringAsync(permanentPath, base64Data, {
    encoding: FileSystem.EncodingType.Base64,
  });
  
  // Verify the file was saved
  const savedInfo = await FileSystem.getInfoAsync(permanentPath);
  if (!savedInfo.exists) {
    throw new Error(`Failed to save file. File does not exist: ${permanentPath}`);
  }
  
  console.log('✅ Audio saved successfully to:', permanentPath);
  
  return permanentPath;
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
    // IMPORTANT: Use 'audio/mp4' for .m4a files as it's the standard MIME type
    let mimeType = 'audio/mp4';
    if (filename.endsWith('.mp3')) {
      mimeType = 'audio/mpeg';
    } else if (filename.endsWith('.wav')) {
      mimeType = 'audio/wav';
    } else if (filename.endsWith('.webm')) {
      mimeType = 'audio/webm';
    } else if (filename.endsWith('.mpga')) {
      mimeType = 'audio/mpga';
    }
    // Note: .m4a files should use 'audio/mp4' not 'audio/m4a'
    
    console.log('📤 Preparing audio file for upload...');
    console.log('📊 File:', filename, 'Type:', mimeType);
    
    // In React Native, we send the file directly as a URI
    // Create FormData with the file URI
    const formData = new FormData();
    
    // @ts-ignore - React Native's FormData supports { uri, type, name } format
    formData.append('audio_file', {
      uri: audioUri,
      type: mimeType,
      name: filename,
    } as any);
    
    console.log('✅ FormData created with audio URI');

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

