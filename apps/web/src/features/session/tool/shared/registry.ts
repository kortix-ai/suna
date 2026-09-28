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
    const candidates = new Set<string>();
    const add = (value?: string | null) => {
      if (!value) return;
      const cleaned = value.trim();
      if (!cleaned) return;
      candidates.add(cleaned);
      candidates.add(cleaned.toLowerCase());
    };

    add(name);
    add(name.replace(/_/g, '-'));
    add(name.replace(/-/g, '_'));

    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const short = name.slice(slashIdx + 1);
      add(short);
      add(short.replace(/_/g, '-'));
      add(short.replace(/-/g, '_'));
    }

    for (const key of candidates) {
      const component = registry.get(key);
      if (component) return component;
    }

    // A prefixed name (`oc-trigger-list`, `mcp/foo_bar`) resolves to the
    // LONGEST registered suffix, so `trigger-list` wins over `list`.
    let match: string | undefined;
    for (const candidate of candidates) {
      for (const key of registry.keys()) {
        if (match && key.length <= match.length) continue;
        if (
          candidate.endsWith(`/${key}`) ||
          candidate.endsWith(`-${key}`) ||
          candidate.endsWith(`_${key}`)
        ) {
          match = key;
        }
      }
    }

    return match ? registry.get(match) : undefined;
  },
};
