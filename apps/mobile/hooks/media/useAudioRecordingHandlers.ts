import { useState } from 'react';
import * as Haptics from 'expo-haptics';
import type { useAudioRecorder } from './useAudioRecorder';
import type { useAgentManager } from '../ui/useAgentManager';
import { saveAudioToFileSystem, deleteCachedAudio } from '@/lib/chat/transcription';

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
      
      // With expo-av, the file is already saved by stopAndUnloadAsync()
      // We can use it directly without copying
      console.log('✅ Using audio file directly from:', recordingUri);
      
      // DON'T reset yet - we need the file for transcription
      // The reset will happen after transcription or on error
      
      console.log('📤 Processing audio recording');
      console.log('📊 Audio data:', {
        uri: recordingUri,
        duration: result?.duration,
        agent: agentManager.selectedAgent?.name || 'Unknown',
      });
      
      // Transcribe from the original file
      if (transcribeAndAddToInput) {
        console.log('🎤 Transcribing audio...');
        setIsProcessing(true);
        try {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await transcribeAndAddToInput(recordingUri);
          console.log('✅ Audio transcribed and added to input');
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch (error) {
          console.error('❌ Transcription failed:', error);
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          await audioRecorder.reset();
          throw error;
        } finally {
          setIsProcessing(false);
        }
      } else {
        console.warn('⚠️ No transcription function provided');
      }
      
      // NOW we can reset the recorder (file is safely used for transcription)
      await audioRecorder.reset();
      console.log('✅ Audio recorder reset');
    } else {
      console.warn('⚠️ Not recording, cannot send audio');
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

