/**
 * Audio Transcription API
 * 
 * Handles audio file transcription using backend Whisper API
 */

import { API_URL, getAuthToken } from '@/api/config';

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
    
    console.log('📤 Reading audio file into memory...');
    console.log('📊 File:', filename, 'Type:', mimeType);
    
    // Read the file into a Blob IMMEDIATELY before it gets deleted
    // This is critical because React Native FormData reads files asynchronously
    const fileBlob = await fetch(audioUri).then(r => r.blob());
    console.log('✅ Audio file read into memory:', fileBlob.size, 'bytes');
    
    // Create FormData with the Blob (not the URI)
    const formData = new FormData();
    formData.append('audio_file', fileBlob, filename);

    console.log('📤 Uploading audio for transcription');
    console.log('📊 API URL:', `${API_URL}/transcription`);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    try {
      // Make API request with timeout
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
      throw new Error('Network error. Please check your connection and ensure the backend is running.');
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

