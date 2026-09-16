import { validateAgentResources } from './agent-resources';
import type { ManifestIssue } from './issue';

export const MAX_AGENT_RESOURCE_BYTES = 8 * 1024 * 1024;

export type CompiledAgentResource = {
  source: string;
  content: string;
  size: number;
  sha256: string;
} & (
  | { placement: 'worker'; name: string; target?: never; mode?: never }
  | { placement: 'environment'; target: string; mode: 'seed' | 'read_only'; name?: never }
);

export async function decodeCompiledAgentResources(
  value: unknown,
): Promise<Array<{ entry: CompiledAgentResource; bytes: Uint8Array }>> {
  if (!Array.isArray(value) || value.length > 128)
    throw new Error('Agent resources must contain at most 128 files');
  const worker: Record<string, string> = Object.create(null);
  const environment: Array<{ source: string; target: string; mode: string }> = [];
  let total = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid compiled agent resource');
    const keys = [
      'placement',
      'source',
      'content',
      'size',
      'sha256',
      ...(entry.placement === 'worker' ? ['name'] : ['target', 'mode']),
    ];
    if (Object.keys(entry).some((key) => entry[key] !== undefined && !keys.includes(key)))
      throw new Error('Unknown agent resource setting');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error('Invalid agent resource size');
    total += entry.size;
    if (total > MAX_AGENT_RESOURCE_BYTES) throw new Error('Agent resources exceed 8 MiB');
    if (
      typeof entry.content !== 'string' ||
      entry.content.length !== Math.ceil(entry.size / 3) * 4 ||
      /[^A-Za-z0-9+/=]/.test(entry.content) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error('Agent resource integrity metadata is invalid');
    if (entry.placement === 'worker') {
      if (typeof entry.name !== 'string') throw new Error('Invalid agent resource name');
      if (Object.hasOwn(worker, entry.name)) throw new Error('Duplicate agent resource name');
      worker[entry.name] = entry.source;
    } else if (entry.placement === 'environment')
      environment.push({ source: entry.source, target: entry.target, mode: entry.mode });
    else throw new Error('Invalid agent resource placement');
  }
  const issues: ManifestIssue[] = [];
  validateAgentResources({ worker, environment }, 'resources', issues);
  if (issues.length)
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  return Promise.all(
    value.map(async (entry: CompiledAgentResource) => {
      let decoded: string;
      try {
        decoded = atob(entry.content);
      } catch {
        throw new Error('Agent resource integrity failed: invalid base64');
      }
      if (btoa(decoded) !== entry.content || decoded.length !== entry.size)
        throw new Error('Agent resource integrity failed');
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      if (sha256 !== entry.sha256)
        throw new Error(`Agent resource integrity failed: ${entry.source}`);
      return { entry: { ...entry }, bytes };
    }),
  );
}
