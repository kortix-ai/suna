/**
 * One tool taxonomy for every harness: a tool name → the kind of action it
 * is. Narration families, view-models, tool info, registry categories and the
 * context-tool group all derive from `toolKind`, so a harness with its own
 * tool names needs one line in `TOOL_KIND` to render like the rest.
 *
 * The core kinds use the names web and mobile register their renderers
 * under, so `registry.get(toolKind(name))` finds a renderer for an alias.
 */

export type ToolKind =
  | 'read'
  | 'list'
  | 'glob'
  | 'grep'
  | 'write'
  | 'edit'
  | 'apply_patch'
  | 'bash'
  | 'pty'
  | 'web_search'
  | 'webfetch'
  | 'media'
  | 'show'
  | 'task'
  | 'delegate'
  | 'sessions'
  | 'todowrite'
  | 'question'
  | 'memory'
  | 'connectors'
  | 'automations'
  | 'projects'
  | 'skill'
  | 'context'
  | 'retired'
  | 'other';

/** Keyed by the normalized name (no `oc-`/`oc_` prefix, `_` for `-`). */
const TOOL_KIND: Record<string, ToolKind> = {};
function kind(value: ToolKind, names: string[]) {
  for (const name of names) TOOL_KIND[name] = value;
}

kind('read', ['read']);
kind('list', ['list', 'ls']);
kind('glob', ['glob']);
kind('grep', ['grep']);
kind('write', ['write']);
kind('edit', ['edit', 'multiedit', 'morph_edit']);
kind('apply_patch', ['apply_patch', 'patch']);
kind('bash', ['bash']);
kind('web_search', ['web_search', 'websearch', 'image_search']);
kind('webfetch', ['webfetch', 'web_fetch', 'scrape_webpage', 'scrapewebpage']);
kind('media', ['image_gen', 'video_gen']);
kind('show', ['show', 'show_user', 'presentation_gen']);
kind('task', ['task']);
// Legacy plugin tools that spawn, message, check, stop or finish a helper agent.
kind('delegate', [
  'agent_spawn',
  'agent_task',
  'agent_task_create',
  'agent_task_start',
  'task_create',
  'task_start',
  'session_spawn',
  'session_start_background',
  'agent_message',
  'agent_task_message',
  'task_message',
  'agent_task_update',
  'task_update',
  'session_message',
  'agent_status',
  'agent_task_list',
  'agent_task_get',
  'task_list',
  'task_get',
  'agent_stop',
  'agent_task_cancel',
  'task_cancel',
  'agent_task_approve',
  'task_approve',
  'task_done',
  'task_delete',
]);
kind('todowrite', ['todowrite', 'todo_write', 'todoread']);
kind('question', ['question', 'ask']);
kind('memory', ['memory', 'memory_search', 'mem_search', 'ltm_search', 'get_mem']);
kind('connectors', [
  'connector_get',
  'connector_list',
  'connector_setup',
  'kortix_connector_call',
  'kortix_connectors',
  'kortix_connectors_connectors',
  'kortix_connectors_discover',
  'kortix_connectors_describe',
  'kortix_connectors_call',
  'kortix_connector_describe',
  'kortix_connector_discover',
]);
kind('automations', ['triggers']);
kind('skill', ['skill']);
// Context-engine bookkeeping.
kind('context', ['prune', 'distill', 'compress', 'context_info']);
kind('retired', [
  'integration_list',
  'integration_connect',
  'integration_search',
  'integration_actions',
  'integration_run',
  'integration_request',
  'integration_exec',
]);

/** Families a new tool joins by its name's prefix, checked in order. */
const PREFIX_KIND: Array<[prefix: string, kind: ToolKind]> = [
  ['pty_', 'pty'],
  ['agent_', 'delegate'],
  ['task_', 'delegate'],
  ['session_', 'sessions'],
  ['trigger_', 'automations'],
  ['project_', 'projects'],
];

/** The kind of action a tool name performs; `other` when it is not known. */
export function toolKind(name: string): ToolKind {
  const normalized = name.replace(/^oc[-_]/, '').replace(/-/g, '_');
  const known = TOOL_KIND[normalized];
  if (known) return known;
  for (const [prefix, value] of PREFIX_KIND) if (normalized.startsWith(prefix)) return value;
  return 'other';
}

/** The file a file tool's input names: OpenCode `filePath`, `file_path`, or pi's `path`. */
export function inputPath(input: Record<string, unknown> | undefined): string | undefined {
  for (const value of [input?.filePath, input?.file_path, input?.path]) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}
