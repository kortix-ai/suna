import type { Project } from '@kortix/db';
import type { ChannelEvent, ChannelSpec } from './manifest';

interface RenderInput {
  project: Project;
  spec: ChannelSpec;
  event: ChannelEvent;
  messageText: string;
}

export function renderPromptPrefix(template: string, input: RenderInput): string {
  const payload: Record<string, unknown> = {
    project: { id: input.project.projectId, name: input.project.name },
    channel: { platform: input.spec.platform },
    message: { text: input.messageText },
    event: input.event,
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token: string) => {
    const [root, ...path] = token.split('.');
    if (!root) return '';
    const value = path.length === 0 ? payload[root] : valueAtPath(payload[root], path);
    return scalarize(value);
  });
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const part of path) {
    if (cur === null || cur === undefined) return '';
    if (typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function scalarize(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
