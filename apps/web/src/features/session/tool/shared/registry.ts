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
  get(name: string): ToolComponent | undefined {
    const key = resolveRegisteredKey(toolRegistryCandidates(name), registry.keys());
    return key === undefined ? undefined : registry.get(key);
  },
};
