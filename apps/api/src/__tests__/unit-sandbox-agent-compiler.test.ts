import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

function versionTuple(value: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = value.split('.').map(Number);
  return [major, minor, patch];
}

function isAtLeast(actual: string, minimum: string): boolean {
  const left = versionTuple(actual);
  const right = versionTuple(minimum);
  return left[0] > right[0]
    || (left[0] === right[0] && left[1] > right[1])
    || (left[0] === right[0] && left[1] === right[1] && left[2] >= right[2]);
}

describe('sandbox agent compiler runtime', () => {
  test('pins a Bun runtime with stable subprocess terminal support and fingerprints the pin', async () => {
    const dockerfile = await readFile(resolve(import.meta.dir, '../../Dockerfile'), 'utf8');
    const agentPackage = JSON.parse(
      await readFile(
        resolve(import.meta.dir, '../../../kortix-sandbox-agent-server/package.json'),
        'utf8',
      ),
    ) as { engines?: { bun?: string } };

    const dockerPin = dockerfile.match(
      /^ARG SANDBOX_AGENT_BUN_VERSION=(\d+\.\d+\.\d+)$/m,
    )?.[1];
    expect(dockerPin).toBeDefined();
    expect(dockerPin).toBe(agentPackage.engines?.bun);
    expect(isAtLeast(dockerPin!, '1.3.0')).toBe(true);
  });
});
