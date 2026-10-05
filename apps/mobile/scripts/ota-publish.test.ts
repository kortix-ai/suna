import { describe, expect, test } from 'bun:test';

import appJson from '../app.json';
import { appIdentifier, nativeDiff, normalizePaths } from './ota-publish.mjs';

// Shapes copied from `eas fingerprint:compare --build-id <id> --json` on the
// 1.4.3 store build: the build side reaches node_modules from a temporary copy
// of the project, the checkout side from apps/mobile.
const BUILD_NM = '../../../../../../../../../Users/someone/checkout/node_modules/';
const LOCAL_NM = '../../node_modules/';
const SVG = '.pnpm/react-native-svg@15.15.4_react-native@0.85.3/node_modules/react-native-svg';

function fingerprint(nm: string, overrides: { svg?: string; patches?: string; easJson?: string } = {}) {
  return {
    sources: [
      { type: 'file', filePath: 'eas.json', hash: overrides.easJson ?? 'eas-1' },
      { type: 'dir', filePath: 'patches', hash: overrides.patches ?? 'patches-1' },
      { type: 'dir', filePath: `${nm}${overrides.svg ?? SVG}` },
      {
        type: 'contents',
        id: 'rncoreAutolinkingConfig:android',
        contents: JSON.stringify({ 'react-native-svg': { root: `${nm}${overrides.svg ?? SVG}` } }),
      },
    ],
  };
}

describe('OTA native-change guard', () => {
  test('compares only builds of the app id this checkout builds', () => {
    // A stale com.kortix.app APK on the channel must not block the Play app.
    expect(appIdentifier(appJson.expo, 'android')).toBe('com.kortix.application');
    expect(appIdentifier(appJson.expo, 'ios')).toBe('com.kortix.app');
  });

  test('normalizes both path forms to the same node_modules path', () => {
    expect(normalizePaths(`${BUILD_NM}${SVG}`)).toBe(`node_modules/${SVG}`);
    expect(normalizePaths(`${LOCAL_NM}${SVG}`)).toBe(`node_modules/${SVG}`);
  });

  test('the same native code checked out somewhere else is no change', () => {
    expect(nativeDiff({ fingerprint1: fingerprint(BUILD_NM), fingerprint2: fingerprint(LOCAL_NM) })).toEqual([]);
  });

  test('an eas.json edit is no native change', () => {
    expect(
      nativeDiff({ fingerprint1: fingerprint(BUILD_NM), fingerprint2: fingerprint(LOCAL_NM, { easJson: 'eas-2' }) }),
    ).toEqual([]);
  });

  test("another platform's app config section is no change for this platform", () => {
    const config = (pkg: string) => ({
      sources: [
        { type: 'contents', id: 'expoConfig', contents: JSON.stringify({ name: 'Kortix', android: { package: pkg } }) },
      ],
    });
    const pair = { fingerprint1: config('com.example.old'), fingerprint2: config('com.example.new') };
    expect(nativeDiff(pair, 'ios')).toEqual([]);
    expect(nativeDiff(pair, 'android')).toEqual(['contents:expoConfig']);
  });

  test('a native module version bump and a patch edit are native changes', () => {
    const bumped = SVG.replaceAll('15.15.4', '15.16.0');
    expect(
      nativeDiff({
        fingerprint1: fingerprint(BUILD_NM),
        fingerprint2: fingerprint(LOCAL_NM, { svg: bumped, patches: 'patches-2' }),
      }),
    ).toEqual(['contents:rncoreAutolinkingConfig:android', `node_modules/${SVG}`, `node_modules/${bumped}`, 'patches']);
  });
});
