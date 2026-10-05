import {
  readFileSync as readNodeFileSync,
  type PathOrFileDescriptor,
} from 'node:fs';

import messages from '../../translations/en.json';

export * from 'node:fs';

const hardcodedUi = messages.hardcodedUi as Record<string, unknown>;
const complete = hardcodedUi.i18nComplete as Record<string, unknown>;

function englishValue(key: string): string | undefined {
  if (typeof complete[key] === 'string') return complete[key] as string;
  const parts = key.split('.');
  let value: unknown = hardcodedUi;
  for (const part of parts) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Expands translation lookups back to English for source-structure tests.
 * Product source keeps one copy of the text in en.json. Existing architecture
 * tests can continue to assert the rendered words beside their code shape.
 */
export function expandI18nSource(source: string): string {
  const expanded = source.replace(
    /\b[A-Za-z_$][\w$]*\.raw\((['"])([^'"]+)\1\)/g,
    (call, _quote: string, key: string) => {
      const value = englishValue(key);
      return value === undefined ? call : `${call} ${JSON.stringify(value)}`;
    },
  );
  const call = String.raw`[A-Za-z_$][\w$]*\.raw\((['"])[^'"]+\1\)`;
  const value = String.raw`("(?:[^"\\]|\\.)*")`;
  return expanded
    .replace(new RegExp(String.raw`\b([\w-]+)=\{(${call}) ${value}\}`, 'g'), '$1={$2} $1=$4')
    .replace(new RegExp(String.raw`\{(${call}) ${value}\}`, 'g'), '{$1}$3');
}

export function readFileSync(path: PathOrFileDescriptor, options: { encoding: BufferEncoding; flag?: string } | BufferEncoding): string;
export function readFileSync(path: PathOrFileDescriptor): Buffer;
export function readFileSync(
  path: PathOrFileDescriptor,
  options?: { encoding?: null | BufferEncoding; flag?: string } | null | BufferEncoding,
): string | Buffer {
  const result = readNodeFileSync(path, options as never);
  return typeof result === 'string' ? expandI18nSource(result) : result;
}
