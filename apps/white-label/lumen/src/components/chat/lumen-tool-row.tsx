'use client';

// Every shell call in a Lumen chat is a plain step a lawyer can read: the agent kit's
// `lumen …` commands by what they do ("Searching the vault for …"), any other command
// as SHELL_STEP. A member never sees command text, sandbox paths or the kit's internals.
import { SHELL_STEP, lumenStep, shellCommand } from '@/lib/lumen-step';
import { BasicTool, ToolRegistry, type ToolProps } from '@kortix/ui/session';
import { ScalesIcon } from '@phosphor-icons/react';

function LumenShellRow(props: ToolProps) {
  const command = shellCommand(props.call.input);
  const step = (command && lumenStep(command)) ?? SHELL_STEP;
  const ms = props.call.started_at && props.call.ended_at ? Date.parse(props.call.ended_at) - Date.parse(props.call.started_at) : undefined;
  return <BasicTool icon={<ScalesIcon className="size-4" />} trigger={{ title: step }} durationMs={ms} locked />;
}

ToolRegistry.register('bash', LumenShellRow);
