import { toolKind } from '@kortix/sdk';
import { resolveRegisteredKey, toolRegistryCandidates } from '@kortix/shared/tools';
import type { ToolComponent } from '@/features/session/tool/shared/types';

const registry = new Map<string, ToolComponent>();

export const ToolRegistry = {
  register(name: string, component: ToolComponent) {
    registry.set(name, component);
  },
  keys(): string[] {
    return Array.from(registry.keys());
  },
  /** The renderer registered for a tool name, else the one registered for its kind (`toolKind`). */
  get(name: string): ToolComponent | undefined {
    const key = resolveRegisteredKey(toolRegistryCandidates(name), registry.keys());
    return key === undefined ? registry.get(toolKind(name)) : registry.get(key);
  },
};
