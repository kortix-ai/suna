/**
 * Sound playback utility.
 *
 * Plays sound effects based on the user's selected sound pack and preferences.
 * Each pack maps sound events to mp3 files under `/sounds/<pack>/`.
 *
 * -----------------------------------------------------------------------
 * FILE PLACEMENT:
 *
 *   public/sounds/opencode/completion.mp3
 *   public/sounds/opencode/error.mp3
 *   public/sounds/opencode/notification.mp3
 *   public/sounds/opencode/send.mp3
 *
 *   public/sounds/kortix/completion.mp3
 *   public/sounds/kortix/error.mp3
 *   public/sounds/kortix/notification.mp3
 *   public/sounds/kortix/send.mp3
 *
 * Drop replacement mp3 files in these directories.  The filenames must
 * match the SoundEvent names exactly (completion, error, notification, send).
 * -----------------------------------------------------------------------
 */

import { useSoundStore, type SoundEvent, type SoundPack } from '@/stores/sound-store';

// ============================================================================
// Audio cache — reuse HTMLAudioElement instances to avoid re-fetching files
// ============================================================================

const audioCache = new Map<string, HTMLAudioElement>();

function getAudioPath(pack: SoundPack, event: SoundEvent): string {
  return `/sounds/${pack}/${event}.mp3`;
}

function getOrCreateAudio(path: string): HTMLAudioElement {
  let audio = audioCache.get(path);
  if (!audio) {
    audio = new Audio(path);
    audio.preload = 'auto';
    audioCache.set(path, audio);
  }
  return audio;
}

// ============================================================================
// Fallback: synthesised tones (used when mp3 files are missing)
// ============================================================================

const SYNTH_CONFIG: Record<SoundEvent, { freq: number; duration: number; type: OscillatorType }> = {
  completion: { freq: 880, duration: 0.3, type: 'sine' },
  error: { freq: 330, duration: 0.4, type: 'square' },
  notification: { freq: 660, duration: 0.25, type: 'sine' },
  send: { freq: 1200, duration: 0.1, type: 'sine' },
};

function playSynthFallback(event: SoundEvent, volume: number) {
  try {
    const AudioCtx = (typeof AudioContext !== 'undefined')
      ? AudioContext
      : (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const cfg = SYNTH_CONFIG[event];

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = cfg.type;
    osc.frequency.setValueAtTime(cfg.freq, ctx.currentTime);
    gain.gain.setValueAtTime(volume * 0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + cfg.duration);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + cfg.duration);

    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      ctx.close().catch(() => {});
    };
  } catch {
    // Silently ignore
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Play a sound for the given event, respecting the user's sound preferences.
 *
 * If the mp3 file fails to load (e.g. not yet replaced), falls back to a
 * synthesised tone via the Web Audio API.
 */
export function playSound(event: SoundEvent) {
  const { preferences } = useSoundStore.getState();

  // Pack disabled
  if (preferences.pack === 'off') return;

  // Event disabled
  if (preferences.events[event] === false) return;

  const volume = preferences.volume;
  if (volume <= 0) return;

  const path = getAudioPath(preferences.pack, event);
  const audio = getOrCreateAudio(path);

  // Clone the audio node so overlapping plays don't cut each other off
  audio.volume = volume;
  const playPromise = audio.play();

  if (playPromise) {
    playPromise.catch(() => {
      // mp3 missing or blocked — fall back to synth
      playSynthFallback(event, volume);
    });
  }
}

/**
 * Preview a specific sound event (used in settings UI).
 * Always plays regardless of event-level toggle (but respects pack & volume).
 */
export function previewSound(event: SoundEvent) {
  const { preferences } = useSoundStore.getState();

  if (preferences.pack === 'off') {
    // Even when off, preview with synth so user knows what they'll hear
    playSynthFallback(event, 0.5);
    return;
  }

  const volume = preferences.volume;
  const path = getAudioPath(preferences.pack, event);
  const audio = getOrCreateAudio(path);
  audio.volume = Math.max(volume, 0.2); // ensure audible for preview
  audio.currentTime = 0;
  const playPromise = audio.play();
  if (playPromise) {
    playPromise.catch(() => {
      playSynthFallback(event, Math.max(volume, 0.2));
    });
  }
}
