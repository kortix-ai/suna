import { createHash } from 'node:crypto';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

/**
 * Bind one human decision to the exact connector, action, and argument payload.
 * The database stores only this SHA-256 digest. Raw arguments never enter the
 * approval ledger.
 */
export function executorRequestDigest(
  connectorSlug: string,
  actionPath: string,
  args: Record<string, unknown>,
  executionContext: {
    profileId: string | null;
    provider: string;
    baseUrl: string | null;
    binding: unknown;
  },
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        version: 2,
        connector: connectorSlug,
        action: actionPath,
        args,
        executionContext,
      }),
    )
    .digest('hex');
}
