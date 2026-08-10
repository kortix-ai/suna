import { afterEach, describe, expect, test } from 'bun:test';

import { GET } from './route';

const originalRuntimeVersion = process.env.KORTIX_PUBLIC_VERSION;

afterEach(() => {
  if (originalRuntimeVersion === undefined) {
    delete process.env.KORTIX_PUBLIC_VERSION;
  } else {
    process.env.KORTIX_PUBLIC_VERSION = originalRuntimeVersion;
  }
});

describe('web health', () => {
  test('reports the runtime ECS version override', async () => {
    process.env.KORTIX_PUBLIC_VERSION = '1.2.3-runtime';

    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: '1.2.3-runtime' });
  });
});
