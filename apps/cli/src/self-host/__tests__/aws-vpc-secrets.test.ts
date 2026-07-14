import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import {
  assertOperatorRuntimeAssignments,
  generateRuntimeDefaults,
  missingOperatorRuntimeKeys,
  parseRuntimeAssignments,
} from '../aws-vpc-secrets.ts';

const coordinates = {
  runtimeSecretArn: 'arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-vpc-demo/runtime-test',
  supabasePrivateIp: '10.60.16.10',
  apiDomain: 'api.vpc-demo.kortix.com',
  frontendDomain: 'vpc-demo.kortix.com',
  instance: 'kortix-vpc-demo',
  region: 'us-west-2',
};

describe('AWS VPC runtime secret bootstrap', () => {
  test('generates consistent Supabase, database, and Kortix runtime values without operator credentials', () => {
    const secret = generateRuntimeDefaults({}, coordinates);

    expect(secret.POSTGRES_PASSWORD.length).toBeGreaterThanOrEqual(32);
    expect(secret.DATABASE_URL).toMatch(/^postgresql:\/\/postgres\.kortix-vpc-demo:.+@10\.60\.16\.10:5432\/postgres$/);
    expect(secret.SUPABASE_URL).toBe('http://10.60.16.10:8000');
    expect(secret.SUPABASE_PUBLIC_URL).toBe('https://api.vpc-demo.kortix.com');
    expect(secret.PUBLIC_URL).toBe('https://vpc-demo.kortix.com');
    expect(secret.REALTIME_DB_ENC_KEY).toHaveLength(16);
    expect(secret.VAULT_ENC_KEY).toHaveLength(32);
    expect(secret.SECRET_KEY_BASE.length).toBeGreaterThanOrEqual(64);
    expect(verifyJwt(secret.ANON_KEY, secret.JWT_SECRET, 'anon')).toBe(true);
    expect(verifyJwt(secret.SERVICE_ROLE_KEY, secret.JWT_SECRET, 'service_role')).toBe(true);
    expect(secret.SUPABASE_PUBLISHABLE_KEY).toMatch(/^sb_publishable_[A-Za-z0-9_-]{32}$/);
    expect(secret.SUPABASE_SECRET_KEY).toMatch(/^sb_secret_[A-Za-z0-9_-]{43}$/);
    // Managed Claude resolves to Bedrock: region is defaulted, the bearer key is
    // an operator-required runtime value, and OpenRouter is NOT required.
    expect(secret.AWS_BEDROCK_REGION).toBe('us-west-2');
    expect(missingOperatorRuntimeKeys(secret)).toEqual([
      'SMTP_ADMIN_EMAIL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
      'SMTP_PASS', 'SMTP_SENDER_NAME', 'DAYTONA_API_KEY', 'AWS_BEDROCK_API_KEY',
    ]);
  });

  test('preserves generated credentials across repeat bootstrap while refreshing deployment coordinates', () => {
    const first = generateRuntimeDefaults({
      SMTP_HOST: 'smtp.example.com',
      POSTGRES_PASSWORD: 'existing-postgres-password-with-enough-entropy',
    }, coordinates);
    const second = generateRuntimeDefaults(first, {
      ...coordinates,
      supabasePrivateIp: '10.60.16.11',
    });

    expect(second.JWT_SECRET).toBe(first.JWT_SECRET);
    expect(second.ANON_KEY).toBe(first.ANON_KEY);
    expect(second.SUPABASE_PUBLISHABLE_KEY).toBe(first.SUPABASE_PUBLISHABLE_KEY);
    expect(second.SUPABASE_SECRET_KEY).toBe(first.SUPABASE_SECRET_KEY);
    expect(second.API_KEY_SECRET).toBe(first.API_KEY_SECRET);
    expect(second.SMTP_HOST).toBe('smtp.example.com');
    expect(second.DATABASE_URL).toMatch(/^postgresql:\/\/postgres\.kortix-vpc-demo:.+@10\.60\.16\.11:5432\/postgres$/);
  });

  test('parses only explicit non-empty uppercase assignments', () => {
    expect(parseRuntimeAssignments(['SMTP_HOST=smtp.example.com', 'SMTP_PASS=a=b']))
      .toEqual({ SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'a=b' });
    expect(() => parseRuntimeAssignments(['smtp_host=x'])).toThrow('Invalid runtime env assignment');
    expect(() => parseRuntimeAssignments(['SMTP_PASS='])).toThrow('must not be empty');
    expect(() => assertOperatorRuntimeAssignments({ POSTGRES_PASSWORD: 'do-not-rotate-alone' }))
      .toThrow('coordinated rotation workflow');
    expect(() => assertOperatorRuntimeAssignments({ DAYTONA_API_KEY: 'allowed' })).not.toThrow();
  });

  test('rejects a non-private Supabase host coordinate', () => {
    expect(() => generateRuntimeDefaults({}, { ...coordinates, supabasePrivateIp: '8.8.8.8' }))
      .toThrow('RFC1918 private IPv4');
  });
});

function verifyJwt(jwt: string, secret: string, expectedRole: string): boolean {
  const [header, payload, signature] = jwt.split('.');
  if (!header || !payload || !signature) return false;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: string };
  return signature === expected && claims.role === expectedRole;
}
