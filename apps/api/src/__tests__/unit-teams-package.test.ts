import { describe, expect, test } from 'bun:test';
import { buildTeamsAppPackage } from '../channels/teams/app-package';

describe('buildTeamsAppPackage', () => {
  test('produces a non-trivial zip with the manifest + both icons', () => {
    const zip = buildTeamsAppPackage({ appId: 'app-123', baseUrl: 'https://kortix-teams.ngrok.app' });
    expect(zip.length).toBeGreaterThan(1000);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const raw = zip.toString('latin1');
    expect(raw.includes('manifest.json')).toBe(true);
    expect(raw.includes('color.png')).toBe(true);
    expect(raw.includes('outline.png')).toBe(true);
  });

  test('embeds the app id into the manifest', () => {
    const zip = buildTeamsAppPackage({ appId: 'abc-999', baseUrl: 'https://x.ngrok.app' });
    expect(zip.toString('latin1').includes('abc-999')).toBe(true);
  });
});
