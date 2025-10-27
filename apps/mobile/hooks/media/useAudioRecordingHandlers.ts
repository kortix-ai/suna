import * as Haptics from 'expo-haptics';
import type { useAudioRecorder } from './useAudioRecorder';
import type { useAgentManager } from '../ui/useAgentManager';
import type { useChat } from '../useChat';
import { copyAudioToCache, deleteCachedAudio } from '@/lib/chat/transcription';

/**
 * Custom hook for audio recording handlers with haptic feedback and transcription
 * 
 * Wraps audio recorder operations with:
 * - Haptic feedback for better UX
 * - Agent context integration
 * - Audio transcription and input population
 * - Console logging
 */
export function useAudioRecordingHandlers(
  audioRecorder: ReturnType<typeof useAudioRecorder>,
  agentManager: ReturnType<typeof useAgentManager>,
  transcribeAndAddToInput?: (audioUri: string) => Promise<void>
) {
  // Handle starting audio recording
  const handleStartRecording = async () => {
    console.log('🎤 Starting inline audio recording');
    console.log('📳 Haptic feedback: Start recording');
    
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await audioRecorder.startRecording();
  };

  // Handle canceling recording
  const handleCancelRecording = async () => {
    console.log('❌ Canceling audio recording');
    console.log('📳 Haptic feedback: Cancel');
    
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await audioRecorder.cancelRecording();
  };

  // Handle sending recorded audio
  const handleSendAudio = async () => {
    console.log('📤 handleSendAudio called');
    console.log('📊 isRecording state:', audioRecorder.isRecording);
    
    if (audioRecorder.isRecording) {
      console.log('📳 Haptic feedback: Stop recording');
      
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      // Stop recording first to get the final URI
      console.log('🎤 Stopping recording to finalize audio file...');
      const result = await audioRecorder.stopRecording();
      console.log('📊 Stop recording result:', result);
      
      if (!result || !result.uri) {
        console.error('❌ No recording URI available after stopping');
        await audioRecorder.reset();
        throw new Error('Failed to get recording URI');
      }
      
      const recordingUri = result.uri;
      console.log('📊 Recording URI captured:', recordingUri);
      
      // CRITICAL: Add a small delay to ensure file is fully written to disk
      // The audio recorder may take a moment to finalize the file after stop()
      console.log('⏳ Waiting for file to finalize...');
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log('✅ File finalization wait complete');
      
      // Now copy the file to cache BEFORE resetting
      let cachedUri: string | null = null;
      try {
        console.log('📋 Copying audio to cache from:', recordingUri);
        cachedUri = await copyAudioToCache(recordingUri);
        console.log('✅ Audio file secured in cache:', cachedUri);
      } catch (copyError) {
        console.error('❌ Failed to copy audio to cache:', copyError);
        // Reset even on copy failure
        await audioRecorder.reset();
        throw copyError;
      }
      
      // NOW we can reset the recorder (file is safely in cache)
      await audioRecorder.reset();
      console.log('✅ Audio recorder reset (temporary file can be deleted safely)');
      
      if (cachedUri) {
        console.log('📤 Processing audio recording from cache');
        console.log('📊 Audio data:', {
          uri: cachedUri,
          duration: result?.duration,
          agent: agentManager.selectedAgent?.name || 'Unknown',
        });
        
        // Transcribe from the cached copy
        if (transcribeAndAddToInput) {
          console.log('🎤 Transcribing audio from cache...');
          try {
            await transcribeAndAddToInput(cachedUri);
            console.log('✅ Audio transcribed and added to input');
          } catch (error) {
            console.error('❌ Transcription failed:', error);
            throw error;
          } finally {
            // Always clean up the cached file, whether transcription succeeded or failed
            await deleteCachedAudio(cachedUri);
            console.log('🧹 Cached audio file cleaned up');
          }
        } else {
          console.warn('⚠️ No transcription function provided');
          // Clean up cached file even if not transcribing
          await deleteCachedAudio(cachedUri);
        }
      } else {
        console.warn('⚠️ No cached URI available');
      }
    } else {
      console.warn('⚠️ Not recording, cannot send audio');
    }
  };

  return {
    handleStartRecording,
    handleCancelRecording,
    handleSendAudio,
  };
}

