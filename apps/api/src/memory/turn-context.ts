/**
 * The turn hook's half in memory: the layers a thread reads and their
 * versions, sent as `memory_layers` on the Kortix prompt body
 * (`POST /kortix/runtime/sessions/:id/prompt`) so kortixd refreshes its
 * read-only copy before the turn. Null when `project_channels` is off or the
 * thread is in no space: the body is then forwarded byte for byte.
 */
import { MEMORY_SCOPE_COPY_DIR, MemoryTurnLayersSchema, type MemoryTurnLayers } from '@kortix/api-contract';
import { classifyRuntimeRequest } from '../sandbox-proxy/runtime-request';
import type { LayerRef } from './layers';
import { threadLayers } from './thread-layers';

/** The `memory_layers` entries of a thread's read layers; null when they fail the contract (kortixd would refuse the prompt). */
export function turnLayersOf(read: readonly LayerRef[]): MemoryTurnLayers | null {
  const parsed = MemoryTurnLayersSchema.safeParse(
    read.map((layer) => ({ layer_id: layer.layerId, version: String(layer.version), dir: MEMORY_SCOPE_COPY_DIR[layer.scope] })),
  );
  return parsed.success ? parsed.data : null;
}

/** One query per turn (session → root → space → layers); layers read for the first time are made. */
export async function memoryTurnLayers(sessionId: string): Promise<MemoryTurnLayers | null> {
  const thread = await threadLayers(sessionId);
  return thread ? turnLayersOf(thread.read) : null;
}

/** Only the Kortix prompt route carries `memory_layers`: not `/steer`, not OpenCode's `prompt_async`. */
export function isMemoryTurnRoute(method: string, path: string): boolean {
  const request = classifyRuntimeRequest(method, path);
  return request.kind === 'turn-start' && request.verb === 'prompt';
}

/** The JSON object body with `memory_layers` set; any other body is returned as it is. */
export function withMemoryLayers(body: ArrayBuffer | undefined, layers: MemoryTurnLayers): ArrayBuffer | undefined {
  if (!body?.byteLength) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  return new TextEncoder().encode(JSON.stringify({ ...parsed, memory_layers: layers })).buffer as ArrayBuffer;
}
