/**
 * Flow registration. Each test declares its stable spec ID up front — this is
 * the 1:1 mapping that makes end-to-end.md enforceable as the source of truth.
 */
import type { FlowFn, FlowMeta } from "./types";

export interface RegisteredFlow {
  id: string;
  meta: FlowMeta;
  fn: FlowFn;
}

const registry = new Map<string, RegisteredFlow>();

/**
 * Register a flow. Duplicate IDs throw immediately (caught at import time).
 * Validity against the spec ID set is enforced separately by the coverage gate.
 */
export function flow(id: string, meta: FlowMeta, fn: FlowFn): void {
  if (registry.has(id)) {
    throw new Error(`Duplicate flow id "${id}" — every flow maps 1:1 to a spec ID.`);
  }
  registry.set(id, { id, meta, fn });
}

export function allFlows(): RegisteredFlow[] {
  return [...registry.values()];
}

export function getFlow(id: string): RegisteredFlow | undefined {
  return registry.get(id);
}

export function clearRegistry(): void {
  registry.clear();
}
