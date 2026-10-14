/**
 * Tool calls from harnesses whose tool names the web registry does not know: Codex and
 * Claude Code names and input shapes, as their session-log adapters write them (the
 * `codex` and `claude-code` golden fixtures in `@kortix/api-contract`). Each call renders
 * through the renderer of its block `kind` (`ToolRegistry.get`), not the generic fallback.
 * Two native listings close the list (an OpenCode `list` tree, a pi `ls`): their real output
 * shapes, which the list renderer parses into file rows.
 * Pure data: the tool tests and `/debug/session-fixture` render it.
 */
import type { ToolCallBlock } from '@kortix/sdk';

const call = (id: string, name: string, kind: string, input: unknown, output: string, extra: Partial<ToolCallBlock> = {}): ToolCallBlock => ({
  type: 'tool_call',
  id,
  call_id: `call_foreign_${id}`,
  name,
  kind,
  input,
  status: 'complete',
  result: { content: [{ type: 'text', text: output }], is_error: false },
  ...extra,
});

const CODEX_PATCH = [
  '*** Begin Patch',
  '*** Update File: notes.txt',
  '@@',
  '-hello',
  '+hello world',
  '*** Add File: docs/plan.md',
  '+# Plan',
  '+Ship the kind fallback.',
  '*** End Patch',
].join('\n');

export const FOREIGN_TOOL_CALLS: ToolCallBlock[] = [
  // Codex
  call('codex-exec', 'exec_command', 'shell', { cmd: 'cat hello.txt' }, 'hi\n', {
    result: { content: [{ type: 'text', text: 'hi\n' }], is_error: false, exit_code: 0 },
  }),
  call('codex-shell', 'shell', 'shell', { command: ['bash', '-lc', 'ls -la'] }, 'hello.txt\nnotes.txt\n'),
  call('codex-patch', 'apply_patch', 'patch', CODEX_PATCH, 'Success. Updated the following files:\nM notes.txt\nA docs/plan.md', {
    input_format: 'text',
  }),
  call('codex-plan', 'update_plan', 'todo', {
    explanation: 'Two steps left.',
    plan: [
      { step: 'Read the registry', status: 'completed' },
      { step: 'Map the block kind', status: 'in_progress' },
      { step: 'Walk the debug page', status: 'pending' },
    ],
  }, 'Plan updated'),
  call('codex-spawn', 'spawn_agent', 'task', { message: 'List the files in the workspace' }, '{"agent_id":"agent-1","nickname":"Helper"}'),
  call('codex-question', 'request_user_input', 'question', {
    questions: [{ id: 'scope', header: 'Scope', question: 'Which files should the patch touch?', options: [{ label: 'notes.txt', description: 'Only the notes' }, { label: 'All', description: 'Every text file' }] }],
  }, '{"answers":{"scope":{"answers":["notes.txt"]}}}'),
  // Claude Code
  call('cc-ls', 'LS', 'list', { path: '/workspace/src' }, '- /workspace/src/\n  - index.ts\n  - util.ts\n'),
  call('cc-edit', 'Edit', 'edit', { file_path: '/workspace/src/util.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, 'The file /workspace/src/util.ts has been updated.'),
  call('cc-multiedit', 'MultiEdit', 'edit', { file_path: '/workspace/src/index.ts', edits: [{ old_string: 'foo', new_string: 'bar' }] }, 'Applied 1 edit to /workspace/src/index.ts'),
  call('cc-grep', 'Grep', 'grep', { pattern: 'TODO', path: '/workspace/src', glob: '*.ts' }, 'Found 1 file\n/workspace/src/index.ts'),
  call('cc-agent', 'Agent', 'task', { description: 'List files', prompt: 'List the files in the workspace', subagent_type: 'general-purpose' }, 'Found hello.txt'),
  call('cc-question', 'AskUserQuestion', 'question', {
    questions: [{ question: 'Which notation should the card use?', header: 'Notation', multiSelect: false, options: [{ label: 'Compact', description: '$1.2K' }, { label: 'Full', description: '$1,234.00' }] }],
  }, 'User has answered your questions: "Which notation should the card use?"="Compact".'),
  // Native listings: OpenCode `list` prints the directory, then entries indented two spaces per
  // level; pi `ls` prints entries relative to `path`, `/` after a directory, then a notice.
  call('opencode-list', 'list', 'list', { path: '/workspace/src' }, '/workspace/src/\n  components/\n    Button.tsx\n  index.ts\n'),
  call('pi-ls', 'ls', 'list', { path: '/workspace/src' }, 'components/\nindex.ts\nutil.ts\n\n[3 entries limit reached. Use limit=6 for more]'),
];
