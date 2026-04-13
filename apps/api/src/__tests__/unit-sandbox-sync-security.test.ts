import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('sandbox sync fallback shell safety', () => {
  test('startup token sync fallback quotes shell values and uses base64 bootstrap payload', () => {
    const source = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8');

    expect(source).toContain('function shellQuote(value: string)');
    expect(source).toContain('function buildDockerEnvWriteCommand(payload: Record<string, string>, targetDir: string): string');
    expect(source).toContain('function buildBootstrapUpdateCommand(payload: Record<string, string>): string');
    expect(source).toContain("ENV_WRITE_PAYLOAD_B64");
    expect(source).toContain('docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} bash -c ');
    expect(source).toContain('os.environ["BOOTSTRAP_UPDATE_B64"]');
    expect(source).toContain('INTERNAL_SERVICE_KEY: token');
    expect(source).toContain('TUNNEL_TOKEN: token');
    expect(source).not.toContain('JSON.stringify(JSON.stringify({ KORTIX_TOKEN: token, KORTIX_API_URL: kortixApiUrl }))');
  });

  test('sandbox health fallback quotes shell values before docker exec', () => {
    const source = readFileSync(join(import.meta.dir, '../platform/services/sandbox-health.ts'), 'utf8');

    expect(source).toContain('function shellQuote(value: string)');
    expect(source).toContain('function buildDockerEnvWriteCommand(payload: Record<string, string>, targetDir: string): string');
    expect(source).toContain("ENV_WRITE_PAYLOAD_B64");
    expect(source).toContain('docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} bash -c ');
  });

  test('subdomain websocket proxy uses resolved sandbox service key', () => {
    const source = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8');

    expect(source).toContain('function buildLocalDockerWsTarget(sandboxId: string, port: number, remainingPath: string, searchParams: URLSearchParams, serviceKey?: string)');
    expect(source).toContain('const authToken = serviceKey || config.INTERNAL_SERVICE_KEY;');
    expect(source).toContain('return buildLocalDockerWsTarget(opts.sandboxId, opts.port, opts.remainingPath, opts.searchParams, opts.serviceKey);');
  });
});
