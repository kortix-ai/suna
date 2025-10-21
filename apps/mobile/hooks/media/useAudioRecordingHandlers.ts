import * as Haptics from 'expo-haptics';
import type { useAudioRecorder } from './useAudioRecorder';
import type { useAgentManager } from '../ui/useAgentManager';

/**
 * Custom hook for audio recording handlers with haptic feedback
 * 
 * Wraps audio recorder operations with:
 * - Haptic feedback for better UX
 * - Agent context integration
 * - Console logging
 */
export function useAudioRecordingHandlers(
  audioRecorder: ReturnType<typeof useAudioRecorder>,
  agentManager: ReturnType<typeof useAgentManager>
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
      
      if (result) {
        console.log('📤 Sending audio message');
        console.log('📊 Audio data:', {
          uri: result.uri,
          duration: result.duration,
          agent: agentManager.selectedAgent?.name || 'Unknown',
        });
        
        await audioRecorder.reset();
        console.log('✅ Audio recording sent and reset');
        // TODO: Implement actual send logic to backend
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

