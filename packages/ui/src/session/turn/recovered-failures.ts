import {
  shellExitCode,
  toolCallMetadata,
  toolCallRawOutput,
  type SessionLogBlock,
  type ToolCallBlock,
} from '@kortix/sdk';

/** A shell command that ran and exited non-zero, by either harness's record of its code. */
function failedCommand(block: ToolCallBlock): boolean {
  if (block.name !== 'bash' || block.status !== 'complete') return false;
  const recorded = toolCallMetadata(block).exit;
  const exit = shellExitCode(toolCallRawOutput(block)) ?? (typeof recorded === 'number' ? recorded : undefined);
  return typeof exit === 'number' && exit !== 0;
}

/**
 * The failed commands of a turn that a later step worked past: a call after them
 * completed and did not fail. A probe such as `ls missing-dir` exits non-zero by
 * design, and the agent carries on; only a failure the turn ended on is still
 * the news (KRTX-3021).
 */
export function recoveredShellFailures(blocks: readonly SessionLogBlock[]): Set<string> {
  const recovered = new Set<string>();
  const pending: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_call') continue;
    if (failedCommand(block)) {
      pending.push(block.id);
    } else if (block.status === 'complete') {
      for (const id of pending) recovered.add(id);
      pending.length = 0;
    }
  }
  return recovered;
}
