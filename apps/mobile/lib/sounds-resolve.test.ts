import { describe, expect, test } from 'bun:test';
import { resolveSoundAsset } from './sounds-resolve';
import type { SoundEvent } from '@/stores/sound-store';

const ASSETS: Record<SoundEvent, string> = {
  completion: 'kortix_complete.wav',
  error: 'kortix_error.wav',
  notification: 'kortix_attention.wav',
  send: 'kortix_send.wav',
};

describe('resolveSoundAsset', () => {
  test('off never resolves an asset', () => {
    for (const event of Object.keys(ASSETS) as SoundEvent[]) {
      expect(resolveSoundAsset(ASSETS, 'off', event)).toBeNull();
    }
  });

  test('kortix resolves every event to its own asset, no fallback', () => {
    expect(resolveSoundAsset(ASSETS, 'kortix', 'completion')).toBe('kortix_complete.wav');
    expect(resolveSoundAsset(ASSETS, 'kortix', 'error')).toBe('kortix_error.wav');
    expect(resolveSoundAsset(ASSETS, 'kortix', 'notification')).toBe('kortix_attention.wav');
    expect(resolveSoundAsset(ASSETS, 'kortix', 'send')).toBe('kortix_send.wav');
  });
});
