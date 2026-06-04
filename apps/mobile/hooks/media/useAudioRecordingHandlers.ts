import { useState } from 'react';
import * as Haptics from 'expo-haptics';
import type { useAudioRecorder } from './useAudioRecorder';
import type { useAgentManager } from '../ui/useAgentManager';
import { saveAudioToFileSystem, deleteCachedAudio } from '@/lib/chat/transcription';
import { log } from '@/lib/logger';

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
  const [isProcessing, setIsProcessing] = useState(false);

  const isTranscribing = isProcessing;
  // Handle starting audio recording
  const handleStartRecording = async () => {
    log.log('🎤 Starting inline audio recording');
    log.log('📳 Haptic feedback: Start recording');
    
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await audioRecorder.startRecording();
  };

  // Handle canceling recording
  const handleCancelRecording = async () => {
    log.log('❌ Canceling audio recording');
    log.log('📳 Haptic feedback: Cancel');
    
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await audioRecorder.cancelRecording();
  };

  // Handle sending recorded audio
  const handleSendAudio = async () => {
    log.log('📤 handleSendAudio called');
    log.log('📊 isRecording state:', audioRecorder.isRecording);
    
    if (audioRecorder.isRecording) {
      log.log('📳 Haptic feedback: Stop recording');
      
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      // Stop recording first to get the final URI
      log.log('🎤 Stopping recording to finalize audio file...');
      const result = await audioRecorder.stopRecording();
      log.log('📊 Stop recording result:', result);
      
      if (!result || !result.uri) {
        log.error('❌ No recording URI available after stopping');
        await audioRecorder.reset();
        throw new Error('Failed to get recording URI');
      }
      
      const recordingUri = result.uri;
      log.log('📊 Recording URI captured:', recordingUri);
      
      // With expo-av, the file is already saved by stopAndUnloadAsync()
      // We can use it directly without copying
      log.log('✅ Using audio file directly from:', recordingUri);
      
      // DON'T reset yet - we need the file for transcription
      // The reset will happen after transcription or on error
      
      log.log('📤 Processing audio recording');
      log.log('📊 Audio data:', {
        uri: recordingUri,
        duration: result?.duration,
        agent: agentManager.selectedAgent?.name || 'Unknown',
      });
      
      // Transcribe from the original file
      if (transcribeAndAddToInput) {
        log.log('🎤 Transcribing audio...');
        setIsProcessing(true);
        try {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await transcribeAndAddToInput(recordingUri);
          log.log('✅ Audio transcribed and added to input');
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch (error) {
          log.error('❌ Transcription failed:', error);
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          await audioRecorder.reset();
          throw error;
        } finally {
          setIsProcessing(false);
        }
      } else {
        log.warn('⚠️ No transcription function provided');
      }
      
      // NOW we can reset the recorder (file is safely used for transcription)
      await audioRecorder.reset();
      log.log('✅ Audio recorder reset');
    } else {
      log.warn('⚠️ Not recording, cannot send audio');
    }
  };

  return {
    handleStartRecording,
    handleCancelRecording,
    handleSendAudio,
    isTranscribing,
    isProcessing,
  };
}

