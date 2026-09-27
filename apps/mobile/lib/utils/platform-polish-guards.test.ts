/**
 * Source guards for Android / iPad platform polish (COR-154).
 *
 * - Mono text uses `MONO_FONT_FAMILY` (Roobert Mono). Android has no Menlo,
 *   so a hard-coded `'Menlo'` falls back to a proportional face and diff
 *   columns stop lining up.
 * - Sheets set gorhom's Android keyboard mode in ONE place
 *   (`KortixBottomSheetModal`), matching app.json `softwareKeyboardLayoutMode`.
 * - Window size is read with `useWindowDimensions()`, never
 *   `Dimensions.get()`, which is read once and goes stale on rotation.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { MONO_FONT_FAMILY } from './mono-font';

const ROOT = join(import.meta.dir, '..', '..');
const SCAN_DIRS = ['app', 'components', 'lib', 'hooks'];

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out = out.concat(sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => sourceFiles(join(ROOT, d))).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

function offenders(pattern: RegExp, allow: string[] = []): string[] {
  return files
    .filter((f) => !allow.includes(f.path))
    .flatMap((f) =>
      f.text.split('\n').flatMap((line, i) => (pattern.test(line) ? [`${f.path}:${i + 1}: ${line.trim()}`] : []))
    );
}

describe('mono font', () => {
  test('is the Roobert Mono face the app registers', () => {
    expect(MONO_FONT_FAMILY).toBe('RoobertMono-Regular');
    const fonts = readFileSync(join(ROOT, 'lib/utils/fonts.ts'), 'utf8');
    expect(fonts).toContain("[MONO_FONT_FAMILY]: require('@/assets/font/Roobert/RoobertMono-Regular.ttf')");
    expect(statSync(join(ROOT, 'assets/font/Roobert/RoobertMono-Regular.ttf')).size).toBeGreaterThan(0);
  });

  test('no native style hard-codes Menlo, Courier, or the platform monospace', () => {
    expect(offenders(/fontFamily[^\n]*['"](Menlo|Courier|Courier New|monospace)['"]/)).toEqual([]);
    expect(offenders(/(ios|android|default):\s*['"](Menlo|Courier|monospace)['"]/)).toEqual([]);
  });
});

describe('android keyboard mode', () => {
  test('only KortixBottomSheetModal sets android_keyboardInputMode, and it is adjustPan', () => {
    expect(offenders(/android_keyboardInputMode/, ['components/kortix/sheet.tsx'])).toEqual([]);
    const sheet = readFileSync(join(ROOT, 'components/kortix/sheet.tsx'), 'utf8');
    expect(sheet.match(/android_keyboardInputMode="(\w+)"/g)).toEqual(['android_keyboardInputMode="adjustPan"']);
  });

  test('the Android window is adjustResize in app.json and the native manifest', () => {
    const app = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
    expect(app.expo.android.softwareKeyboardLayoutMode).toBe('resize');
    const manifest = readFileSync(join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
  });
});

describe('iPad orientation', () => {
  test('iPad is portrait-only and full screen; iPad support stays on', () => {
    const app = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
    expect(app.expo.orientation).toBe('portrait');
    expect(app.expo.ios.supportsTablet).toBe(true);
    expect(app.expo.ios.requireFullScreen).toBe(true);
    const plist = readFileSync(join(ROOT, 'ios/Kortix/Info.plist'), 'utf8');
    const ipad = plist.match(/<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>([\s\S]*?)<\/array>/);
    expect(ipad?.[1]).not.toContain('Landscape');
    expect(plist).toMatch(/<key>UIRequiresFullScreen<\/key>\s*<true\/>/);
  });

  test('window size is never read with Dimensions.get()', () => {
    expect(offenders(/Dimensions\.get\(/)).toEqual([]);
  });
});
