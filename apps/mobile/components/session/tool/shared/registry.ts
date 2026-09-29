import { resolveRegisteredKey, toolRegistryCandidates } from '@kortix/shared/tools';
import type { ToolComponent } from './types';

/**
 * Tool name → renderer. The shared lookup keeps the same lookup order on both
 * surfaces, so a tool name resolves to the same renderer. Renderers register
 * themselves at module load; the imports live in
 * `tool/tools/register.ts`.
 */
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
