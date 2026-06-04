import { Audio, type AVPlaybackSource } from 'expo-av';
import { useSoundStore, type SoundEvent } from '@/stores/sound-store';

// ---------------------------------------------------------------------------
// Bundled assets — only files that actually exist on disk.
// Missing events (error, notification) fall back to completion.mp3.
// The opencode pack has no files yet, so it falls back to kortix.
// ---------------------------------------------------------------------------

const KORTIX_ASSETS: Partial<Record<SoundEvent, AVPlaybackSource>> = {
  completion: require('@/assets/sounds/kortix/completion.mp3'),
  send: require('@/assets/sounds/kortix/send.mp3'),
};

function resolveAsset(pack: string, event: SoundEvent): AVPlaybackSource | null {
  if (pack === 'kortix') {
    return KORTIX_ASSETS[event] ?? KORTIX_ASSETS.completion ?? null;
  }
  // opencode pack has no files yet — returns null (no sound)
  return null;
}

// ---------------------------------------------------------------------------
// Audio mode — call once before first playback so sounds work in silent mode
// on iOS and mix with background audio instead of pausing it.
// ---------------------------------------------------------------------------

let audioModeConfigured = false;

async function ensureAudioMode() {
  if (audioModeConfigured) return;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
    audioModeConfigured = true;
  } catch {
    // non-fatal — sounds may still work
  }
}

// ---------------------------------------------------------------------------
// Playback — each call creates a fresh Sound instance so rapid taps don't
// conflict. Instances are unloaded after playback finishes to avoid leaks.
// ---------------------------------------------------------------------------

async function play(asset: AVPlaybackSource, volume: number) {
  await ensureAudioMode();

  const { sound } = await Audio.Sound.createAsync(asset, {
    volume,
    shouldPlay: true,
  });

  sound.setOnPlaybackStatusUpdate((status) => {
    if (status.isLoaded && status.didJustFinish) {
      sound.unloadAsync().catch(() => {});
    }
  });
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
