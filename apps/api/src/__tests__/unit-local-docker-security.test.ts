import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('local docker fallback shell safety', () => {
  test('uses execFile argument arrays instead of shell-built docker commands', () => {
    const source = readFileSync(join(import.meta.dir, '../platform/providers/local-docker.ts'), 'utf8');

    expect(source).toContain("import { execFile } from 'node:child_process';");
    expect(source).toContain("await execFileAsync('docker', args");
    expect(source).toContain("const runArgs = [");
    expect(source).not.toContain('docker exec ${');
    expect(source).not.toContain('execSync(`docker');
  });

  test('passes sandbox env vars directly into docker run', () => {
    const source = readFileSync(join(import.meta.dir, '../platform/providers/local-docker.ts'), 'utf8');

    expect(source).toContain('function flattenEnvVars(envVars: Record<string, string> | undefined): string[]');
    expect(source).toContain("args.push('-e', `${key}=${String(value)}`);");
    expect(source).toContain('...envArgs,');
  });
});
