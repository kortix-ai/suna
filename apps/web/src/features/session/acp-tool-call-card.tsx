'use client';

import { acpToolCallToPart as acpToolCallToPartSdk, acpToolName as acpToolNameSdk, type AcpPlan, type AcpToolCall } from '@kortix/sdk';
import type { ToolPart } from '@/ui';
import { Check, ListTodo } from 'lucide-react';
import Loading from '@/components/ui/loading';
import { BasicTool, ToolPartRenderer } from './tool-renderers';

/**
 * Canonical tool-renderer name for an ACP tool call. The classification lives
 * in the SDK (`@kortix/sdk`, harness-neutral) — this re-export gives the web
 * transcript's grouping code (`acp-turn-grouping.ts`, `acp-transcript-groups.tsx`)
 * ONE implementation to import from the card module, without a second copy.
 */
export const acpToolName = acpToolNameSdk;

export function AcpToolCallCard({ tool, sessionId, compact = false }: { tool: AcpToolCall; sessionId: string; compact?: boolean }) {
  const part = acpToolCallToPart(tool, sessionId);
  return <ToolPartRenderer part={part} sessionId={sessionId} defaultOpen={!compact && part.state.status === 'error'} />;
}

/**
 * Thin host adapter over the SDK's harness-neutral normalization: adds the
 * `ToolPart`-only host fields (`sessionID`, `messageID`, `type`) the SDK
 * deliberately omits, since it never invents a session id. `as ToolPart` is
 * the boundary cast — the SDK's `AcpNormalizedToolPart` and the web `ToolPart`
 * shape agree on everything except these host fields.
 */
export function acpToolCallToPart(tool: AcpToolCall, sessionId: string): ToolPart {
  const normalized = acpToolCallToPartSdk(tool);
  return {
    ...normalized,
    type: 'tool',
    sessionID: sessionId,
    messageID: `acp-tool-message:${tool.id}`,
  } as ToolPart;
}

export function AcpPlanCard({ plan }: { plan: AcpPlan }) {
  // Superset of both branches of the merge: theirs wraps the plan in a
  // `BasicTool` disclosure with a step-count subtitle; ours renders each entry
  // with a per-status tick (green check / spinner / muted dot) and the entry's
  // content-or-title text (not `JSON.stringify`). Keep both.
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
            <div key={index} className="text-muted-foreground flex items-center gap-2 text-sm">
              <PlanEntryStatusTick entry={entry} />
              <span>{planEntryText(entry)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </BasicTool>
  );
}

/**
 * A wire plan entry is unknown-shaped — the SDK passes `update.entries`
 * straight through untyped (real ACP entries carry `{ status, content }` or
 * `{ status, title }`; the transcript tests exercise plain strings too), so
 * both the tick and the label below guard with `isPlainRecord` rather than
 * assuming a record shape.
 */
function PlanEntryStatusTick({ entry }: { entry: unknown }) {
  const status = isPlainRecord(entry) ? entry.status : undefined;
  if (status === 'completed') return <Check className="text-kortix-green size-3.5 shrink-0" />;
  if (status === 'in_progress') return <Loading className="size-3 shrink-0" />;
  return <span className="bg-muted-foreground/40 size-1.5 shrink-0 rounded-full" aria-hidden />;
}

function planEntryText(entry: unknown): string {
  if (isPlainRecord(entry)) {
    const value = entry.content ?? entry.title;
    if (typeof value === 'string') return value;
    if (value !== undefined) return String(value);
  }
  return String(entry);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
