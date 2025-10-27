import { Audio } from 'expo-av';
import { useState, useRef } from 'react';

type RecorderState = 'idle' | 'recording' | 'recorded' | 'playing';

export function useAudioRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  
  const recordingRef = useRef<Audio.Recording | null>(null);
  const playbackRef = useRef<Audio.Sound | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRecording = state === 'recording';
  const isPlaying = state === 'playing';
  const hasRecording = state === 'recorded' || state === 'playing';

  const startRecording = async () => {
    try {
      console.log('🎤 Requesting audio permissions...');
      await Audio.requestPermissionsAsync();

      console.log('🎤 Setting audio mode for recording...');
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      // Wait a bit for audio mode to settle
      await new Promise(resolve => setTimeout(resolve, 100));

      // CRITICAL: Clean up any existing recording first
      if (recordingRef.current) {
        console.log('🧹 Cleaning up existing recording...');
        try {
          await recordingRef.current.stopAndUnloadAsync();
        } catch (err) {
          console.log('⚠️ Could not stop existing recording, continuing...');
        }
        recordingRef.current = null;
        // Wait a bit more after cleanup
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log('🎤 Starting recording...');
      const recording = new Audio.Recording();
      
      console.log('🎤 Preparing to record...');
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      
      console.log('🎤 Starting async recording...');
      await recording.startAsync();
      
      recordingRef.current = recording;
      setState('recording');
      setRecordingDuration(0);

      // Start duration counter
      durationIntervalRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);

      console.log('✅ Recording started - State: recording');
    } catch (error) {
      console.error('❌ Failed to start recording:', error);
      
      // Try to clean up the recording object
      if (recordingRef.current) {
        try {
          await recordingRef.current.stopAndUnloadAsync();
        } catch (cleanupErr) {
          console.log('⚠️ Error during cleanup:', cleanupErr);
        }
        recordingRef.current = null;
      }
      
      // Clean up interval
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      
      setState('idle');
      
      throw error;
    }
  };

  const stopRecording = async () => {
    console.log('🎤 Stopping recording...');
    
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

      // Stop and unload recording
      if (recordingRef.current) {
        console.log('🛑 Stopping recording...');
        await recordingRef.current.stopAndUnloadAsync();
        const uri = recordingRef.current.getURI();
        console.log('✅ Recording stopped');
        console.log('📊 Recording URI:', uri);
        console.log('⏱️ Duration:', recordingDuration, 'seconds');

        setAudioUri(uri);
        setState('recorded');
        recordingRef.current = null;
        
        return { uri, duration: recordingDuration };
      }
      
      return null;
    } catch (error) {
      console.error('❌ Failed to stop recording:', error);
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

      // Stop recording
      if (recordingRef.current) {
        await recordingRef.current.stopAndUnloadAsync();
        recordingRef.current = null;
      }

      setState('idle');
      setRecordingDuration(0);
      setAudioUri(null);
      
      console.log('✅ Recording canceled');
    } catch (error) {
      console.error('❌ Failed to cancel recording:', error);
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
      
      const { sound } = await Audio.Sound.createAsync({ uri: audioUri });
      playbackRef.current = sound;
      
      await sound.playAsync();
      setState('playing');

      console.log('✅ Playback started');
    } catch (error) {
      console.error('❌ Failed to play audio:', error);
      setState('recorded');
    }
  };

  const pauseAudio = async () => {
    try {
      if (playbackRef.current) {
        console.log('⏸️ Pausing audio');
        await playbackRef.current.pauseAsync();
        setState('recorded');
      }
    } catch (error) {
      console.error('❌ Failed to pause audio:', error);
      setState('recorded');
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
    if (playbackRef.current) {
      try {
        await playbackRef.current.unloadAsync();
      } catch (error) {
        console.log('⚠️ Player already cleaned up');
      }
      playbackRef.current = null;
    }

    setState('idle');
    setAudioUri(null);
    setRecordingDuration(0);
    console.log('✅ Recording deleted');
  };

  const reset = async () => {
    console.log('🔄 Resetting audio recorder');
    
    if (state !== 'idle' || audioUri) {
      await deleteRecording();
    } else {
      console.log('⏭️ Already reset, skipping');
    }
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
