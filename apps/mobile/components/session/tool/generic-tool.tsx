/**
 * `GenericTool` — port of apps/web `tool/generic-tool.tsx`: the row for a tool
 * with no renderer of its own. Not registered; `ToolPartRenderer` falls back
 * to it.
 *
 * Title: the humanized tool name (`parseToolName`). Subtitle: the first
 * non-empty of description / query / url / filePath / file_path / path /
 * pattern / name / prompt (80 characters max). Args: the MCP server, then up
 * to 3 scalar inputs as `key=value`. Body: the output fallback.
 *
 * `GenericExpandedContent` is the previous mobile fallback body, still
 * re-exported by `tool-part-renderer.tsx`; it goes when that path is removed.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { stripAnsi } from '@kortix/sdk';
import type { ToolPart } from '@/lib/opencode/types';
import { CpuIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { genericArgs, genericSubtitle, genericTriggerArgs, parseToolName } from '@/lib/session/tools/projects-generic';
import { THEME } from '@/lib/utils/theme';
import { BasicTool, partInput, partOutput, ToolOutputFallback } from './shared/infrastructure';
import { MonoBlock } from './shared/output-block';
import type { ToolProps } from './shared/types';

export { parseToolName };

export function GenericTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const output = partOutput(part);
  const input = partInput(part);
  const { server, display } = useMemo(() => parseToolName(part.tool), [part.tool]);
  const subtitle = useMemo(() => genericSubtitle(input), [input]);
  const args = useMemo(() => genericArgs(input), [input]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={CpuIcon}
      trigger={{ title: display, subtitle, args: genericTriggerArgs(server, args) }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {output ? <ToolOutputFallback output={output} toolName={part.tool} /> : null}
    </BasicTool>
  );
}

// ─── Legacy body (tool-part-renderer.tsx generic path) ───────────────────────

/** @deprecated The previous mobile fallback body; `GenericTool` replaces it. */
export function GenericExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      return stripAnsi(tool.state.output).trim();
    }
    if (tool.state.status === 'error' && 'error' in tool.state) {
      return tool.state.error;
    }
    return undefined;
  }, [tool.state]);

  if (!output) return null;

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
      <MonoBlock isDark={isDark} color={tool.state.status === 'error' ? (isDark ? THEME.dark.destructive : THEME.light.destructive) : undefined} maxLines={30}>
        {output.length > 3000 ? output.slice(0, 3000) + '\n...' : output}
      </MonoBlock>
    </View>
  );
}
