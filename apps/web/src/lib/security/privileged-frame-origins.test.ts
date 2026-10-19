import { expect, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import { setUiHostEnv } from '@kortix/ui/lib/host-env';

import { privilegedFrameOrigins } from './privileged-frame-origins';

// A host that sets only the SDK must still keep the API origin privileged:
// it serves the sandbox path proxy, so agent HTML from it gets the opaque sandbox.
test('the API origin comes from the SDK config', () => {
  setUiHostEnv(() => ({ appUrl: 'https://app.acme.example' }));
  configureKortix({ backendUrl: 'https://api.acme.example/v1', getToken: async () => null });
  expect(privilegedFrameOrigins()).toContain('https://api.acme.example');
  expect(privilegedFrameOrigins()).toContain('https://app.acme.example');
});

test('a root-relative API URL resolves to the page origin', () => {
  setUiHostEnv(() => ({ appUrl: 'https://self.example' }));
  configureKortix({ backendUrl: '/v1', getToken: async () => null });
  expect(privilegedFrameOrigins()).toEqual(['https://self.example', 'https://self.example', 'https://self.example']);
});
