import { resolveFeatureFlag } from '../../feature-flags/registry';
import { composioEventSource } from './composio';
import { mcpEventSource } from './mcp-source';
import type { EventSourceProvider } from './types';

// replica-local: test-only provider overrides (setEventSourceForTest); production never writes it.
const overrides = new Map<string, EventSourceProvider | null>();

const BUILT_IN: readonly EventSourceProvider[] = [composioEventSource, mcpEventSource];

export function eventSourceFor(providerId: string): EventSourceProvider | null {
  if (overrides.has(providerId)) return overrides.get(providerId) ?? null;
  return BUILT_IN.find((p) => p.id === providerId) ?? null;
}

/** Test seam: `null` hides a provider, `undefined`-style reset is `setEventSourceForTest(id, undefined)`. */
export function setEventSourceForTest(id: string, provider: EventSourceProvider | null | undefined): void {
  if (provider === undefined) overrides.delete(id);
  else overrides.set(id, provider);
}

/**
 * A project can use this source. Kortix's own `mcp` source ships behind
 * `connectors_v2`: a project without it sees exactly the sources and texts it
 * saw before. `projectMetadata` undefined: no project in view (every source).
 */
export function eventSourceAvailable(providerId: string, projectMetadata?: unknown): boolean {
  if (providerId !== mcpEventSource.id || projectMetadata === undefined) return true;
  return resolveFeatureFlag(projectMetadata, 'connectors_v2');
}

/** Every registered, non-hidden provider the project can use. */
export function allEventSources(projectMetadata?: unknown): EventSourceProvider[] {
  const ids = new Set([...BUILT_IN.map((p) => p.id), ...overrides.keys()]);
  return [...ids].flatMap((id) => {
    const provider = eventSourceFor(id);
    return provider && eventSourceAvailable(id, projectMetadata) ? [provider] : [];
  });
}

/** Error text for a `source` that names no adapter this project can use, or null. */
export function unknownSourceMessage(source: string, projectMetadata?: unknown): string | null {
  if (eventSourceFor(source) && eventSourceAvailable(source, projectMetadata)) return null;
  return `Unknown event source "${source}". Sources: ${allEventSources(projectMetadata).map((p) => p.id).join(', ')}.`;
}
