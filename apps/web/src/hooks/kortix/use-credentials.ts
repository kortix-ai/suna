'use client';

/**
 * Project-scoped credentials — list, reveal, upsert, delete.
 *
 * Thin wrapper: the actual react-query layer (query keys, caching,
 * invalidation) lives in `@kortix/sdk/react` (`use-kortix-master.ts`) — this
 * file has zero identity-injection to do since none of these hooks ever read
 * `useAuth()`/`getUserHandle()` in the first place. It exists only so
 * existing importers of `apps/web/src/hooks/kortix/use-credentials` keep
 * working unchanged.
 */

import {
  credentialKeys,
  useCredentials,
  useCredentialEvents,
  useUpsertCredential,
  useRevealCredential,
  useDeleteCredential,
  type CredentialItem,
  type CredentialWithValue,
  type CredentialEvent,
} from '@kortix/sdk/react';

export type { CredentialItem, CredentialWithValue, CredentialEvent };
export { credentialKeys, useCredentials, useCredentialEvents, useUpsertCredential, useRevealCredential, useDeleteCredential };
