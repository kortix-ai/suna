import { describe, expect, test } from 'bun:test';

import { snapshotEmbedsAgentForBootMode } from './compiled-runtime-fingerprint';

describe('compiled runtime snapshot fingerprint', () => {
  test.each(['prefer', 'required'] as const)('%s excludes the bundled daemon', (mode) => {
    expect(snapshotEmbedsAgentForBootMode(mode)).toBe(false);
  });

  test.each(['off', 'shadow'] as const)('%s retains the baked daemon', (mode) => {
    expect(snapshotEmbedsAgentForBootMode(mode)).toBe(true);
  });
});
