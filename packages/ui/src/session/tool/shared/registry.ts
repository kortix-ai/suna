import { toolKind } from '@kortix/sdk';
import { resolveRegisteredKey, toolRegistryCandidates } from '@kortix/shared/tools';
import type { ToolComponent } from './types';

const registry = new Map<string, ToolComponent>();

/** A session-log block `kind` → the registered name whose renderer draws it. `plan`, `mcp`, `other` have none. */
const KIND_RENDERER: Record<string, string> = {
  shell: 'bash',
  read: 'read',
  write: 'write',
  edit: 'edit',
  patch: 'apply-patch',
  list: 'list',
  glob: 'glob',
  grep: 'grep',
  web_fetch: 'webfetch',
  web_search: 'websearch',
  todo: 'todowrite',
  task: 'task',
  question: 'question',
};

export const ToolRegistry = {
  register(name: string, component: ToolComponent) {
    registry.set(name, component);
  },
  keys(): string[] {
    return Array.from(registry.keys());
  },
  /**
   * The renderer registered for a tool name, else the one for its name's kind (`toolKind`),
   * else the one for the call's session-log block `kind` — so a tool from another harness
   * (a Codex `exec_command`, a Claude Code `LS`) renders like its kind.
   */
  get(name: string, kind?: string): ToolComponent | undefined {
    const key =
      resolveRegisteredKey(toolRegistryCandidates(name), registry.keys()) ??
      resolveRegisteredKey(toolRegistryCandidates(toolKind(name)), registry.keys()) ??
      (kind === undefined ? undefined : KIND_RENDERER[kind]);
    return key === undefined ? undefined : registry.get(key);
  },
};
