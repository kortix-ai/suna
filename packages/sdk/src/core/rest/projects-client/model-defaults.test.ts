import { expect, test } from 'bun:test';
import type { ModelDefaultsResponse } from '../../../index';

test('the gateway may publish no platform default (platformDefault is nullable)', () => {
  // Older servers and an empty catalog answer `platformDefault: null`. The
  // wire type carries the API's shape so hosts compile against the real
  // payload instead of papering over it with a cast.
  const response: ModelDefaultsResponse = {
    platformDefault: null,
    accountDefault: null,
    agentDefaults: {},
    projectDefault: null,
    resolvedForCaller: null,
    freeTier: false,
  };
  expect(response.platformDefault).toBeNull();
});
