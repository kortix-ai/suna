import type { SessionLogMessage, ToolCallBlock } from './types';

/** pi's bash tool appends this to the output of a command that exited non-zero. */
const PI_EXIT_LINE = /(?:\n\n)?Command exited with code (-?\d+)\s*$/;

/**
 * A shell command that ran and exited non-zero, as a completed call with its exit code.
 *
 * pi records it as a failed call: `status: 'error'`, the command's output plus
 * "Command exited with code N". OpenCode records the same command as completed, with the
 * code beside its output. The transcript drew pi's as a tool error, so a probe such as
 * `ls missing-dir` read as a failure of the run (KRTX-3021). Both now read one way. A call
 * that failed for any other reason (a timeout, a refused command) has no such line and
 * keeps its error. Returns the same block when nothing changes.
 *
 * Display only: the store applies it (`put`). `toV1` does not, because a v1 thread also
 * restores a conversation into a harness, and there the model keeps seeing the exit line.
 */
export function normalizeShellExit(block: ToolCallBlock): ToolCallBlock {
  if (block.status !== 'error' || block.name !== 'bash' || !block.result) return block;
  const texts = block.result.content.filter((c) => c.type === 'text');
  const text = texts.map((c) => c.text).join('');
  const exit = PI_EXIT_LINE.exec(text);
  if (!exit) return block;
  const { error: _error, ...result } = block.result;
  return {
    ...block,
    status: 'complete',
    result: {
      ...result,
      content: [
        { type: 'text', text: text.slice(0, exit.index) },
        ...block.result.content.filter((c) => c.type !== 'text'),
      ],
      is_error: false,
      exit_code: Number(exit[1]),
    },
  };
}

/** `message` with its shell calls normalized; the same object when none changed. */
export function normalizeShellExits(message: SessionLogMessage): SessionLogMessage {
  let changed = false;
  const blocks = message.blocks.map((block) => {
    if (block.type !== 'tool_call') return block;
    const next = normalizeShellExit(block);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? { ...message, blocks } : message;
}
