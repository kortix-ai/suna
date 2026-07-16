import { describe, expect, test } from 'bun:test';
import { buildTeamsAppPackage } from '../channels/teams/app-package';
import { TEAMS_COLOR_ICON, TEAMS_OUTLINE_ICON } from '../channels/teams/app-icons';

const PNG_SIGNATURE = '89504e470d0a1a0a';

function pngDimensions(buf: Buffer): { signature: boolean; width: number; height: number } {
  return {
    signature: buf.subarray(0, 8).toString('hex') === PNG_SIGNATURE,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

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

  test('ships real PNG icons at the dimensions Teams requires on publish', () => {
    const color = pngDimensions(TEAMS_COLOR_ICON);
    expect(color.signature).toBe(true);
    expect(color.width).toBe(192);
    expect(color.height).toBe(192);

    const outline = pngDimensions(TEAMS_OUTLINE_ICON);
    expect(outline.signature).toBe(true);
    expect(outline.width).toBe(32);
    expect(outline.height).toBe(32);
  });
});
