import { describe, expect, test } from 'bun:test';

import { supabaseInstallScript } from '../supabase.ts';

const BASE = {
  localTar: '/opt/kortix/releases/0.9.84-e1.tar.gz',
  sha256: 'a'.repeat(64),
  version: '0.9.84-e1',
  instance: 'vpc-demo',
  apiDomain: 'api.vpc-demo.kortix.com',
  frontendDomain: 'vpc-demo.kortix.com',
} as const;

const ARN = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:vpc-demo/runtime-abc';

describe('supabaseInstallScript runtime source', () => {
  test('AWS path passes the Secrets Manager ARN', () => {
    const script = supabaseInstallScript({ ...BASE, runtimeSecretArn: ARN });
    expect(script).toContain(`--runtime-secret-arn '${ARN}'`);
    expect(script).not.toContain('--runtime-env');
  });

  test('VPS path passes a local runtime-env file (no AWS)', () => {
    const script = supabaseInstallScript({ ...BASE, runtimeEnvFile: '/etc/kortix/runtime.json' });
    expect(script).toContain(`--runtime-env '/etc/kortix/runtime.json'`);
    expect(script).not.toContain('--runtime-secret-arn');
  });

  test('rejects both sources at once', () => {
    expect(() => supabaseInstallScript({ ...BASE, runtimeSecretArn: ARN, runtimeEnvFile: '/etc/kortix/runtime.json' }))
      .toThrow('exactly one');
  });

  test('rejects neither source', () => {
    expect(() => supabaseInstallScript({ ...BASE })).toThrow('exactly one');
  });

  test('rejects an unsafe runtime-env path', () => {
    expect(() => supabaseInstallScript({ ...BASE, runtimeEnvFile: 'relative/path.json' }))
      .toThrow('unsafe Supabase runtime env file path');
  });
});
