'use client';

// The agent kit's `lumen …` commands, drawn as plain steps ("Searching the vault for …").
// Every other shell call keeps @kortix/ui's own row, which this delegates to.
import { lumenStep } from '@/lib/lumen-step';
import { BasicTool, ToolRegistry, type ToolComponent, type ToolProps } from '@kortix/ui/session';
import { ScalesIcon } from '@phosphor-icons/react';

type Row = ToolComponent & { stock?: ToolComponent };
const current = ToolRegistry.get('bash') as Row | undefined;
// Hot reload runs this module again: keep the stock row, never wrap our own.
const stock = current?.stock ?? current;

function LumenShellRow(props: ToolProps) {
  const input = props.call.input as { command?: unknown } | null;
  const step = typeof input?.command === 'string' ? lumenStep(input.command) : null;
  if (!step) return stock ? <StockRow {...props} /> : null;
  const ms = props.call.started_at && props.call.ended_at ? Date.parse(props.call.ended_at) - Date.parse(props.call.started_at) : undefined;
  return <BasicTool icon={<ScalesIcon className="size-4" />} trigger={{ title: step }} durationMs={ms} locked />;
}

function StockRow(props: ToolProps) {
  const Stock = stock!;
  return <Stock {...props} />;
}

(LumenShellRow as Row).stock = stock;
ToolRegistry.register('bash', LumenShellRow);
