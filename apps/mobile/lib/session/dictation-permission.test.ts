import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const root = import.meta.dir + '/../..';
const manifest = readFileSync(root + '/android/app/src/main/AndroidManifest.xml', 'utf8');
const appJson = JSON.parse(readFileSync(root + '/app.json', 'utf8')).expo;

// Dictation and video capture need the microphone. A blocked RECORD_AUDIO strips
// it from the build: Android never asks, and Settings lists no Microphone
// (Jay, 2026-09-29, production Android).
describe('microphone permission', () => {
  test('the Android manifest declares RECORD_AUDIO and never removes it', () => {
    expect(manifest).toContain('<uses-permission android:name="android.permission.RECORD_AUDIO"/>');
    expect(manifest).not.toMatch(/android\.permission\.RECORD_AUDIO"[^>]*tools:node="remove"/);
  });

  test('app.json does not block RECORD_AUDIO (prebuild would write the removal back)', () => {
    expect(appJson.android.blockedPermissions ?? []).not.toContain('android.permission.RECORD_AUDIO');
  });

  test('iOS explains the microphone and speech recognition', () => {
    expect(appJson.ios.infoPlist.NSMicrophoneUsageDescription).toBeTruthy();
    expect(appJson.ios.infoPlist.NSSpeechRecognitionUsageDescription).toBeTruthy();
  });
});
