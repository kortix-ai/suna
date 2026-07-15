import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Kortix self-host is one generic Docker-native system: generate a
 * docker-compose.yml + .env and run `docker compose up`. It runs identically
 * on a local machine, any VPS, or a cloud VM — there is no separate "target" to pick
 * and no cloud-specific coordinates to store. Everything cloud-specific
 * (a public domain, TLS) is just an env var (KORTIX_DOMAIN) the same compose
 * stack reacts to, not a different deployment mechanism.
 */
export interface SelfHostInstanceConfig {
  schema_version: 1;
  instance: string;
  release?: string;
}

const INSTANCE_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const TOP_LEVEL_FIELDS = new Set(['schema_version', 'instance', 'release']);

export function selfHostConfigRoot(): string {
  const override = process.env.KORTIX_SELF_HOST_CONFIG_DIR?.trim();
  return override ? resolve(override) : resolve(homedir(), '.config', 'kortix', 'self-host');
}

export function instanceDir(instance: string): string {
  assertInstanceName(instance);
  return join(selfHostConfigRoot(), instance);
}

export function instanceConfigPath(instance: string): string {
  return join(instanceDir(instance), 'instance.json');
}

export function loadInstanceConfig(instance: string): SelfHostInstanceConfig | null {
  const path = instanceConfigPath(instance);
  if (!existsSync(path)) {
    // Instances created before instance.json existed persisted only a .env and
    // generated Compose assets. Treat that layout as a valid, config-less
    // instance so every existing install remains usable without a migration.
    if (existsSync(join(instanceDir(instance), '.env'))) {
      return { schema_version: 1, instance };
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid self-host instance config at ${path}: ${(error as Error).message}`);
  }
  return validateInstanceConfig(parsed, instance);
}

export function writeInstanceConfig(config: SelfHostInstanceConfig): void {
  const validated = validateInstanceConfig(config, config.instance);
  const dir = instanceDir(validated.instance);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = instanceConfigPath(validated.instance);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function validateInstanceConfig(value: unknown, expectedInstance: string): SelfHostInstanceConfig {
  if (!isRecord(value)) throw new Error('self-host instance config must be a JSON object');
  rejectUnknownFields(value, TOP_LEVEL_FIELDS);

  if (value.schema_version !== 1) throw new Error('self-host instance config schema_version must be 1');
  if (value.instance !== expectedInstance) {
    throw new Error(`self-host instance config belongs to "${String(value.instance)}", expected "${expectedInstance}"`);
  }
  assertInstanceName(expectedInstance);

  const release = optionalString(value.release, 'release');

  return {
    schema_version: 1,
    instance: expectedInstance,
    ...(release ? { release } : {}),
  };
}

function assertInstanceName(instance: string): void {
  if (!INSTANCE_PATTERN.test(instance)) {
    throw new Error('instance must start with a letter and contain only letters, digits, dots, underscores, or dashes');
  }
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, prefix = ''): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unsupported field "${prefix}${key}" in self-host instance config`);
  }
}

function asRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return asRequiredString(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
