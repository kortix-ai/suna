'use client';

import type { AcpPlan, AcpToolCall } from '@kortix/sdk';
import type { ToolPart } from '@/ui';
import { ListTodo } from 'lucide-react';
import { BasicTool, ToolPartRenderer } from './tool-renderers';

export function AcpToolCallCard({ tool, sessionId, compact = false }: { tool: AcpToolCall; sessionId: string; compact?: boolean }) {
  return <ToolPartRenderer part={acpToolCallToPart(tool, sessionId)} sessionId={sessionId} defaultOpen={!compact && (tool.status === 'failed' || tool.status === 'error')} />;
}

export function acpToolCallToPart(tool: AcpToolCall, sessionId: string): ToolPart {
  const name = acpToolName(tool);
  const input = normalizeInput(tool.rawInput, name, tool.locations);
  const output = valueText(tool.rawOutput) || contentText(tool.content);
  const status = tool.status === 'failed' || tool.status === 'error'
    ? 'error'
    : tool.status === 'completed'
      ? 'completed'
      : tool.status === 'in_progress' || tool.status === 'running'
        ? 'running'
        : 'pending';
  const state = status === 'error'
    ? { status, input, output, error: output || `${tool.title} failed`, metadata: { locations: tool.locations, acp: tool.data } }
    : { status, input, output, metadata: { locations: tool.locations, acp: tool.data } };
  return {
    id: `acp-tool:${tool.id}`,
    type: 'tool',
    sessionID: sessionId,
    messageID: `acp-tool-message:${tool.id}`,
    callID: tool.id,
    tool: name,
    state,
  } as ToolPart;
}

/** Classifies an ACP tool call into the canonical tool-renderer name used to
 *  both pick a renderer (`ToolPartRenderer`) and group same-kind runs in the
 *  transcript (see `acp-turn-grouping.ts`). */
export function acpToolName(tool: AcpToolCall): string {
  const hint = `${tool.toolKind ?? ''} ${tool.title}`.toLowerCase();
  if (/execute|terminal|shell|command|bash/.test(hint)) return 'bash';
  if (/apply.?patch|diff|patch/.test(hint)) return 'apply_patch';
  if (/write|create file/.test(hint)) return 'write';
  if (/edit|replace/.test(hint)) return 'edit';
  if (/read|view file/.test(hint)) return 'read';
  if (/glob|find files/.test(hint)) return 'glob';
  if (/search|grep/.test(hint)) return 'grep';
  if (/fetch|http|web/.test(hint)) return 'webfetch';
  const explicit = tool.data.tool ?? tool.data.name;
  return typeof explicit === 'string' && explicit ? explicit : 'acp_tool';
}

function normalizeInput(value: unknown, name: string, locations: unknown[]): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') return name === 'bash' ? { command: value } : { value };
  const first = locations.find((location) => location && typeof location === 'object') as Record<string, unknown> | undefined;
  const path = first?.path ?? first?.uri;
  return typeof path === 'string' ? { filePath: path } : {};
}

function contentText(content: unknown[]): string {
  return content.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    const record = entry as Record<string, unknown>;
    return valueText(record.text ?? record.content ?? record.output);
  }).filter(Boolean).join('\n');
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function AcpPlanCard({ plan }: { plan: AcpPlan }) {
  const count = plan.entries.length;
  return (
    <BasicTool
      icon={<ListTodo />}
      trigger={{ title: 'Plan', subtitle: count ? `${count} step${count > 1 ? 's' : ''}` : 'No plan entries' }}
      defaultOpen={count > 0}
    >
      {count ? (
        <div className="space-y-1.5 px-3 py-2">
          {plan.entries.map((entry, index) => (
            <div key={index} className="text-muted-foreground flex gap-2 text-sm">
              <span className="tabular-nums">{index + 1}.</span>
              <span>{typeof entry === 'string' ? entry : JSON.stringify(entry)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </BasicTool>
  );
}
