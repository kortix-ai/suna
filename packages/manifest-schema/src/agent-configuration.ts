import { validAgentResourceSource, AGENT_RESOURCE_SOURCE_PATTERN } from './agent-resources';
import { manifestDefaultConfigDir } from './constants';
import type { ManifestIssue } from './issue';
import type { PermissionConfigV2 } from './index.v2';

export const AGENT_BEHAVIOR_KEYS = [
  'description',
  'mode',
  'model',
  'variant',
  'temperature',
  'top_p',
  'options',
  'color',
  'steps',
  'hidden',
  'permission',
  'disable',
] as const;

export interface AgentConfiguration {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  options?: Record<string, unknown>;
  color?: string;
  steps?: number;
  hidden?: boolean;
  permission?: PermissionConfigV2;
  disable?: boolean;
  prompt?: string | { file: string };
  pi?: { source: string };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function manifestConfigDir(manifest: Record<string, unknown>): string {
  if (manifest.config_dir !== undefined) {
    if (!validAgentResourceSource(manifest.config_dir))
      throw new Error(
        'config_dir must be a repository-relative directory without secrets or traversal',
      );
    return manifest.config_dir;
  }
  for (const block of [manifest.pi, manifest.opencode]) {
    if (record(block) && typeof block.config_dir === 'string' && block.config_dir.trim())
      return block.config_dir.trim().replace(/\/+$/, '');
  }
  return manifestDefaultConfigDir(Number(manifest.kortix_version));
}

export function validateAgentConfiguration(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
  validateBehavior: (value: Record<string, unknown>, path: string, issues: ManifestIssue[]) => void,
): void {
  if (value === undefined) return;
  const fail = (suffix: string, message: string) =>
    issues.push({ path: path + suffix, message, severity: 'error' });
  if (!record(value)) {
    fail('', 'must be an object');
    return;
  }
  for (const key of Object.keys(value))
    if (![...AGENT_BEHAVIOR_KEYS, 'prompt', 'pi'].includes(key))
      fail('.' + key, 'unknown agent configuration setting');
  validateBehavior(value, path, issues);
  if (value.prompt !== undefined && typeof value.prompt !== 'string') {
    if (
      !record(value.prompt) ||
      Object.keys(value.prompt).length !== 1 ||
      !validAgentResourceSource(value.prompt.file)
    )
      fail('.prompt', 'must be text or an object with one repository-relative file path');
  }
  if (value.pi !== undefined) {
    if (
      !record(value.pi) ||
      Object.keys(value.pi).length !== 1 ||
      !validAgentResourceSource(value.pi.source) ||
      !/\.(ts|js|mjs)$/.test(value.pi.source)
    )
      fail('.pi', 'must declare one repository-relative TypeScript or JavaScript source file');
  }
}

export function agentConfigurationSchema(behaviorProperties: Record<string, unknown>) {
  const filePath = {
    type: 'string',
    minLength: 1,
    maxLength: 1024,
    pattern: AGENT_RESOURCE_SOURCE_PATTERN,
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...behaviorProperties,
      prompt: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['file'],
            properties: { file: filePath },
          },
        ],
      },
      pi: {
        type: 'object',
        additionalProperties: false,
        required: ['source'],
        properties: { source: { allOf: [filePath, { pattern: '\\.(ts|js|mjs)$' }] } },
      },
    },
  };
}
