import { create } from 'zustand';
import { Audio } from 'expo-av';
import { API_URL, getAuthHeaders } from '@/api/config';
import { log } from '@/lib/logger';

type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

interface VoicePlayerStore {
  // State
  state: PlayerState;
  text: string | null;
  audioUrls: string[];
  currentIndex: number;
  error: string | null;
  sound: Audio.Sound | null;

  // Actions
  playText: (text: string) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  replay: () => Promise<void>;
  togglePlayPause: () => Promise<void>;
  close: () => Promise<void>;
  _cleanup: () => Promise<void>;
  _playIndex: (index: number) => Promise<void>;
}

export const useVoicePlayerStore = create<VoicePlayerStore>((set, get) => ({
  state: 'idle',
  text: null,
  audioUrls: [],
  currentIndex: 0,
  error: null,
  sound: null,

  _cleanup: async () => {
    const { sound } = get();
    if (sound) {
      try {
        await sound.stopAsync();
        await sound.unloadAsync();
      } catch (e) {
        // Ignore cleanup errors
      }
      set({ sound: null });
    }
  },

  _playIndex: async (index: number) => {
    const { audioUrls, _cleanup } = get();

    if (index >= audioUrls.length) {
      // All chunks played
      log.log('[VoicePlayer] All chunks finished');
      set({ state: 'ended', currentIndex: 0 });
      return;
    }

    await _cleanup();

    const url = audioUrls[index];
    log.log(`[VoicePlayer] Playing chunk ${index + 1}/${audioUrls.length}:`, url.slice(0, 80) + '...');

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true },
        (status) => {
          if (status.isLoaded && status.didJustFinish) {
            // Play next chunk
            const nextIndex = index + 1;
            log.log(`[VoicePlayer] Chunk ${index + 1} finished, next: ${nextIndex + 1}`);
            get()._playIndex(nextIndex);
          }
        }
      );

      set({ sound, state: 'playing', currentIndex: index });
    } catch (e: any) {
      log.error('[VoicePlayer] Error playing chunk:', e);
      set({ state: 'error', error: e?.message || 'Failed to play audio' });
    }
  },

  playText: async (text: string) => {
    const { _cleanup } = get();

    // Cleanup any existing playback
    await _cleanup();

    set({ state: 'loading', text, error: null, audioUrls: [], currentIndex: 0 });

    try {
      // Setup audio mode early for iOS - must be done before any audio operations
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeIOS: 1, // DoNotMix - don't let other audio interrupt
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      // Call voice generation API
      const headers = await getAuthHeaders();

      // Clean text - remove problematic characters
      const cleanedText = text
        .replace(/[\r\n]+/g, ' ')  // Replace newlines with spaces
        .replace(/\s+/g, ' ')       // Collapse multiple spaces
        .trim();

      log.log('[VoicePlayer] === VOICE GENERATION REQUEST ===');
      log.log('[VoicePlayer] Original text length:', text.length);
      log.log('[VoicePlayer] Cleaned text length:', cleanedText.length);
      log.log('[VoicePlayer] Text preview (first 150):', cleanedText.slice(0, 150));
      log.log('[VoicePlayer] API endpoint:', `${API_URL}/voice/generate`);

      const requestBody = {
        text: cleanedText,
        reference_audio: 'https://heprlhlltebrxydgtsjs.supabase.co/storage/v1/object/public/image-uploads/public-files/marko.mp3',
      };

      const response = await fetch(`${API_URL}/voice/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      log.log('[VoicePlayer] === VOICE GENERATION RESPONSE ===');
      log.log('[VoicePlayer] Response status:', response.status);

      if (!response.ok) {
        let errorDetail = `Voice generation failed (${response.status})`;
        try {
          const errorData = await response.json();
          errorDetail = errorData.detail || errorData.message || errorDetail;
        } catch {
          const textError = await response.text().catch(() => '');
          if (textError) errorDetail = textError;
        }
        throw new Error(errorDetail);
      }

      const data = await response.json();
      log.log('[VoicePlayer] Audio URLs:', data.audio_urls?.length || 0);
      log.log('[VoicePlayer] Char count:', data.char_count);
      log.log('[VoicePlayer] Chunk count:', data.chunk_count);
      log.log('[VoicePlayer] Cost:', data.cost);

      const audioUrls = data.audio_urls;
      if (!audioUrls || audioUrls.length === 0) {
        throw new Error('No audio URLs returned from server');
      }

      set({ audioUrls });

      // Start playing first chunk
      await get()._playIndex(0);

    } catch (error: any) {
      const errorMessage = error?.message || error?.detail || (typeof error === 'string' ? error : 'Failed to generate voice');
      log.error('[VoicePlayer] Error:', errorMessage, error);
      set({
        state: 'error',
        error: errorMessage
      });
    }
  },

  pause: async () => {
    const { sound, state } = get();
    if (sound && state === 'playing') {
      try {
        await sound.pauseAsync();
        set({ state: 'paused' });
      } catch (e) {
        log.error('[VoicePlayer] Pause error:', e);
      }
    }
  },

  resume: async () => {
    const { sound, state } = get();
    if (sound && state === 'paused') {
      try {
        await sound.playAsync();
        set({ state: 'playing' });
      } catch (e) {
        log.error('[VoicePlayer] Resume error:', e);
      }
    }
  },

  replay: async () => {
    const { state, audioUrls, _playIndex } = get();
    if (state === 'ended' && audioUrls.length > 0) {
      log.log('[VoicePlayer] Replaying from start');
      await _playIndex(0);
    }
  },

  togglePlayPause: async () => {
    const { state, pause, resume, replay } = get();
    if (state === 'playing') {
      await pause();
    } else if (state === 'ended') {
      await replay();
    } else if (state === 'paused') {
      await resume();
    }
  },

  close: async () => {
    const { _cleanup } = get();
    await _cleanup();
    set({
      state: 'idle',
      text: null,
      audioUrls: [],
      currentIndex: 0,
      error: null
    });
  },
}));
