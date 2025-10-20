import { 
  useAudioRecorder as useExpoAudioRecorder,
  useAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { useState, useRef } from 'react';

type RecorderState = 'idle' | 'recording' | 'recorded' | 'playing';

export function useAudioRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  
  const audioRecorder = useExpoAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const audioPlayer = useAudioPlayer(audioUri || undefined);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRecording = state === 'recording';
  const isPlaying = state === 'playing';
  const hasRecording = state === 'recorded' || state === 'playing';

  const startRecording = async () => {
    try {
      console.log('🎤 Requesting audio permissions...');
      const { granted } = await requestRecordingPermissionsAsync();
      
      if (!granted) {
        console.log('❌ Audio permission denied');
        setState('idle');
        return;
      }

      console.log('🎤 Setting audio mode for recording...');
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      console.log('🎤 Starting recording...');
      audioRecorder.record();

      setState('recording');
      setRecordingDuration(0);

      // Start duration counter
      durationIntervalRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);

      console.log('✅ Recording started - State:', 'recording');
      console.log('📊 Recorder isRecording:', audioRecorder.isRecording);
    } catch (error) {
      console.error('❌ Failed to start recording:', error);
      // Clean up on error
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      setState('idle');
      // Try to reset audio mode
      try {
        await setAudioModeAsync({ allowsRecording: false });
      } catch (modeError) {
        console.warn('⚠️ Failed to reset audio mode after error:', modeError);
      }
    }
  };

  const stopRecording = async () => {
    console.log('🎤 Stopping recording...');
    console.log('📊 Current state:', state);
    console.log('📊 Recorder isRecording:', audioRecorder.isRecording);
    
    // Check our local state instead of recorder state
    if (state !== 'recording') {
      console.log('❌ Not in recording state');
      return null;
    }

    try {
      // Clear duration interval
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }

      // Stop the recorder if it's actually recording
      if (audioRecorder.isRecording) {
        await audioRecorder.stop();
      }
      
      // Reset audio mode after recording
      try {
        await setAudioModeAsync({
          allowsRecording: false,
        });
      } catch (modeError) {
        console.warn('⚠️ Failed to reset audio mode:', modeError);
      }
      
      const uri = audioRecorder.uri;
      console.log('✅ Recording stopped');
      console.log('📊 Recording URI:', uri);
      console.log('⏱️ Duration:', recordingDuration, 'seconds');

      setAudioUri(uri);
      setState('recorded');
      
      return { uri, duration: recordingDuration };
    } catch (error) {
      console.error('❌ Failed to stop recording:', error);
      // Force state reset even on error
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      setState('idle');
      return null;
    }
  };

  const cancelRecording = async () => {
    console.log('🎤 Canceling recording...');
    
    // Check our local state instead of recorder state
    if (state !== 'recording') {
      console.log('⚠️ Not recording, nothing to cancel');
      return;
    }

    try {
      // Clear duration interval
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }

      // Stop the recorder if it's actually recording
      if (audioRecorder.isRecording) {
        await audioRecorder.stop();
      }
      
      // Reset audio mode after canceling
      try {
        await setAudioModeAsync({
          allowsRecording: false,
        });
      } catch (modeError) {
        console.warn('⚠️ Failed to reset audio mode:', modeError);
      }

      setState('idle');
      setRecordingDuration(0);
      setAudioUri(null);
      
      console.log('✅ Recording canceled');
    } catch (error) {
      console.error('❌ Failed to cancel recording:', error);
      // Force state reset even if stop fails
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      setState('idle');
      setRecordingDuration(0);
      setAudioUri(null);
    }
  };

  const playAudio = async () => {
    if (!audioUri) {
      console.log('❌ No audio to play');
      return;
    }

    try {
      console.log('▶️ Playing audio:', audioUri);
      
      audioPlayer.play();
      setState('playing');

      console.log('✅ Playback started');
    } catch (error) {
      console.error('❌ Failed to play audio:', error);
      setState('recorded');
    }
  };

  const pauseAudio = async () => {
    if (!audioPlayer.playing) {
      return;
    }

    try {
      console.log('⏸️ Pausing audio');
      audioPlayer.pause();
      setState('recorded');
    } catch (error) {
      console.error('❌ Failed to pause audio:', error);
    }
  };

  const togglePlayback = async () => {
    if (isPlaying) {
      await pauseAudio();
    } else {
      await playAudio();
    }
  };

  const deleteRecording = async () => {
    console.log('🗑️ Deleting recording');

    // Clean up player
    if (audioPlayer.playing) {
      try {
        audioPlayer.pause();
      } catch (error) {
        console.error('❌ Failed to stop playback:', error);
      }
    }

    setState('idle');
    setAudioUri(null);
    setRecordingDuration(0);
    console.log('✅ Recording deleted');
  };

  const reset = async () => {
    console.log('🔄 Resetting audio recorder');
    await deleteRecording();
  };

  return {
    // State
    isRecording,
    isPlaying,
    hasRecording,
    recordingDuration,
    audioUri,
    state,
    
    // Recording controls
    startRecording,
    stopRecording,
    cancelRecording,
    
    // Playback controls
    playAudio,
    pauseAudio,
    togglePlayback,
    
    // Management
    deleteRecording,
    reset,
  };
}

