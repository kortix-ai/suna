/** The app events a project connector can trigger on, from its provider's catalog. */
import { connectorInfo } from './deliver';
import { eventSourceFor } from './registry';
import type { EventTypeInfo } from './types';

/** Provider event catalogs change rarely and cost several provider calls. */
const EVENT_TYPE_CACHE_MS = 10 * 60_000;
// replica-local: a read-through cache of the provider's public catalog. Each
// replica fills its own copy; a miss costs one provider listing, never a wrong answer.
const eventTypeCache = new Map<string, { expires: number; items: EventTypeInfo[] }>();

export type EventTypeCatalog =
  | { kind: 'ok'; provider: string; app: string; items: EventTypeInfo[] }
  | { kind: 'connector_not_found' }
  | { kind: 'unavailable' }
  | { kind: 'provider_error'; message: string };

export async function listConnectorEventTypes(projectId: string, connectorSlug: string): Promise<EventTypeCatalog> {
  const connector = await connectorInfo(projectId, connectorSlug);
  if (!connector.found) return { kind: 'connector_not_found' };
  const provider = eventSourceFor(connector.provider);
  if (!provider || !provider.configured() || !connector.app) return { kind: 'unavailable' };
  const key = `${provider.id}:${connector.app}`;
  let cached = eventTypeCache.get(key);
  if (!cached || cached.expires < Date.now()) {
    try {
      cached = { expires: Date.now() + EVENT_TYPE_CACHE_MS, items: await provider.listEventTypes(connector.app) };
    } catch (error) {
      return { kind: 'provider_error', message: error instanceof Error ? error.message : String(error) };
    }
    eventTypeCache.set(key, cached);
  }
  return { kind: 'ok', provider: provider.id, app: connector.app, items: cached.items };
}
