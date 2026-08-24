'use client';

import { ScopedCache } from '@/lib/storage/managed-storage';

import {
  type DraftScope,
  type StoredDraft,
  deserializeDraft,
  draftScopeKey,
} from './composer-draft';

/** Storage key prefix. Full keys are `kortix_draft:project:<id>` / `kortix_draft:session:<id>`. */
export const DRAFT_CACHE_FAMILY = 'kortix_draft';

/**
 * How many distinct drafts survive. `ScopedCache` prunes to the N
 * most-recently-WRITTEN scopes on every write, so the drafts a person is
 * actually working in are the ones that stay. Stale keys for deleted sessions
 * age out through the same mechanism, which is why the feature needs no
 * deletion hook of its own.
 */
export const DRAFT_CACHE_MAX_SCOPES = 50;

/**
 * The ONE storage object for the feature. Constructing it registers
 * `kortix_draft` as a disposable family, so a saturated bucket evicts drafts
 * rather than letting an unrelated store's `setItem` throw — the failure mode
 * `lib/storage/managed-storage.ts:1-28` documents.
 */
const draftCache = new ScopedCache<StoredDraft>(DRAFT_CACHE_FAMILY, DRAFT_CACHE_MAX_SCOPES);

/** Reads and validates. Returns null for a miss, a stale envelope, or another user's draft. */
export function readDraft(scope: DraftScope, currentUserId: string): StoredDraft | null {
  return deserializeDraft(draftCache.get(draftScopeKey(scope)), currentUserId);
}

/**
 * Writes, or REMOVES on `null`. `null` carries `serializeDraft`'s single
 * meaning — "there is nothing worth keeping" — so emptying the editor deletes
 * the key through the same call that writes one.
 */
export function writeDraft(scope: DraftScope, draft: StoredDraft | null): void {
  const key = draftScopeKey(scope);
  if (draft === null) {
    draftCache.remove(key);
    return;
  }
  draftCache.set(key, draft);
}

/** Explicit removal, for the successful-send path. */
export function clearDraft(scope: DraftScope): void {
  draftCache.remove(draftScopeKey(scope));
}
