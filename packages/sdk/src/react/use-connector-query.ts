'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ConnectorCallError,
  runConnector,
} from '../core/rest/projects-client/connector-run';
import type { ConnectorArgs, ConnectorResult } from '../core/rest/projects-client/connectors';
import { qk } from './query-keys';

export interface ConnectorQueryOptions {
  /** The account to run as (label, id, `me` or `project`). Omit for the default. */
  account?: string | null;
  /** False keeps the query idle. */
  enabled?: boolean;
  /** How long an output stays fresh, in ms. Default 30 000. */
  staleTime?: number;
}

const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Read one connector action's output as a cached query.
 *
 * Use it only for an action that reads: every fetch runs the action upstream
 * and writes an audit row. The caller decides; the catalog `risk` is not
 * consulted, because every managed (Composio) action reports `write`.
 *
 * `error` is a `ConnectorCallError` for a denied or failed call: render a
 * connect button from `error.connectUrl` (pair with `useConnectorSetup`), or an
 * account picker from `error.availableAccounts`. A held call rejects with
 * `ConnectorApprovalPendingError`. Only an upstream 429 or 503 is retried
 * (twice, after `Retry-After`); focus never refetches.
 */
export function useConnectorQuery<S extends string, A extends string>(
  projectId: string | null | undefined,
  slug: S,
  action: A,
  args: ConnectorArgs<S, A>,
  options: ConnectorQueryOptions = {},
) {
  return useQuery<ConnectorResult<S, A>, Error>({
    queryKey: qk.project.connectorCall(projectId ?? '', slug, action, args, options.account),
    queryFn: ({ signal }) =>
      runConnector<ConnectorResult<S, A>>(projectId as string, slug, action, args as Record<string, unknown>, {
        account: options.account,
        signal,
      }),
    enabled: Boolean(projectId) && options.enabled !== false,
    staleTime: options.staleTime ?? 30_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) =>
      failureCount < 2 &&
      error instanceof ConnectorCallError &&
      (error.status === 429 || error.status === 503),
    retryDelay: (attempt, error) =>
      Math.min(
        (error instanceof ConnectorCallError && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds * 1000
          : 1000 * 2 ** attempt),
        MAX_RETRY_DELAY_MS,
      ),
  });
}
