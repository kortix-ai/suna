/**
 * The light half of the memory turn hook, on the forward path of every prompt:
 * which route carries the memory `system`, the body edits, and the flag read.
 * It imports no memory or drives service, so a project with `project_channels`
 * off never loads them (`turn-context.ts` holds the rest).
 */
import { MEMORY_TURN_SYSTEM_MAX_CHARS } from '@kortix/api-contract';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { classifyRuntimeRequest } from '../sandbox-proxy/runtime-request';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';

/**
 * `project_channels` of a project, read at most once per 30 s per replica: a
 * project with the flag off costs no thread query on its prompts.
 */
export const memoryChannelsOn = ttlMemo({
  ttlMs: 30_000,
  keyFn: (projectId: string) => projectId,
  loader: async (projectId: string) => {
    const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
    return resolveFeatureFlag(row?.metadata, 'project_channels') && resolveFeatureFlag(row?.metadata, 'drives');
  },
});

/** Only the Kortix prompt route carries the memory `system`: not `/steer`, not OpenCode's `prompt_async`. */
export function isMemoryTurnRoute(method: string, path: string): boolean {
  const request = classifyRuntimeRequest(method, path);
  return request.kind === 'turn-start' && request.verb === 'prompt';
}

/** A JSON object body, or null for any other body. */
function jsonObject(body: ArrayBuffer | undefined): Record<string, unknown> | null {
  if (!body?.byteLength) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

/**
 * The body without a `system` a client sent: only the API sets a turn's
 * system text, so a member who may prompt a thread cannot add to its agent's
 * system prompt. A body without `system` is returned as it is (byte for byte).
 */
export function withoutClientSystem(body: ArrayBuffer | undefined): ArrayBuffer | undefined {
  const parsed = jsonObject(body);
  if (!parsed || !('system' in parsed)) return body;
  const { system: _client, ...rest } = parsed;
  return encode(rest);
}

/** The JSON object body with the memory `system` set (any `system` in it is replaced); any other body is returned as it is. */
export function withMemoryTurn(body: ArrayBuffer | undefined, turn: { system: string }): ArrayBuffer | undefined {
  const parsed = jsonObject(body);
  if (!parsed) return body;
  const { system: _client, ...rest } = parsed;
  return encode({ ...rest, ...(turn.system.length <= MEMORY_TURN_SYSTEM_MAX_CHARS ? { system: turn.system } : {}) });
}
