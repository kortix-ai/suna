import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export function validatedMigrationTempDirectory(
  value: unknown,
  prefix: string,
): string | null {
  if (typeof value !== 'string') return null;
  const candidate = resolve(value);
  if (dirname(candidate) !== resolve(tmpdir())) return null;
  const directoryName = basename(candidate);
  if (!directoryName.startsWith(prefix) || directoryName.length === prefix.length) return null;
  return candidate;
}

export function validatedMigrationTempFile(
  value: unknown,
  directoryPrefix: string,
  fileName: string,
): string | null {
  if (typeof value !== 'string') return null;
  const candidate = resolve(value);
  if (basename(candidate) !== fileName) return null;
  const parent = dirname(candidate);
  if (dirname(parent) !== resolve(tmpdir())) return null;
  const directoryName = basename(parent);
  if (!directoryName.startsWith(directoryPrefix) || directoryName.length === directoryPrefix.length) return null;
  return candidate;
}
