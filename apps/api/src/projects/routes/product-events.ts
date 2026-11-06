/**
 * Product events from project routes. The event belongs to the person behind
 * the request (`personUserId`): a browser sign-in or a personal CLI token. An
 * agent's session token, an API key, a service account or an OAuth app sends
 * nothing, so automation never counts as a person's activity.
 */
import type { Context } from 'hono';

import { analyticsSource } from '../../middleware/analytics-source';
import {
  captureProductEvent,
  type ProductEvent,
  type ProductEventProperties,
} from '../../shared/product-analytics';
import type { loadProjectForUser } from '../lib/access';
import { personUserId } from './session-watch';

type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

export function capturePersonEvent(
  c: Context,
  loaded: LoadedProject,
  projectId: string,
  event: ProductEvent,
  properties: ProductEventProperties = {},
  dedupeKey?: string,
): void {
  const userId = personUserId(c, loaded);
  if (!userId) return;
  captureProductEvent({
    userId,
    accountId: loaded.row.accountId,
    event,
    dedupeKey,
    properties: { project_id: projectId, ...properties, source: analyticsSource(c) },
  });
}
