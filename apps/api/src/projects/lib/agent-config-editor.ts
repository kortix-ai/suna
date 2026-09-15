import type { AgentConfiguration } from '@kortix/manifest-schema';
import { KNOWN_BEHAVIOR_KEYS } from './compile-agent-config';

export async function readYamlAgentBehavior(
  config: AgentConfiguration,
  readFile: (path: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const behavior: Record<string, unknown> = {};
  for (const key of KNOWN_BEHAVIOR_KEYS) {
    if (config[key] !== undefined) behavior[key] = config[key];
  }
  if (config.prompt !== undefined)
    behavior.prompt =
      typeof config.prompt === 'string' ? config.prompt : await readFile(config.prompt.file);
  return behavior;
}

export function updateYamlAgentBehavior(
  existing: AgentConfiguration,
  draft: Record<string, unknown>,
): { config: AgentConfiguration; file: { path: string; content: string } | null } {
  const config = { ...existing } as Record<string, unknown>;
  for (const key of KNOWN_BEHAVIOR_KEYS) {
    if (draft[key] !== undefined) config[key] = draft[key];
    else delete config[key];
  }
  let file = null;
  if (typeof existing.prompt === 'object') {
    file = {
      path: existing.prompt.file,
      content: typeof draft.prompt === 'string' ? draft.prompt : '',
    };
  } else if (typeof draft.prompt === 'string') {
    config.prompt = draft.prompt;
  } else {
    delete config.prompt;
  }
  return { config: config as AgentConfiguration, file };
}
