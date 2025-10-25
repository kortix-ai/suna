/**
 * Audio Transcription API
 * 
 * Handles audio file transcription using backend Whisper API
 */

import { API_URL, getAuthToken } from '@/api/config';
import * as FileSystem from 'expo-file-system';

export interface TranscriptionResult {
  text: string;
}

export interface TranscriptionError {
  error: string;
  detail?: string;
}

/**
 * Transcribe audio file to text
 * 
 * @param audioUri - Local URI of the audio file
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

    // Extract filename from URI or use default
    const filename = audioUri.split('/').pop() || 'recording.m4a';
    
    // Determine MIME type based on file extension
    let mimeType = 'audio/m4a';
    if (filename.endsWith('.mp3')) {
      mimeType = 'audio/mp3';
    } else if (filename.endsWith('.wav')) {
      mimeType = 'audio/wav';
    } else if (filename.endsWith('.webm')) {
      mimeType = 'audio/webm';
    }
    
    console.log('📤 Preparing audio file for upload...');
    console.log('📊 File:', filename, 'Type:', mimeType);
    console.log('📊 File URI:', audioUri);
    
    // CRITICAL: Read the file into base64 IMMEDIATELY
    // React Native's FormData reads file URIs asynchronously during fetch,
    // which means the file might be deleted before it's read.
    // Solution: Read it into memory NOW as base64.
    console.log('📖 Reading file into base64...');
    const base64 = await FileSystem.readAsStringAsync(audioUri, {
      encoding: 'base64',
    });
    console.log('✅ File read into memory:', base64.length, 'chars');
    
    // Convert base64 to Blob
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });
    console.log('✅ Blob created:', blob.size, 'bytes');
    
    // Create FormData with the Blob (now safely in memory)
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
 * @param audioUri - Local URI of the audio file
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

