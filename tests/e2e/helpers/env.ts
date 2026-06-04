import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export function repoRoot(): string {
  return resolve(__dirname, '../../..');
}

export function parseEnvFile(relativePath: string): Record<string, string> {
  const filePath = isAbsolute(relativePath)
    ? relativePath
    : join(repoRoot(), relativePath);
  if (!existsSync(filePath)) return {};

  const env: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    env[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, '').trim();
  }
  return env;
}

export function explicitEnvFiles(): string[] {
  return (process.env.E2E_ENV_FILE || '')
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function candidateEnvFiles(files: string[]): string[] {
  return [...explicitEnvFiles(), ...files];
}

export function optionalEnvValue(name: string, ...files: string[]): string | undefined {
  if (process.env[name]) return process.env[name];

  for (const file of candidateEnvFiles(files)) {
    const value = parseEnvFile(file)[name];
    if (value) return value;
  }
  return undefined;
}

export function requireEnvValue(name: string, ...files: string[]): string {
  const value = optionalEnvValue(name, ...files);
  if (!value) throw new Error(`${name} was not found in ${candidateEnvFiles(files).join(', ')}`);
  return value;
}

export function firstExistingExplicitEnvFile(): string | null {
  return explicitEnvFiles().find((candidate) => existsSync(candidate)) ?? null;
}
