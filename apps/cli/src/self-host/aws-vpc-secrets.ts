import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  awsJson,
  awsJsonOptional,
  verifyPinnedIdentity,
} from './aws-vpc-control-plane.ts';
import type { AwsVpcCoordinates } from './config.ts';
import { SHARED_SELF_HOST_DEFAULTS } from './shared-runtime-defaults.ts';

export const REQUIRED_OPERATOR_RUNTIME_KEYS = [
  'SMTP_ADMIN_EMAIL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_SENDER_NAME',
  'DAYTONA_API_KEY',
  // Managed Claude models resolve to AWS Bedrock via this bearer key (see the
  // Bedrock gap note below). Enterprise deployments do NOT depend on OpenRouter;
  // an operator may still add OPENROUTER_API_KEY for non-managed models.
  'AWS_BEDROCK_API_KEY',
] as const;

const UPDATER_MANAGED_RUNTIME_KEYS = new Set([
  'POSTGRES_PASSWORD', 'DATABASE_URL',
  'JWT_SECRET', 'SUPABASE_JWT_SECRET', 'ANON_KEY', 'SUPABASE_ANON_KEY',
  'SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY',
  'DASHBOARD_PASSWORD', 'SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'VAULT_ENC_KEY',
  'PG_META_CRYPTO_KEY', 'LOGFLARE_PUBLIC_ACCESS_TOKEN', 'LOGFLARE_PRIVATE_ACCESS_TOKEN',
  'S3_PROTOCOL_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_SECRET', 'POOLER_TENANT_ID',
  'GATEWAY_INTERNAL_TOKEN', 'INTERNAL_SERVICE_KEY', 'API_KEY_SECRET', 'TUNNEL_SIGNING_SECRET',
]);

interface RuntimeCoordinates {
  runtimeSecretArn: string;
  supabasePrivateIp: string;
  apiDomain: string;
  frontendDomain: string;
  instance: string;
  region: string;
}

interface SecretResponse {
  SecretString?: string;
}

export function runtimeSecretId(instance: string): string {
  return `${instance}/runtime`;
}

