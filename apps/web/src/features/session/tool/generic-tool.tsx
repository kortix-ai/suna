'use client';

import {
  BasicTool,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { Cpu } from 'lucide-react';
import { useMemo } from 'react';

function parseToolName(tool: string): {
  server: string | null;
  name: string;
  display: string;
} {
  const slashIdx = tool.lastIndexOf('/');
  const server = slashIdx > 0 ? tool.slice(0, slashIdx) : null;
  const name = slashIdx > 0 ? tool.slice(slashIdx + 1) : tool;

  const display = name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { server, name, display };
}

export function GenericTool({ part }: ToolProps) {
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
    >
      {output ? <ToolOutputFallback output={output} toolName={part.tool} /> : null}
    </BasicTool>
  );
}

