import { expect, test } from 'bun:test';

import type { CompiledRuntimeConfig } from '../lib/compile-runtime-config';
import { attachCompiledRuntimeIdentity } from './config';

test('attachCompiledRuntimeIdentity exposes the immutable runtime binding per agent', () => {
  const compiled: CompiledRuntimeConfig = {
    kind: 'acp',
    version: 3,
    defaultAgent: 'reviewer',
    runtimes: {
      codex: {
        name: 'codex',
        harness: 'codex',
        configDir: '.codex',
      },
    },
    agents: {
      reviewer: {
        name: 'reviewer',
        runtime: 'codex',
        harness: 'codex',
        nativeAgent: 'reviewer',
        enabled: true,
        connectors: 'none',
        secrets: 'none',
        skills: 'none',
        kortixCli: 'none',
        workspace: 'runtime',
      },
    },
  };

  expect(
    attachCompiledRuntimeIdentity(
      [
        {
          name: 'reviewer',
          path: 'kortix.yaml#agents.reviewer',
          description: null,
          mode: null,
          source: 'kortix.yaml',
          enabled: true,
        },
      ],
      compiled,
    ),
  ).toEqual([
    {
      name: 'reviewer',
      path: 'kortix.yaml#agents.reviewer',
      description: null,
      mode: null,
      source: 'kortix.yaml',
      enabled: true,
      runtime: 'codex',
      harness: 'codex',
      native_agent: 'reviewer',
    },
  ]);
});