export function readRuntimeSecret(
  aws: AwsVpcCoordinates,
  secretId: string,
): Record<string, string> | null {
  const response = awsJsonOptional<SecretResponse>(aws, [
    'secretsmanager', 'get-secret-value', '--secret-id', secretId,
  ]);
  if (!response) return null;
  if (!response.SecretString) throw new Error(`runtime secret ${secretId} has no SecretString`);
  let value: unknown;
  try {
    value = JSON.parse(response.SecretString) as unknown;
  } catch (error) {
    throw new Error(`runtime secret ${secretId} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`runtime secret ${secretId} must contain a JSON object`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new Error(`runtime secret value ${key} must be a string`);
    result[key] = item;
  }
  return result;
}

export function writeRuntimeSecret(
  aws: AwsVpcCoordinates,
  value: Record<string, string>,
  secretId: string,
): void {
  verifyPinnedIdentity(aws);
  const directory = mkdtempSync(join(tmpdir(), 'kortix-runtime-secret-'));
  const path = join(directory, 'secret.json');
  try {
    writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
    awsJson(aws, [
      'secretsmanager', 'put-secret-value',
      '--secret-id', secretId,
      '--client-request-token', randomUUID(),
      '--secret-string', pathToFileURL(path).href,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function bootstrapRuntimeSecret(
  aws: AwsVpcCoordinates,
  coordinates: RuntimeCoordinates,
): { created: boolean; missingOperatorKeys: string[]; keys: string[] } {
  const current = readRuntimeSecret(aws, coordinates.runtimeSecretArn) ?? {};
  const next = generateRuntimeDefaults(current, coordinates);
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) writeRuntimeSecret(aws, next, coordinates.runtimeSecretArn);
  return {
    created: changed,
    missingOperatorKeys: missingOperatorRuntimeKeys(next),
    keys: Object.keys(next).sort(),
  };
}

export function generateRuntimeDefaults(
  current: Record<string, string>,
  coordinates: RuntimeCoordinates,
): Record<string, string> {
  assertPrivateIpv4(coordinates.supabasePrivateIp);
  const jwtSecret = current.JWT_SECRET || token(32);
  const postgresPassword = current.POSTGRES_PASSWORD || token(32);
  const anonKey = current.ANON_KEY || supabaseJwt('anon', jwtSecret);
  const serviceRoleKey = current.SERVICE_ROLE_KEY || supabaseJwt('service_role', jwtSecret);
  const publishableKey = current.SUPABASE_PUBLISHABLE_KEY || `sb_publishable_${randomBytes(24).toString('base64url')}`;
  const secretKey = current.SUPABASE_SECRET_KEY || `sb_secret_${randomBytes(32).toString('base64url')}`;
  const supabaseInternalUrl = `http://${coordinates.supabasePrivateIp}:8000`;
  const apiUrl = `https://${coordinates.apiDomain}`;
  const frontendUrl = `https://${coordinates.frontendDomain}`;

  return {
    ...generatedInternalDefaults(coordinates.instance, coordinates.region),
    ...current,
    POSTGRES_PASSWORD: postgresPassword,
    JWT_SECRET: jwtSecret,
    SUPABASE_JWT_SECRET: jwtSecret,
    ANON_KEY: anonKey,
    SUPABASE_ANON_KEY: anonKey,
    SERVICE_ROLE_KEY: serviceRoleKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SECRET_KEY: secretKey,
    // Port 5432 is the official Supabase Supavisor session endpoint. Supavisor
    // selects the tenant from the username suffix before proxying to Postgres.
    DATABASE_URL: `postgresql://postgres.${coordinates.instance}:${encodeURIComponent(postgresPassword)}@${coordinates.supabasePrivateIp}:5432/postgres`,
    // Server-side (api/frontend tasks) reach Kong directly on the private IP.
    SUPABASE_URL: supabaseInternalUrl,
    // Browser-facing Supabase base. The ALB routes the Supabase data-plane
    // prefixes (/rest/v1, /auth/v1, /storage/v1, …) on the FRONTEND/root host,
    // not on api.<domain>, so every public Supabase URL is the frontend origin.
    SUPABASE_PUBLIC_URL: frontendUrl,
    PUBLIC_URL: frontendUrl,
    API_PUBLIC_URL: apiUrl,
    KORTIX_URL: apiUrl,
    KORTIX_PUBLIC_URL: frontendUrl,
    KORTIX_PUBLIC_BACKEND_URL: `${apiUrl}/v1`,
    KORTIX_PUBLIC_SUPABASE_URL: frontendUrl,
    KORTIX_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    // KORTIX_PUBLIC_AUTH_METHODS now comes from SHARED_SELF_HOST_DEFAULTS.
    INTERNAL_KORTIX_ENV: 'prod',
    KORTIX_BILLING_INTERNAL_ENABLED: 'false',
  };
}

export function missingOperatorRuntimeKeys(secret: Record<string, string>): string[] {
  return REQUIRED_OPERATOR_RUNTIME_KEYS.filter((key) => !secret[key]?.trim());
}

export function parseRuntimeAssignments(args: string[]): Record<string, string> {
  if (args.length === 0) throw new Error('Pass KEY=VALUE pairs.');
  const result: Record<string, string> = {};
  for (const pair of args) {
    const separator = pair.indexOf('=');
    const key = separator < 0 ? '' : pair.slice(0, separator);
    const value = separator < 0 ? '' : pair.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(key)) throw new Error(`Invalid runtime env assignment: ${pair}`);
    if (!value) throw new Error(`Runtime env value ${key} must not be empty`);
    result[key] = value;
  }
  return result;
}

export function assertOperatorRuntimeAssignments(assignments: Record<string, string>): void {
  const protectedKeys = Object.keys(assignments).filter((key) => UPDATER_MANAGED_RUNTIME_KEYS.has(key));
  if (protectedKeys.length > 0) {
    throw new Error(`runtime value(s) ${protectedKeys.join(', ')} are updater-managed and require the coordinated rotation workflow`);
  }
}

function generatedInternalDefaults(instance: string, region: string): Record<string, string> {
  return {
    // Managed Claude → Bedrock: the API/gateway select the Bedrock upstream when
    // AWS_BEDROCK_API_KEY is present and call bedrock-runtime.<region>. Region is
    // defaulted here; the bearer key is an operator-supplied required runtime key.
    AWS_BEDROCK_REGION: region,
    DASHBOARD_USERNAME: 'kortix',
    DASHBOARD_PASSWORD: token(24),
    SECRET_KEY_BASE: token(48),
    REALTIME_DB_ENC_KEY: token(8),
    VAULT_ENC_KEY: token(16),
    PG_META_CRYPTO_KEY: token(24),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: token(24),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: token(24),
    S3_PROTOCOL_ACCESS_KEY_ID: token(16),
    S3_PROTOCOL_ACCESS_KEY_SECRET: token(32),
    POOLER_TENANT_ID: instance,
    GATEWAY_INTERNAL_TOKEN: token(32),
    INTERNAL_SERVICE_KEY: token(32),
    API_KEY_SECRET: token(32),
    TUNNEL_SIGNING_SECRET: token(32),
    // Auth + sandbox behavior is target-agnostic — the SAME on docker, AWS EC2,
    // and any VPS — so it lives in one shared object both generators consume.
    ...SHARED_SELF_HOST_DEFAULTS,
  };
}

function supabaseJwt(role: string, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase', iat: 1641024000, exp: 2114380800 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function token(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function assertPrivateIpv4(value: string): void {
  const parts = value.split('.').map(Number);
  const valid = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (
    parts[0] === 10
    || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31)
    || (parts[0] === 192 && parts[1] === 168)
  );
  if (!valid) throw new Error('Supabase host must have an RFC1918 private IPv4 address');
}
