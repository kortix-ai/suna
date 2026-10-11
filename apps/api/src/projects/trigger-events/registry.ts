import { composioEventSource } from './composio';
import type { EventSourceProvider } from './types';

// replica-local: test-only provider overrides (setEventSourceForTest); production never writes it.
const overrides = new Map<string, EventSourceProvider | null>();

export function eventSourceFor(providerId: string): EventSourceProvider | null {
  if (overrides.has(providerId)) return overrides.get(providerId) ?? null;
  return providerId === composioEventSource.id ? composioEventSource : null;
}

/** Test seam: `null` hides a provider, `undefined`-style reset is `setEventSourceForTest(id, undefined)`. */
export function setEventSourceForTest(id: string, provider: EventSourceProvider | null | undefined): void {
  if (provider === undefined) overrides.delete(id);
  else overrides.set(id, provider);
}

/** Every registered, non-hidden provider. */
export function allEventSources(): EventSourceProvider[] {
  const ids = new Set([composioEventSource.id, ...overrides.keys()]);
  return [...ids].flatMap((id) => eventSourceFor(id) ?? []);
}

/** Error text for a `source` that names no registered adapter, or null. */
export function unknownSourceMessage(source: string): string | null {
  if (eventSourceFor(source)) return null;
  return `Unknown event source "${source}". Sources: ${allEventSources().map((p) => p.id).join(', ')}.`;
}
