import type { SoundEvent, SoundPack } from '@/stores/sound-store';

/**
 * Pure asset lookup for a sound pack + event. Takes the asset map as an
 * argument (instead of `require()`-ing bundled files itself) so this stays
 * testable without Metro's asset transform.
 *
 * `off` never resolves. `kortix` is the only playable pack — every event
 * maps to one of the Task 1 WAVs, so there is no per-event fallback.
 */
export function resolveSoundAsset<T>(
  assets: Record<SoundEvent, T>,
  pack: SoundPack,
  event: SoundEvent
): T | null {
  if (pack !== 'kortix') return null;
  return assets[event] ?? null;
}
