import { create } from 'zustand';

type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

interface VoicePlayerState {
  // State
  state: PlayerState;
  text: string | null;
  audioUrls: string[];
  currentIndex: number;
  error: string | null;
  audioElement: HTMLAudioElement | null;

  // Actions
  playText: (text: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  replay: () => void;
  togglePlayPause: () => void;
  close: () => void;
  _cleanup: () => void;
  _playIndex: (index: number) => void;
}

export const useVoicePlayerStore = create<VoicePlayerState>((set, get) => ({
  state: 'idle',
  text: null,
  audioUrls: [],
  currentIndex: 0,
  error: null,
  audioElement: null,

  _cleanup: () => {
    const { audioElement } = get();
    if (audioElement) {
      audioElement.pause();
      audioElement.src = '';
      audioElement.onended = null;
      audioElement.onerror = null;
    }
    set({ audioElement: null });
  },

  _playIndex: (index: number) => {
    const { audioUrls, _cleanup } = get();

    if (index >= audioUrls.length) {
      // All chunks played
      console.log('[VoicePlayer] All chunks finished');
      set({ state: 'ended', currentIndex: 0 });
      return;
    }

    _cleanup();

    const url = audioUrls[index];
    console.log(`[VoicePlayer] Playing chunk ${index + 1}/${audioUrls.length}:`, url.slice(0, 80) + '...');

    const audio = new Audio(url);

    audio.onended = () => {
      const nextIndex = index + 1;
      console.log(`[VoicePlayer] Chunk ${index + 1} finished, next: ${nextIndex + 1}`);
      get()._playIndex(nextIndex);
    };

    audio.onerror = (e) => {
      console.error('[VoicePlayer] Error playing chunk:', e);
      set({ state: 'error', error: 'Failed to play audio' });
    };

    audio.play().then(() => {
      set({ audioElement: audio, state: 'playing', currentIndex: index });
    }).catch((e) => {
      console.error('[VoicePlayer] Error starting playback:', e);
      set({ state: 'error', error: e?.message || 'Failed to play audio' });
    });
  },

  playText: async (text: string) => {
    const { _cleanup } = get();

    // Cleanup any existing playback
    _cleanup();

    set({ state: 'loading', text, error: null, audioUrls: [], currentIndex: 0 });

    try {
      // Clean text - remove problematic characters
      const cleanedText = text
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      console.log('[VoicePlayer] === VOICE GENERATION REQUEST ===');
      console.log('[VoicePlayer] Text length:', cleanedText.length);
      console.log('[VoicePlayer] Text preview:', cleanedText.slice(0, 150));

      const requestBody = {
        text: cleanedText,
        reference_audio: 'https://heprlhlltebrxydgtsjs.supabase.co/storage/v1/object/public/image-uploads/public-files/marko.mp3',
      };

      // Get auth token
      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/voice/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(requestBody),
      });

      console.log('[VoicePlayer] Response status:', response.status);

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
      console.log('[VoicePlayer] Audio URLs:', data.audio_urls?.length || 0);
      console.log('[VoicePlayer] Char count:', data.char_count);
      console.log('[VoicePlayer] Chunk count:', data.chunk_count);
      console.log('[VoicePlayer] Cost:', data.cost);

      const audioUrls = data.audio_urls;
      if (!audioUrls || audioUrls.length === 0) {
        throw new Error('No audio URLs returned from server');
      }

      set({ audioUrls });

      // Start playing first chunk
      get()._playIndex(0);

    } catch (error: any) {
      const errorMessage = error?.message || 'Failed to generate voice';
      console.error('[VoicePlayer] Error:', errorMessage, error);
      set({
        state: 'error',
        error: errorMessage
      });
    }
  },

  pause: () => {
    const { audioElement, state } = get();
    if (audioElement && state === 'playing') {
      audioElement.pause();
      set({ state: 'paused' });
    }
  },

  resume: () => {
    const { audioElement, state } = get();
    if (audioElement && state === 'paused') {
      audioElement.play();
      set({ state: 'playing' });
    }
  },

  replay: () => {
    const { state, audioUrls, _playIndex } = get();
    if (state === 'ended' && audioUrls.length > 0) {
      console.log('[VoicePlayer] Replaying from start');
      _playIndex(0);
    }
  },

  togglePlayPause: () => {
    const { state, pause, resume, replay } = get();
    if (state === 'playing') {
      pause();
    } else if (state === 'ended') {
      replay();
    } else if (state === 'paused') {
      resume();
    }
  },

  close: () => {
    const { _cleanup } = get();
    _cleanup();
    set({
      state: 'idle',
      text: null,
      audioUrls: [],
      currentIndex: 0,
      error: null
    });
  },
}));
