import { Audio } from 'expo-av';
import { useState, useRef, useEffect, useCallback } from 'react';
import { log } from '@/lib/logger';

type RecorderState = 'idle' | 'recording' | 'recorded' | 'playing';

const WAVEFORM_BARS = 45;

// Global mutex to prevent concurrent recording operations
let globalRecordingLock = false;
let globalRecordingInstance: Audio.Recording | null = null;

/**
 * Force cleanup of any global recording instance
 * This handles the expo-av singleton limitation
 */
async function forceCleanupGlobalRecording(): Promise<void> {
  if (globalRecordingInstance) {
    log.log('🧹 Force cleaning up global recording instance...');
    try {
      const status = await globalRecordingInstance.getStatusAsync();
      if (status.isRecording) {
        await globalRecordingInstance.stopAndUnloadAsync();
      } else if (status.canRecord) {
        await globalRecordingInstance.stopAndUnloadAsync();
      }
    } catch (err) {
      // Recording might already be unloaded, that's fine
      log.log('⚠️ Global recording cleanup (expected):', err);
    }
    globalRecordingInstance = null;
  }
  
  // Reset audio mode to clear any lingering state
  try {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
  } catch (err) {
    log.log('⚠️ Could not reset audio mode:', err);
  }
}

export function useAudioRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioLevels, setAudioLevels] = useState<number[]>(Array(WAVEFORM_BARS).fill(0));
  
  const recordingRef = useRef<Audio.Recording | null>(null);
  const playbackRef = useRef<Audio.Sound | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const meteringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isStartingRef = useRef(false);
  const mountedRef = useRef(true);

  const isRecording = state === 'recording';
  const isPlaying = state === 'playing';
  const hasRecording = state === 'recorded' || state === 'playing';

  // Cleanup intervals helper
  const cleanupIntervals = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (meteringIntervalRef.current) {
      clearInterval(meteringIntervalRef.current);
      meteringIntervalRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupIntervals();
      
      // Cleanup recording on unmount
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (playbackRef.current) {
        playbackRef.current.unloadAsync().catch(() => {});
        playbackRef.current = null;
      }
    };
  }, [cleanupIntervals]);

  const startRecording = useCallback(async () => {
    // Prevent concurrent starts
    if (isStartingRef.current || globalRecordingLock) {
      log.log('⚠️ Recording already in progress or starting, skipping...');
      return;
    }

    isStartingRef.current = true;
    globalRecordingLock = true;

    try {
      log.log('🎤 Requesting audio permissions...');
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        throw new Error('Audio permission not granted');
      }

      // Force cleanup any existing global recording
      await forceCleanupGlobalRecording();
      
      // Also cleanup our local ref
      if (recordingRef.current) {
        try {
          await recordingRef.current.stopAndUnloadAsync();
        } catch (err) {
          // Ignore - might already be cleaned
        }
        recordingRef.current = null;
      }

      // Clean up any running intervals
      cleanupIntervals();

      // Small delay to ensure cleanup is complete
      await new Promise(resolve => setTimeout(resolve, 100));

      log.log('🎤 Setting audio mode for recording...');
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      log.log('🎤 Creating new recording...');
      const recording = new Audio.Recording();
      
      // Store in global before prepare
      globalRecordingInstance = recording;
      
      log.log('🎤 Preparing to record...');
      const recordingOptions = {
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      };
      
      await recording.prepareToRecordAsync(recordingOptions);
      
      if (!mountedRef.current) {
        await recording.stopAndUnloadAsync();
        globalRecordingInstance = null;
        return;
      }
      
      log.log('🎤 Starting async recording...');
      await recording.startAsync();
      
      if (!mountedRef.current) {
        await recording.stopAndUnloadAsync();
        globalRecordingInstance = null;
        return;
      }
      
      recordingRef.current = recording;
      setState('recording');
      setRecordingDuration(0);
      setAudioLevels(Array(WAVEFORM_BARS).fill(0));

      // Start duration counter
      durationIntervalRef.current = setInterval(() => {
        if (mountedRef.current) {
          setRecordingDuration((prev) => prev + 1);
        }
      }, 1000);

      // Start audio level monitoring
      let lastLevel = 0;
      meteringIntervalRef.current = setInterval(async () => {
        if (recordingRef.current && mountedRef.current) {
          try {
            const status = await recordingRef.current.getStatusAsync();
            if (status.isRecording && typeof status.metering === 'number') {
              const db = status.metering;
              // Normalize dB to 0-1 range
              // -60 dB = silence, -5 dB = loud
              const minDB = -55;
              const maxDB = -10;
              const rawLevel = Math.max(0, Math.min(1, (db - minDB) / (maxDB - minDB)));
              
              // Light smoothing for responsive but not jumpy animation
              const smoothingFactor = 0.5;
              const smoothedLevel = lastLevel + (rawLevel - lastLevel) * smoothingFactor;
              lastLevel = smoothedLevel;
              
              setAudioLevel(smoothedLevel);
              setAudioLevels(prev => [...prev.slice(1), smoothedLevel]);
            }
          } catch (err) {
            // Ignore metering errors - recording might be stopping
          }
        }
      }, 30); // 30ms for responsive updates

      log.log('✅ Recording started successfully');
    } catch (error) {
      log.error('❌ Failed to start recording:', error);
      
      // Full cleanup on error
      cleanupIntervals();
      
      if (recordingRef.current) {
        try {
          await recordingRef.current.stopAndUnloadAsync();
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }
        recordingRef.current = null;
      }
      
      globalRecordingInstance = null;
      
      // Reset audio mode
      try {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      } catch (err) {
        // Ignore
      }
      
      if (mountedRef.current) {
        setAudioLevel(0);
        setAudioLevels(Array(WAVEFORM_BARS).fill(0));
        setState('idle');
      }
      
      throw error;
    } finally {
      isStartingRef.current = false;
      globalRecordingLock = false;
    }
  }, [cleanupIntervals]);

  const stopRecording = useCallback(async () => {
    log.log('🎤 Stopping recording...');
    
    if (state !== 'recording' || !recordingRef.current) {
      log.log('❌ Not in recording state or no recording ref');
      return null;
    }

    const currentDuration = recordingDuration;
    
    try {
      cleanupIntervals();
      
      setAudioLevel(0);
      setAudioLevels(Array(WAVEFORM_BARS).fill(0));

      const recording = recordingRef.current;
      recordingRef.current = null;
      globalRecordingInstance = null;

      log.log('🛑 Stopping and unloading...');
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      
      log.log('✅ Recording stopped, URI:', uri);
      log.log('⏱️ Duration:', currentDuration, 'seconds');

      if (mountedRef.current) {
        setAudioUri(uri);
        setState('recorded');
      }
      
      return { uri, duration: currentDuration };
    } catch (error) {
      log.error('❌ Failed to stop recording:', error);
      
      cleanupIntervals();
      globalRecordingInstance = null;
      
      if (mountedRef.current) {
        setAudioLevel(0);
        setAudioLevels(Array(WAVEFORM_BARS).fill(0));
        setState('idle');
      }
      
      return null;
    }
  }, [state, recordingDuration, cleanupIntervals]);

  const cancelRecording = useCallback(async () => {
    log.log('🎤 Canceling recording...');
    
    if (state !== 'recording') {
      log.log('⚠️ Not recording, nothing to cancel');
      return;
    }

    try {
      cleanupIntervals();
      
      if (recordingRef.current) {
        await recordingRef.current.stopAndUnloadAsync();
        recordingRef.current = null;
      }
      
      globalRecordingInstance = null;

      if (mountedRef.current) {
        setAudioLevel(0);
        setAudioLevels(Array(WAVEFORM_BARS).fill(0));
        setState('idle');
        setRecordingDuration(0);
        setAudioUri(null);
      }
      
      log.log('✅ Recording canceled');
    } catch (error) {
      log.error('❌ Failed to cancel recording:', error);
      
      cleanupIntervals();
      recordingRef.current = null;
      globalRecordingInstance = null;
      
      if (mountedRef.current) {
        setAudioLevel(0);
        setAudioLevels(Array(WAVEFORM_BARS).fill(0));
        setState('idle');
        setRecordingDuration(0);
        setAudioUri(null);
      }
    }
  }, [state, cleanupIntervals]);

  const playAudio = useCallback(async () => {
    if (!audioUri) {
      log.log('❌ No audio to play');
      return;
    }

    try {
      log.log('▶️ Playing audio:', audioUri);
      
      const { sound } = await Audio.Sound.createAsync({ uri: audioUri });
      playbackRef.current = sound;
      
      await sound.playAsync();
      
      if (mountedRef.current) {
        setState('playing');
      }

      log.log('✅ Playback started');
    } catch (error) {
      log.error('❌ Failed to play audio:', error);
      if (mountedRef.current) {
        setState('recorded');
      }
    }
  }, [audioUri]);

  const pauseAudio = useCallback(async () => {
    try {
      if (playbackRef.current) {
        log.log('⏸️ Pausing audio');
        await playbackRef.current.pauseAsync();
        if (mountedRef.current) {
          setState('recorded');
        }
      }
    } catch (error) {
      log.error('❌ Failed to pause audio:', error);
      if (mountedRef.current) {
        setState('recorded');
      }
    }
  }, []);

  const togglePlayback = useCallback(async () => {
    if (isPlaying) {
      await pauseAudio();
    } else {
      await playAudio();
    }
  }, [isPlaying, pauseAudio, playAudio]);

  const deleteRecording = useCallback(async () => {
    log.log('🗑️ Deleting recording');

    if (playbackRef.current) {
      try {
        await playbackRef.current.unloadAsync();
      } catch (error) {
        log.log('⚠️ Player already cleaned up');
      }
      playbackRef.current = null;
    }

    if (mountedRef.current) {
      setState('idle');
      setAudioUri(null);
      setRecordingDuration(0);
    }
    
    log.log('✅ Recording deleted');
  }, []);

  const reset = useCallback(async () => {
    log.log('🔄 Resetting audio recorder');
    
    cleanupIntervals();
    
    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch (err) {
        // Ignore
      }
      recordingRef.current = null;
    }
    
    globalRecordingInstance = null;
    
    if (state !== 'idle' || audioUri) {
      await deleteRecording();
    }
  }, [state, audioUri, deleteRecording, cleanupIntervals]);

  return {
    // State
    isRecording,
    isPlaying,
    hasRecording,
    recordingDuration,
    audioUri,
    audioLevel,
    audioLevels,
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
