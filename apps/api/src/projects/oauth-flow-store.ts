/**
 * In-memory store for in-progress OAuth device flows.
 *
 * State lives ~10 min (device-code TTL) so a process-local map is fine for
 * the single-instance kortix-api deployment. If we ever go multi-instance,
 * swap this for a short-TTL Redis key or a `project_oauth_flows` table —
 * the surface here is small enough.
 */

import { randomBytes } from 'node:crypto';
import type { OauthProviderId } from './oauth';

interface FlowEntry {
  projectId: string;
  providerId: OauthProviderId;
  handle: Record<string, unknown>;
  intervalMs: number;
  expiresAt: number;
  createdAt: number;
  /** Bumped on every slow_down so subsequent polls back off. */
  recommendedIntervalMs: number;
}

const flows = new Map<string, FlowEntry>();

export interface CreatedFlow {
  flowId: string;
  entry: FlowEntry;
}

export function createFlow(input: {
  projectId: string;
  providerId: OauthProviderId;
  handle: Record<string, unknown>;
  intervalMs: number;
  expiresAt: number;
}): CreatedFlow {
  pruneExpired();
  const flowId = randomBytes(18).toString('base64url');
  const entry: FlowEntry = {
    projectId: input.projectId,
    providerId: input.providerId,
    handle: input.handle,
    intervalMs: input.intervalMs,
    expiresAt: input.expiresAt,
    createdAt: Date.now(),
    recommendedIntervalMs: input.intervalMs,
  };
  flows.set(flowId, entry);
  return { flowId, entry };
}

export function getFlow(flowId: string): FlowEntry | undefined {
  pruneExpired();
  return flows.get(flowId);
}

export function bumpInterval(flowId: string, newIntervalMs: number): void {
  const entry = flows.get(flowId);
  if (entry) entry.recommendedIntervalMs = newIntervalMs;
}

export function deleteFlow(flowId: string): void {
  flows.delete(flowId);
}

/** Test-only — wipe state between cases. */
export function __resetFlowsForTests(): void {
  flows.clear();
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, entry] of flows.entries()) {
    if (entry.expiresAt < now) flows.delete(id);
  }
}
