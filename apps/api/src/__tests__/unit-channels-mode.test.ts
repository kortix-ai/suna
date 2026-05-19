import { describe, expect, test, afterEach } from 'bun:test';
import { config } from '../config';
import { resolveChannelsMode } from '../channels/mode';

type SlackFields =
  | 'KORTIX_CHANNELS_MODE'
  | 'SLACK_BOT_TOKEN'
  | 'SLACK_SIGNING_SECRET'
  | 'SLACK_CLIENT_ID'
  | 'SLACK_CLIENT_SECRET'
  | 'SLACK_REDIRECT_URI';

const SLACK_FIELDS: SlackFields[] = [
  'KORTIX_CHANNELS_MODE',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_REDIRECT_URI',
];

function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SLACK_FIELDS) {
    out[field] = (config as unknown as Record<string, unknown>)[field];
  }
  return out;
}

function restore(snap: Record<string, unknown>) {
  for (const field of SLACK_FIELDS) {
    (config as unknown as Record<string, unknown>)[field] = snap[field];
  }
}

function set(overrides: Partial<Record<SlackFields, string>>) {
  for (const field of SLACK_FIELDS) {
    const val = overrides[field];
    (config as unknown as Record<string, unknown>)[field] =
      val ?? (field === 'KORTIX_CHANNELS_MODE' ? 'auto' : '');
  }
}

describe('channels mode resolver', () => {
  const originalSnap = snapshot();
  afterEach(() => restore(originalSnap));

  test('auto with no env → single is ready (UI install is always available)', () => {
    set({});
    const r = resolveChannelsMode();
    expect(r.mode).toBe('single');
    expect(r.singleReady).toBe(true);
    expect(r.multiReady).toBe(false);
  });

  test('auto + oauth creds → both', () => {
    set({
      SLACK_CLIENT_ID: 'c',
      SLACK_CLIENT_SECRET: 'sec',
      SLACK_REDIRECT_URI: 'https://k.example/cb',
    });
    const r = resolveChannelsMode();
    expect(r.mode).toBe('both');
    expect(r.multiReady).toBe(true);
    expect(r.singleReady).toBe(true);
  });

  test('flag=single hides multi even when oauth creds are set', () => {
    set({
      KORTIX_CHANNELS_MODE: 'single',
      SLACK_CLIENT_ID: 'c',
      SLACK_CLIENT_SECRET: 'sec',
      SLACK_REDIRECT_URI: 'https://k.example/cb',
    });
    const r = resolveChannelsMode();
    expect(r.mode).toBe('single');
    expect(r.multiReady).toBe(false);
  });

  test('flag=multi without oauth creds is off with a clear error', () => {
    set({ KORTIX_CHANNELS_MODE: 'multi' });
    const r = resolveChannelsMode();
    expect(r.mode).toBe('off');
    expect(r.errors.join('\n')).toMatch(/requires SLACK_CLIENT_ID/);
  });

  test('flag=multi with oauth creds → multi only', () => {
    set({
      KORTIX_CHANNELS_MODE: 'multi',
      SLACK_CLIENT_ID: 'c',
      SLACK_CLIENT_SECRET: 'sec',
      SLACK_REDIRECT_URI: 'https://k.example/cb',
    });
    const r = resolveChannelsMode();
    expect(r.mode).toBe('multi');
    expect(r.singleReady).toBe(false);
  });
});
