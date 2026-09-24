import { describe, expect, test } from 'bun:test';
import type { SecretCapabilityCatalog } from '../secret-capabilities';
import { buildSessionVolumes, serializeSessionVolumes } from './session-volumes';

const catalog: SecretCapabilityCatalog = {
  version: 1,
  capabilities: [
    { identifier: 'Data-Key', delivery: 'sandbox', environment_variable: 'DATA_KEY_ID' },
    { identifier: 'DATA_SECRET', delivery: 'sandbox', environment_variable: 'DATA_SECRET_ACCESS_KEY' },
    { identifier: 'GATEWAY_ONLY', delivery: 'kortix_service', consumer: 'llm_gateway' },
  ],
};

describe('buildSessionVolumes', () => {
  test('maps every field and credential identifier (case-insensitive) to its env var', () => {
    expect(
      buildSessionVolumes(
        [
          {
            name: 'data',
            mode: 'read-write',
            volume: {
              type: 's3',
              bucket: 'acme-data',
              prefix: 'training/',
              region: 'eu-west-2',
              endpoint: 'https://minio.example.com',
              access_key_id: 'DATA-KEY',
              secret_access_key: 'data_secret',
            },
          },
        ],
        catalog,
        'analyst',
      ),
    ).toEqual([
      {
        name: 'data',
        mode: 'read-write',
        type: 's3',
        bucket: 'acme-data',
        prefix: 'training/',
        region: 'eu-west-2',
        endpoint: 'https://minio.example.com',
        access_key_id_env: 'DATA_KEY_ID',
        secret_access_key_env: 'DATA_SECRET_ACCESS_KEY',
      },
    ]);
  });

  test('a public bucket needs no credentials', () => {
    expect(
      buildSessionVolumes(
        [{ name: 'noaa', mode: 'read-only', volume: { type: 's3', bucket: 'noaa-ghcn-pds' } }],
        catalog,
        'a',
      ),
    ).toEqual([{ name: 'noaa', mode: 'read-only', type: 's3', bucket: 'noaa-ghcn-pds' }]);
  });

  test('undeclared volumes and non-sandbox credentials become readable errors, not throws', () => {
    expect(
      buildSessionVolumes(
        [
          { name: 'ghost', mode: 'read-only', volume: null },
          {
            name: 'svc',
            mode: 'read-only',
            volume: { type: 's3', bucket: 'b', access_key_id: 'GATEWAY_ONLY', secret_access_key: 'DATA_SECRET' },
          },
        ],
        catalog,
        'a',
      ),
    ).toEqual([
      {
        name: 'ghost',
        mode: 'read-only',
        error: 'volume "ghost" is not declared under volumes: in kortix.yaml, or its block is invalid (run `kortix validate`)',
      },
      {
        name: 'svc',
        mode: 'read-only',
        error:
          'credential secret "GATEWAY_ONLY" uses kortix_service delivery; a volume mount needs the value in the sandbox, so set the secret\'s exposure to Environment',
      },
    ]);
  });
});

describe('serializeSessionVolumes', () => {
  test('null when the agent attaches no volume, so the env key is omitted', () => {
    expect(serializeSessionVolumes([])).toBeNull();
  });

  test('a versioned envelope otherwise', () => {
    expect(JSON.parse(serializeSessionVolumes([{ name: 'x', mode: 'read-only', error: 'e' }])!)).toEqual({
      version: 1,
      volumes: [{ name: 'x', mode: 'read-only', error: 'e' }],
    });
  });
});
