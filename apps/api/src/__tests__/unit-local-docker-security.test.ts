import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('local docker fallback shell safety', () => {
  test('quotes container names and env values before building docker exec commands', () => {
    const source = readFileSync(join(import.meta.dir, '../platform/providers/local-docker.ts'), 'utf8');

    expect(source).toContain('function shellQuote(value: string)');
    expect(source).toContain('function buildDockerEnvWriteCommand(payload: Record<string, string>, targetDir: string): string');
    expect(source).toContain("ENV_WRITE_PAYLOAD_B64");
    expect(source).toContain('docker exec ${shellQuote(CONTAINER_NAME)} bash -c ');
  });

  test('local docker uses one canonical sandbox auth token in both directions', () => {
    const source = readFileSync(join(import.meta.dir, '../platform/providers/local-docker.ts'), 'utf8');

    expect(source).toContain('const serviceKey = authToken;');
    expect(source).toContain('INTERNAL_SERVICE_KEY: token');
    expect(source).toContain('TUNNEL_TOKEN: token');
    expect(source).toContain('getCanonicalServiceKey()');
  });
});
