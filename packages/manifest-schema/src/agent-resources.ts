import type { ManifestIssue } from './issue';

export interface AgentResources {
  worker?: Record<string, string>;
  environment?: Array<{ source: string; target: string; mode: 'seed' | 'read_only' }>;
}

export const AGENT_RESOURCE_NAME_PATTERN = '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$';
const resourcePathPart = String.raw`(?!(?:\.{1,2}|\.git|\.env(?:\.[^/]*)?)(?:/|$))[^/\\\x00-\x1f\x7f]+`;
export const AGENT_RESOURCE_SOURCE_PATTERN = String.raw`^(?!\s)(?!.*\s$)${resourcePathPart}(?:/${resourcePathPart})*$`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validAgentResourceSource(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1024 &&
    value === value.trim() &&
    new RegExp(AGENT_RESOURCE_SOURCE_PATTERN).test(value)
  );
}

export function validateAgentResources(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (value === undefined) return;
  const fail = (suffix: string, message: string) =>
    issues.push({ path: path + suffix, message, severity: 'error' });
  if (!record(value)) {
    fail('', 'must be an object');
    return;
  }
  for (const key of Object.keys(value))
    if (!['worker', 'environment'].includes(key)) fail('.' + key, 'unknown resource setting');
  if (value.worker !== undefined) {
    if (!record(value.worker)) fail('.worker', 'must map resource names to repository paths');
    else {
      if (Object.keys(value.worker).length > 64) fail('.worker', 'exceeds 64 resources');
      for (const [name, source] of Object.entries(value.worker)) {
        if (!new RegExp(AGENT_RESOURCE_NAME_PATTERN).test(name))
          fail('.worker.' + name, 'invalid resource name');
        if (!validAgentResourceSource(source))
          fail(
            '.worker.' + name,
            'must be a repository-relative file path without secrets or traversal',
          );
      }
    }
  }
  if (value.environment !== undefined) {
    if (!Array.isArray(value.environment) || value.environment.length > 64)
      fail('.environment', 'must contain at most 64 files');
    else {
      const targets = new Set<string>();
      value.environment.forEach((file, i) => {
        const at = '.environment.' + i;
        if (!record(file)) {
          fail(at, 'must be a resource object');
          return;
        }
        for (const key of Object.keys(file))
          if (!['source', 'target', 'mode'].includes(key))
            fail(at + '.' + key, 'unknown resource setting');
        if (!validAgentResourceSource(file.source))
          fail(at + '.source', 'invalid repository-relative source path');
        const prefix = file.mode === 'seed' ? '/workspace/' : '/opt/kortix/helpers/';
        if (!['seed', 'read_only'].includes(String(file.mode)))
          fail(at + '.mode', 'must be seed or read_only');
        if (
          typeof file.target !== 'string' ||
          !file.target.startsWith(prefix) ||
          !validAgentResourceSource(file.target.slice(prefix.length))
        )
          fail(at + '.target', `must be a file below ${prefix} without traversal`);
        else if (
          [...targets].some(
            (target) =>
              target === file.target ||
              target.startsWith(file.target + '/') ||
              (file.target as string).startsWith(target + '/'),
          )
        )
          fail(at + '.target', 'duplicate or overlapping resource destination');
        else targets.add(file.target);
      });
    }
  }
}

export function agentResourcesSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      worker: {
        type: 'object',
        maxProperties: 64,
        propertyNames: { pattern: AGENT_RESOURCE_NAME_PATTERN },
        additionalProperties: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          pattern: AGENT_RESOURCE_SOURCE_PATTERN,
        },
      },
      environment: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'target', 'mode'],
          properties: {
            source: {
              type: 'string',
              minLength: 1,
              maxLength: 1024,
              pattern: AGENT_RESOURCE_SOURCE_PATTERN,
            },
            target: { type: 'string', maxLength: 1044 },
            mode: { enum: ['seed', 'read_only'] },
          },
          allOf: [
            {
              if: { properties: { mode: { const: 'seed' } } },
              then: {
                properties: {
                  target: {
                    pattern: '^/workspace/' + AGENT_RESOURCE_SOURCE_PATTERN.slice(1),
                    maxLength: 1035,
                  },
                },
              },
            },
            {
              if: { properties: { mode: { const: 'read_only' } } },
              then: {
                properties: {
                  target: {
                    pattern: '^/opt/kortix/helpers/' + AGENT_RESOURCE_SOURCE_PATTERN.slice(1),
                    maxLength: 1044,
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}
