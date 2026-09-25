import { expect, test } from 'bun:test';

import { runtimeConfigIsBakedAtBuild } from './runtime-config-mode';

test('Vercel bakes the runtime config; standalone reads it per request', () => {
  expect(runtimeConfigIsBakedAtBuild({ VERCEL: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  expect(runtimeConfigIsBakedAtBuild({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  expect(runtimeConfigIsBakedAtBuild({ VERCEL: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
});
