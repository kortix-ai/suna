/**
 * Audio Transcription API
 * 
 * Handles audio file transcription using backend Whisper API
 * Uses expo-file-system legacy API for reliable async operations
 */

import { API_URL, getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';

interface TranscriptionResult {
  text: string;
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
  _onProgress?: (progress: number) => void
): Promise<string> {
  try {
    log.log('🎤 Transcribing audio:', audioUri);
    
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
    
    log.log('📤 Preparing audio file for upload...');
    log.log('📊 File:', filename, 'Type:', mimeType);
    
    // In React Native, we send the file directly as a URI
    // Create FormData with the file URI
    const formData = new FormData();
    
    // @ts-ignore - React Native's FormData supports { uri, type, name } format
    formData.append('audio_file', {
      uri: audioUri,
      type: mimeType,
      name: filename,
    } as any);
    
    log.log('✅ FormData created with audio URI');

    log.log('📤 Uploading audio for transcription');
    log.log('📊 API URL:', `${API_URL}/transcription`);
    log.log('📊 Auth token (first 20 chars):', token.substring(0, 20) + '...');

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      log.error('⏰ Request timeout after 60 seconds');
      controller.abort();
    }, 60000); // 60 second timeout

    try {
      // Make API request with timeout
      log.log('📤 Sending fetch request...');
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
      log.log('📡 Transcription response status:', response.status);
      log.log('📡 Response headers:', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

      if (!response.ok) {
        const errorText = await response.text();
        log.error('❌ Transcription failed with status:', response.status);
        log.error('❌ Response text:', errorText);
        
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
      log.log('✅ Transcription successful');
      log.log('📝 Transcribed text length:', result.text.length);
      log.log('📝 Transcribed text:', result.text);

      return result.text;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      
      if (fetchError.name === 'AbortError') {
        log.error('❌ Transcription timeout (60s)');
        throw new Error('Transcription request timed out. Please try a shorter recording.');
      }
      
      throw fetchError;
    }
  } catch (error: any) {
    log.error('❌ Transcription error:', error);
    log.error('❌ Error details:', {
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
