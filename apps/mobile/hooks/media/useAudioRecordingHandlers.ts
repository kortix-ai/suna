import * as Haptics from 'expo-haptics';
import type { useAudioRecorder } from './useAudioRecorder';
import type { useAgentManager } from '../ui/useAgentManager';
import type { useChat } from '../useChat';

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
      
      const result = await audioRecorder.stopRecording();
      console.log('📊 Stop recording result:', result);
      
      if (result && result.uri) {
        console.log('📤 Processing audio recording');
        console.log('📊 Audio data:', {
          uri: result.uri,
          duration: result.duration,
          agent: agentManager.selectedAgent?.name || 'Unknown',
        });
        
        // Transcribe audio and add to input if transcription function is provided
        if (transcribeAndAddToInput) {
          console.log('🎤 Transcribing audio...');
          try {
            await transcribeAndAddToInput(result.uri);
            console.log('✅ Audio transcribed and added to input');
            
            // Reset audio recorder AFTER successful transcription
            await audioRecorder.reset();
            console.log('✅ Audio recording processed and reset');
          } catch (error) {
            console.error('❌ Transcription failed:', error);
            // Still reset on error to clean up
            await audioRecorder.reset();
            console.log('🧹 Audio recorder reset after error');
          }
        } else {
          console.warn('⚠️ No transcription function provided');
          // Reset immediately if no transcription
          await audioRecorder.reset();
          console.log('✅ Audio recording processed and reset');
        }
      } else {
        console.warn('⚠️ No result from stopRecording');
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

