import { expect, test } from 'bun:test';

import { sandboxRuntimeRequestHeaders } from './sandbox-fetch';

test('sandbox runtime reads force a portable response encoding', () => {
  expect(sandboxRuntimeRequestHeaders({ Authorization: 'Bearer service-key' })).toEqual({
    Authorization: 'Bearer service-key',
    'Accept-Encoding': 'identity',
  });
});
