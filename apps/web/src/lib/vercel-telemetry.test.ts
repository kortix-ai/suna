import { describe, expect, test } from 'bun:test';
import { shouldMountVercelTelemetry } from './vercel-telemetry';

describe('Vercel telemetry runtime gate', () => {
  test('mounts telemetry only inside the Vercel runtime', () => {
    expect(shouldMountVercelTelemetry({ VERCEL: '1' })).toBe(true);
    expect(shouldMountVercelTelemetry({ VERCEL: '0' })).toBe(false);
    expect(shouldMountVercelTelemetry({})).toBe(false);
  });
});
