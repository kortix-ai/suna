import { describe, expect, test } from 'bun:test';

import type { DesktopCaptureStatus } from '@/lib/desktop';

import { activeLayers, capturePhase, missingGrants } from './capture-state';

const P = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const recording: DesktopCaptureStatus = {
  available: true,
  signedIn: true,
  signInRequired: false,
  projectId: P,
  on: true,
  state: 'recording',
  layers: { screen: true, actions: true, audio: false },
  policy: { layers: { screen: true, actions: false, audio: true }, notice: '', paused: false },
  permissions: { screen: true, accessibility: true, microphone: false },
  pausedUntilMs: null,
};
const phase = (
  view: DesktopCaptureStatus | null,
  extra: Partial<Parameters<typeof capturePhase>[1]> = {},
) => capturePhase(view, { projectId: P, orgHasCapture: true, now: 1_000, ...extra });

describe('capturePhase', () => {
  test('every phase, in priority order', () => {
    expect(phase(null)).toBe('unavailable');
    expect(phase({ available: false })).toBe('unavailable');
    expect(phase(recording, { orgHasCapture: false })).toBe('orgOff');
    expect(phase(recording, { turningOn: true })).toBe('turningOn');
    expect(phase({ ...recording, signedIn: false, signInRequired: true })).toBe('signInRequired');
    expect(phase(recording, { failed: true })).toBe('error');
    expect(phase({ ...recording, state: 'crashed' })).toBe('error');
    expect(phase({ ...recording, signedIn: false })).toBe('off');
    expect(phase({ ...recording, on: false })).toBe('off');
    expect(phase({ ...recording, projectId: 'another' })).toBe('off');
    expect(phase({ ...recording, state: 'stopped' })).toBe('off');
    expect(phase({ ...recording, state: 'paused' })).toBe('paused');
    expect(phase({ ...recording, pausedUntilMs: 2_000 })).toBe('paused');
    expect(phase({ ...recording, pausedUntilMs: 500 })).toBe('recording');
    expect(phase({ ...recording, policy: { ...recording.policy!, paused: true } })).toBe('paused');
    expect(
      phase({
        ...recording,
        permissions: { screen: false, accessibility: true, microphone: false },
      }),
    ).toBe('needsPermission');
    expect(phase({ ...recording, state: 'permission_needed' })).toBe('needsPermission');
    expect(phase({ ...recording, state: 'not_recording' })).toBe('starting');
    expect(phase(recording)).toBe('recording');
  });

  test('a refusal for another project does not hijack this one', () => {
    expect(
      phase({ ...recording, projectId: 'another', signInRequired: true, signedIn: false }),
    ).toBe('off');
  });
});

test('missingGrants: Screen Recording and Accessibility always, the Microphone only with Audio', () => {
  expect(missingGrants(recording)).toEqual([]);
  expect(
    missingGrants({
      ...recording,
      permissions: { screen: false, accessibility: false, microphone: false },
    }),
  ).toEqual(['screen', 'accessibility']);
  expect(
    missingGrants({ ...recording, layers: { screen: true, actions: true, audio: true } }),
  ).toEqual(['microphone']);
  expect(missingGrants({ ...recording, permissions: null })).toEqual([]);
});

test('missingGrants: Input Monitoring only with Actions on, allowed by the policy, and reported by the engine', () => {
  const actionsOn = {
    ...recording,
    policy: { ...recording.policy!, layers: { screen: true, actions: true, audio: true } },
  };
  const noListener = {
    screen: true,
    accessibility: true,
    microphone: false,
    inputMonitoring: false,
  };
  expect(missingGrants({ ...actionsOn, permissions: noListener })).toEqual(['inputMonitoring']);
  expect(
    missingGrants({ ...actionsOn, permissions: { ...noListener, inputMonitoring: true } }),
  ).toEqual([]);
  // An engine that does not report it, Actions off here, or Actions off by policy: not asked.
  expect(
    missingGrants({
      ...actionsOn,
      permissions: { screen: true, accessibility: true, microphone: false },
    }),
  ).toEqual([]);
  expect(
    missingGrants({
      ...actionsOn,
      layers: { screen: true, actions: false, audio: false },
      permissions: noListener,
    }),
  ).toEqual([]);
  expect(missingGrants({ ...recording, permissions: noListener })).toEqual([]);
});

test('activeLayers: on here and allowed by the policy', () => {
  expect(activeLayers(recording)).toEqual(['screen']);
});
