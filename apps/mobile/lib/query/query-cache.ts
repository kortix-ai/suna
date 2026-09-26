/**
 * The app's one persisted query cache: the signed-in user's accounts, projects
 * and session lists, kept in AsyncStorage (lib/query/persisted-queries.ts).
 * A cold start renders them in the first frame and refetches them in place.
 *
 * Bound to the signed-in user by `QueryCachePersistence` (app/_layout.tsx) and
 * awaited by the start screen before it routes (app/index.tsx). Sign-out
 * releases it before the query client is cleared (hooks/useAuth.ts).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  QUERY_CACHE_MAX_BYTES,
  QUERY_CACHE_VERSION,
  isPersistedQueryKey,
} from './persisted-queries';
import { createQueryCacheBinder } from './query-cache-binder';

export const queryCachePersistence = createQueryCacheBinder({
  storage: AsyncStorage,
  shouldPersist: isPersistedQueryKey,
  version: QUERY_CACHE_VERSION,
  maxBytes: QUERY_CACHE_MAX_BYTES,
  // A write serializes every kept query: coalesce a poll burst into one.
  throttleMs: 2_000,
});
