'use client';

import {
  BasicTool,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { CpuIcon as Cpu } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { humanizeToolName } from '@/features/session/action-panel/shared/narration';

/**
 * `linear/create_issue` → server `linear`, display `Create Issue`.
 *
 * The display half delegates to `humanizeToolName` rather than word-splitting
 * `tool` here. MCP ids also arrive as `mcp__server__tool_name`, where `__` is
 * the hierarchy separator, and a `/`-only split left the whole identifier in
 * the title ("Mcp  Linear  Create Issue", double space included) — directly
 * under a group row that had already humanized the same call correctly. One
 * humanizer, one result, everywhere a tool name is shown.
 */
export function parseToolName(tool: string): {
  server: string | null;
  display: string;
} {
  const slashIdx = tool.lastIndexOf('/');
  const server = slashIdx > 0 ? tool.slice(0, slashIdx) : null;
  return { server, display: humanizeToolName(tool) };
}

export function GenericTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const output = partOutput(part);
  const input = partInput(part);
  const { server, display } = useMemo(() => parseToolName(part.tool), [part.tool]);

  const subtitle = useMemo(() => {
    const keys = [
      'description',
      'query',
      'url',
      'filePath',
      'file_path',
      'path',
      'pattern',
      'name',
      'prompt',
    ];
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.length > 0) return v.length > 80 ? v.slice(0, 77) + '…' : v;
    }
    return undefined;
  }, [input]);

  const args = useMemo(() => {
    const skip = new Set([
      'description',
      'query',
      'url',
      'filePath',
      'file_path',
      'path',
      'pattern',
      'name',
      'prompt',
    ]);
    return Object.entries(input)
      .filter(([k]) => !skip.has(k))
      .flatMap(([k, v]) => {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          return [`${k}=${v}`];
        return [];
      })
      .slice(0, 3);
  }, [input]);

  return (
    <BasicTool
      icon={<Cpu />}
      trigger={{
        title: display,
        subtitle,
        args: server ? [server, ...args] : args.length > 0 ? args : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {output ? <ToolOutputFallback output={output} toolName={part.tool} /> : null}
    </BasicTool>
  );
}
