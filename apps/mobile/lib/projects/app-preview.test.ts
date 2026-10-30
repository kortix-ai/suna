import { describe, expect, test } from 'bun:test';

import {
  PREVIEW_INJECTED_JS,
  PREVIEW_VIEWPORT_WIDTH,
  allowPreviewNavigation,
  appPreviewState,
  createPreviewSlots,
} from './app-preview';

const running = {
  viewer_can_access: true,
  active_deployment_id: 'dep-1',
  desired_state: 'running' as const,
  hosting_type: 'sandbox' as const,
  capabilities: ['preview' as const],
  url: 'https://example.invalid',
  external_url: null,
};

describe('appPreviewState', () => {
  test('a running App that can be previewed loads live', () => {
    expect(appPreviewState(running)).toBe('live');
  });

  test('viewer_can_access false is denied before every other check', () => {
    expect(appPreviewState({ ...running, viewer_can_access: false })).toBe('denied');
    expect(
      appPreviewState({ ...running, viewer_can_access: false, active_deployment_id: null }),
    ).toBe('denied');
  });

  test('viewer_can_access undefined is unknown, not denied', () => {
    expect(appPreviewState({ ...running, viewer_can_access: undefined })).toBe('live');
  });

  test('not deployed and suspended show their status, no preview', () => {
    expect(appPreviewState({ ...running, active_deployment_id: null })).toBe('not-deployed');
    expect(appPreviewState({ ...running, desired_state: 'stopped' })).toBe('suspended');
  });

  test('a static App previews whatever desired_state says', () => {
    expect(appPreviewState({ ...running, desired_state: 'stopped', hosting_type: 'static' })).toBe(
      'live',
    );
  });

  test('no preview capability, display.preview none, or no URL is unavailable', () => {
    expect(appPreviewState({ ...running, capabilities: [] })).toBe('unavailable');
    expect(appPreviewState({ ...running, capabilities: undefined })).toBe('unavailable');
    expect(appPreviewState({ ...running, display: { preview: 'none' } })).toBe('unavailable');
    expect(appPreviewState({ ...running, url: '' })).toBe('unavailable');
  });

  test('an external App that allows framing is live without a deployment', () => {
    expect(
      appPreviewState({
        ...running,
        active_deployment_id: null,
        external_url: 'https://example.invalid',
      }),
    ).toBe('live');
    expect(
      appPreviewState({
        ...running,
        active_deployment_id: null,
        external_url: 'https://example.invalid',
        capabilities: [],
      }),
    ).toBe('unavailable');
  });
});

describe('createPreviewSlots', () => {
  test('the first three askers hold a slot, the fourth waits', () => {
    const slots = createPreviewSlots(3);
    ['a', 'b', 'c', 'd'].forEach((id) => slots.want(id));
    expect(['a', 'b', 'c', 'd'].map((id) => slots.granted(id))).toEqual([true, true, true, false]);
  });

  test('a dropped slot goes to the oldest waiter', () => {
    const slots = createPreviewSlots(3);
    ['a', 'b', 'c', 'd', 'e'].forEach((id) => slots.want(id));
    slots.drop('b');
    expect(slots.granted('d')).toBe(true);
    expect(slots.granted('e')).toBe(false);
    expect(slots.granted('b')).toBe(false);
  });

  test('asking twice keeps the original place', () => {
    const slots = createPreviewSlots(1);
    slots.want('a');
    slots.want('b');
    slots.want('a');
    expect(slots.granted('a')).toBe(true);
    expect(slots.granted('b')).toBe(false);
  });

  test('listeners hear changes only, and unsubscribe', () => {
    const slots = createPreviewSlots(3);
    let calls = 0;
    const off = slots.subscribe(() => calls++);
    slots.want('a');
    slots.want('a');
    slots.drop('missing');
    slots.drop('a');
    expect(calls).toBe(2);
    off();
    slots.want('b');
    expect(calls).toBe(2);
  });
});

describe('allowPreviewNavigation', () => {
  test('the first load follows its redirects', () => {
    expect(allowPreviewNavigation(false, true)).toBe(true);
    expect(allowPreviewNavigation(false, undefined)).toBe(true);
  });

  test('after the first load, the top frame stays put; subframes load', () => {
    expect(allowPreviewNavigation(true, true)).toBe(false);
    expect(allowPreviewNavigation(true, undefined)).toBe(false);
    expect(allowPreviewNavigation(true, false)).toBe(true);
  });
});

describe('PREVIEW_INJECTED_JS', () => {
  test('sets the desktop viewport width and parses as a script', () => {
    expect(PREVIEW_INJECTED_JS).toContain(`width=${PREVIEW_VIEWPORT_WIDTH}`);
    expect(() => new Function(PREVIEW_INJECTED_JS)).not.toThrow();
  });
});
