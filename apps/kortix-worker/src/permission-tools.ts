import path from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import type { PermissionAuthorization, PermissionBroker } from './permission-broker.ts';
import { permissionNameForTool } from './permission-policy.ts';

interface ToolPermissionRequest extends Omit<PermissionAuthorization, 'signal' | 'permission'> {
  permission: string;
  externalPath?: string;
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pathDetails(rawPath: string | undefined, workspace: string) {
  if (!rawPath) return { pattern: '*', externalPath: undefined };
  const absolute = path.resolve(workspace, rawPath);
  const relative = path.relative(workspace, absolute);
  const external =
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return {
    pattern: external ? absolute : relative || '.',
    externalPath: external ? absolute : undefined,
  };
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const push = () => {
    if (word) words.push(word);
    word = '';
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character) || ';&|<>'.includes(character)) {
      push();
      continue;
    }
    word += character;
  }
  if (escaped) word += '\\';
  push();
  return words;
}

function bashCommands(command: string): string[] {
  const commands: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const push = () => {
    const value = current.trim();
    if (value) commands.push(value);
    current = '';
  };
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ';' || character === '&' || character === '|' || character === '\n') {
      push();
      continue;
    }
    current += character;
  }
  push();
  return commands;
}

function bashExternalPaths(command: string, workspace: string): string[] {
  const candidates = shellWords(command);
  const paths = new Set<string>();
  for (const candidate of candidates) {
    const assignment = candidate.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/u);
    const token = assignment ? (assignment[1] ?? '') : candidate;
    if (!token) continue;
    if (!token.startsWith('/') && token !== '..' && !token.startsWith('../')) continue;
    const absolute = path.resolve(workspace, token);
    const relative = path.relative(workspace, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      paths.add(absolute);
    }
  }
  return [...paths];
}

function permissionRequest(
  toolName: string,
  params: unknown,
  workspace: string,
): ToolPermissionRequest {
  const input = objectInput(params);
  const permission = permissionNameForTool(toolName);
  if (toolName === 'bash') {
    const command = stringField(input, 'command') ?? '*';
    const patterns = bashCommands(command);
    return {
      permission,
      patterns: patterns.length > 0 ? patterns : ['*'],
      always: patterns.length > 0 ? patterns : ['*'],
      metadata: { command },
    };
  }
  if (toolName === 'glob' || toolName === 'grep') {
    const pattern = stringField(input, 'pattern') ?? '*';
    const requestedPath = pathDetails(stringField(input, 'path'), workspace);
    return {
      permission,
      patterns: [pattern],
      always: ['*'],
      metadata: structuredClone(input),
      externalPath: requestedPath.externalPath,
    };
  }
  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    const requestedPath = pathDetails(stringField(input, 'path'), workspace);
    return {
      permission,
      patterns: [requestedPath.pattern],
      always: ['*'],
      metadata: structuredClone(input),
      externalPath: requestedPath.externalPath,
    };
  }
  if (toolName === 'skill') {
    const name = stringField(input, 'name') ?? '*';
    return {
      permission: 'skill',
      patterns: [name],
      always: [name],
      metadata: {},
    };
  }
  return {
    permission,
    patterns: ['*'],
    always: ['*'],
    metadata: structuredClone(input),
  };
}

export function protectToolsWithPermissions(
  tools: AgentTool[],
  broker: PermissionBroker,
  workspace: string,
  toolContext?: (toolCallId: string) => PermissionAuthorization['tool'],
): AgentTool[] {
  let previousSignature: string | null = null;
  let repeatCount = 0;

  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const request = permissionRequest(tool.name, params, workspace);
      const context = toolContext?.(toolCallId);
      await broker.authorize({ ...request, signal, tool: context });

      const externalPaths =
        tool.name === 'bash'
          ? bashExternalPaths(stringField(objectInput(params), 'command') ?? '', workspace)
          : request.externalPath
            ? [request.externalPath]
            : [];
      if (externalPaths.length > 0) {
        await broker.authorize({
          permission: 'external_directory',
          patterns: externalPaths,
          always: externalPaths,
          metadata: { tool: tool.name, paths: externalPaths },
          tool: context,
          signal,
        });
      }

      const signature = `${tool.name}:${JSON.stringify(params)}`;
      repeatCount = signature === previousSignature ? repeatCount + 1 : 1;
      previousSignature = signature;
      if (repeatCount >= 3) {
        await broker.authorize({
          permission: 'doom_loop',
          patterns: [tool.name],
          always: [tool.name],
          metadata: { tool: tool.name, input: structuredClone(params) },
          tool: context,
          signal,
        });
      }

      return tool.execute(toolCallId, params as never, signal, onUpdate as never);
    },
  })) as AgentTool[];
}
