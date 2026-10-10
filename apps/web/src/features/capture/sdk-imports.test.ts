import { describe, expect, test } from 'bun:test';

import {
  approveCaptureDeviceGrant,
  getCaptureTimeline,
  getCaptureWorkspace,
  searchCapture,
  searchMyCapture,
} from '@kortix/sdk';
import { useCaptureTimeline, useCaptureWorkspace, useSetCaptureEnabled } from '@kortix/sdk/react';

// The Capture area once got `getCaptureTimeline === undefined` from `@kortix/sdk`
// in a dev bundle. These are the names the area and the desktop dialog import;
// each must resolve to a function through the web app's own module resolution.
describe('Capture names from @kortix/sdk resolve in the web app', () => {
  test('the REST functions from the root entry', () => {
    for (const fn of [
      getCaptureTimeline,
      getCaptureWorkspace,
      searchCapture,
      searchMyCapture,
      approveCaptureDeviceGrant,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  test('the hooks from the react entry', () => {
    for (const fn of [useCaptureTimeline, useCaptureWorkspace, useSetCaptureEnabled]) {
      expect(typeof fn).toBe('function');
    }
  });
});
