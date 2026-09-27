import { createAudioPlayer, setAudioModeAsync, type AudioSource } from 'expo-audio';
import { useSoundStore, type SoundEvent, type SoundPack } from '@/stores/sound-store';
import { resolveSoundAsset } from '@/lib/sounds-resolve';

// ---------------------------------------------------------------------------
// Bundled assets — the Kortix sound palette. Every event has its own file,
// no fallback needed.
// ---------------------------------------------------------------------------

const KORTIX_ASSETS: Record<SoundEvent, AudioSource> = {
  completion: require('@/assets/sounds/kortix/kortix_complete.wav'),
  notification: require('@/assets/sounds/kortix/kortix_attention.wav'),
  error: require('@/assets/sounds/kortix/kortix_error.wav'),
  send: require('@/assets/sounds/kortix/kortix_send.wav'),
};

function resolveAsset(pack: SoundPack, event: SoundEvent): AudioSource | null {
  return resolveSoundAsset(KORTIX_ASSETS, pack, event);
}

// ---------------------------------------------------------------------------
// Audio mode — call once before first playback so sounds work in silent mode
// on iOS and duck background audio instead of pausing it.
// ---------------------------------------------------------------------------

let audioModeConfigured = false;

async function ensureAudioMode() {
  if (audioModeConfigured) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: 'duckOthers',
    });
    audioModeConfigured = true;
  } catch {
    // non-fatal — sounds may still work
  }
}

/**
 * Dictation takes over the iOS audio session (record category). Call when it
 * ends so the next sound sets the playback mode again.
 */
export function resetAudioMode() {
  audioModeConfigured = false;
}

// ---------------------------------------------------------------------------
// Playback — each call creates a fresh player so rapid taps don't conflict.
// A player is not garbage-collected on its own: `remove()` releases it once
// playback finishes to avoid leaking native players.
// ---------------------------------------------------------------------------

async function play(asset: AudioSource, volume: number) {
  await ensureAudioMode();

  const player = createAudioPlayer(asset);
  player.volume = volume;
  const subscription = player.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish) {
      subscription.remove();
      player.remove();
    }
  });
  player.play();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function playSound(event: SoundEvent) {
  const { preferences } = useSoundStore.getState();
  if (preferences.pack === 'off') return;
  if (preferences.events[event] === false) return;
  if (preferences.volume <= 0) return;

  const asset = resolveAsset(preferences.pack, event);
  if (!asset) return;

  try {
    await play(asset, preferences.volume);
  } catch {
    // Silently ignore playback errors
  }
}

export async function previewSound(event: SoundEvent) {
  const { preferences } = useSoundStore.getState();
  const pack = preferences.pack === 'off' ? 'kortix' : preferences.pack;
  const volume = Math.max(preferences.pack === 'off' ? 0.5 : preferences.volume, 0.2);

  const asset = resolveAsset(pack, event);
  if (!asset) return;

  try {
    await play(asset, volume);
  } catch {
    // Silently ignore playback errors
  }
}
