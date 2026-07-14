import { describe, expect, test } from 'bun:test';

import { ProcessRunner } from '../process.ts';

describe('process failure diagnostics', () => {
  test('reports the Terraform error instead of its ANSI box border', () => {
    const runner = new ProcessRunner();
    expect(() => runner.run('bash', [
      '-ceu',
      "printf '\\033[31m╷\\033[0m\\n\\033[31m│ Error: Invalid configuration for API client\\033[0m\\n' >&2; exit 1",
    ])).toThrow('bash -ceu failed: Error: Invalid configuration for API client');
  });
});
