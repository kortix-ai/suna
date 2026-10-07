import { composioEventSource } from './composio';
import type { EventSourceProvider } from './types';

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
