/**
 * The light half of the memory turn hook, on the forward path of every prompt:
 * which route carries the memory `system`, the body edits, and the flag read.
 * It imports no memory or drives service, so a project with `chat`
 * off never loads them (`turn-context.ts` holds the rest).
 */
import { MEMORY_TURN_SYSTEM_MAX_CHARS } from '@kortix/api-contract';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { driveStorageAvailable } from '../drives/volumes';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { classifyRuntimeRequest } from '../sandbox-proxy/runtime-request';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';

/**
 * `chat` of a project, read at most once per 30 s per replica: a
 * project with the flag off costs no thread query on its prompts.
 */
export const memoryChannelsOn = ttlMemo({
  ttlMs: 30_000,
  keyFn: (projectId: string) => projectId,
  loader: async (projectId: string) => {
    const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
    return driveStorageAvailable() && resolveFeatureFlag(row?.metadata, 'chat');
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

/**
 * Which memory a My Kortix turn lists. The person's own My Kortix index
 * (`myKortixMemoryTurn`) belongs to their DM with My Kortix and to a My Kortix
 * session in no space. A thread filed in a channel lists that channel's
 * memory layers (`memoryTurnContext`), as any agent's thread there does: a
 * thread in #general never loads the person's DM notes.
 */
export function myKortixTurnMemory(
  space: { kind: 'channel' | 'dm'; dmAgent: string | null } | null,
  isMyKortixAgent: (name: string | null) => boolean,
): 'personal' | 'space' {
  if (!space) return 'personal';
  if (space.kind === 'dm' && isMyKortixAgent(space.dmAgent)) return 'personal';
  return 'space';
}

/**
 * A turn's `system` text: the origin block first and whole, then the other
 * parts (the board, the memory list) in order, cut so the total stays within
 * `MEMORY_TURN_SYSTEM_MAX_CHARS` (`withMemoryTurn` drops a longer one whole).
 * What gets cut is the end: the memory list, never the origin block.
 */
export function turnSystemText(where: string | null, parts: readonly (string | null | undefined)[]): string {
  const head = where ?? '';
  const rest = parts.filter(Boolean).join('\n\n');
  if (!rest) return head.slice(0, MEMORY_TURN_SYSTEM_MAX_CHARS);
  if (!head) return rest.slice(0, MEMORY_TURN_SYSTEM_MAX_CHARS);
  return `${head}\n\n${rest}`.slice(0, MEMORY_TURN_SYSTEM_MAX_CHARS);
}
