/**
 * Plain-language narration for Easy mode.
 *
 * Turns the 104 registered tools into sentences a non-technical user can read.
 * The registry holds ~200 keys because every tool registers snake_case,
 * kebab-case and an `oc-` alias — `normalizeName` collapses those first.
 *
 * The `other` fallback is load-bearing: MCP tools have arbitrary `server/tool`
 * names that cannot be enumerated, and tools added after this ships are unknown
 * here. Neither may ever surface a raw identifier.
 */

import { getToolPrimaryArg, normalizeName } from '../../tool/tool-meta';
import type { ToolPart } from '@/ui';

export type StepFamily =
  | 'explore'
  | 'edit'
  | 'run'
  | 'web'
  | 'create'
  | 'plan'
  | 'delegate'
  | 'sessions'
  | 'memory'
  | 'apps'
  | 'automations'
  | 'projects'
  | 'skills'
  | 'ask'
  | 'retired'
  | 'other';

/** Context-engine bookkeeping — meaningless to this audience, so Easy mode omits it. */
const HIDDEN = new Set(['prune', 'distill', 'compress', 'context_info']);

const FAMILY_BY_TOOL: Record<string, StepFamily> = {};
function assign(family: StepFamily, tools: string[]) {
  for (const t of tools) FAMILY_BY_TOOL[t] = family;
}

assign('explore', ['read', 'glob', 'grep', 'list']);
assign('edit', ['write', 'edit', 'morph_edit', 'apply_patch']);
assign('run', ['bash', 'pty_spawn', 'pty_read', 'pty_write', 'pty_input', 'pty_kill']);
assign('web', [
  'web_search', 'websearch', 'web_fetch', 'webfetch',
  'scrape_webpage', 'scrapewebpage', 'image_search',
]);
assign('create', ['image_gen', 'video_gen', 'presentation_gen', 'show', 'show_user']);
assign('plan', [
  'todo_write', 'todowrite', 'task', 'task_create', 'task_get', 'task_list',
  'task_update', 'task_done', 'task_delete', 'task_start', 'task_message',
  'task_approve', 'task_cancel',
]);
assign('delegate', [
  'agent_spawn', 'agent_message', 'agent_status', 'agent_stop', 'agent_task',
  'agent_task_create', 'agent_task_get', 'agent_task_list', 'agent_task_update',
  'agent_task_start', 'agent_task_message', 'agent_task_approve', 'agent_task_cancel',
]);
assign('sessions', [
  'session_get', 'session_read', 'session_search', 'session_message', 'session_spawn',
  'session_lineage', 'session_stats', 'session_list', 'session_list_background',
  'session_list_spawned', 'session_start_background',
]);
assign('memory', ['memory', 'memory_search', 'mem_search', 'ltm_search', 'get_mem']);
assign('apps', [
  'connector_get', 'connector_list', 'connector_setup',
  'kortix_executor_call', 'kortix_executor_connectors',
  'kortix_executor_describe', 'kortix_executor_discover',
]);
assign('automations', [
  'triggers', 'trigger_create', 'trigger_delete', 'trigger_get', 'trigger_list',
  'trigger_pause', 'trigger_resume', 'trigger_test', 'trigger_update',
]);
assign('projects', [
  'project_create', 'project_delete', 'project_get',
  'project_list', 'project_select', 'project_update',
]);
assign('skills', ['skill']);
assign('ask', ['question', 'ask']);
assign('retired', [
  'integration_list', 'integration_connect', 'integration_search', 'integration_actions',
  'integration_run', 'integration_request', 'integration_exec',
]);

export function familyForTool(toolName: string): StepFamily | 'hidden' {
  const n = normalizeName(toolName);
  if (HIDDEN.has(n)) return 'hidden';
  return FAMILY_BY_TOOL[n] ?? 'other';
}

/** `linear/create_issue` → `Create Issue`. Never returns a raw identifier. */
export function humanizeToolName(toolName: string): string {
  const n = normalizeName(toolName);
  const leaf = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
  return leaf
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The primary arg of the first part, if it has one (a filename, a query, …). */
function firstArg(parts: ToolPart[]): string {
  return parts.length ? getToolPrimaryArg(parts[0]) : '';
}

/**
 * One sentence for a group of same-family calls.
 * `parts` is guaranteed non-empty and homogeneous by `group-steps`.
 */
export function narrateStep(family: StepFamily, parts: ToolPart[]): string {
  const n = parts.length;
  const arg = firstArg(parts);

  switch (family) {
    case 'explore': {
      const reads = parts.filter((p) => normalizeName(p.tool) === 'read').length;
      if (reads === n) return `Read ${n} ${plural(n, 'file', 'files')}`;
      if (reads === 0) return 'Looked through your files';
      return `Looked through your files · ${reads} read`;
    }
    case 'edit': {
      if (n === 1) {
        const verb = normalizeName(parts[0].tool) === 'write' ? 'Wrote' : 'Updated';
        return arg ? `${verb} ${arg}` : `${verb} a file`;
      }
      return `Updated ${n} files`;
    }
    case 'run':
      return n === 1 ? 'Ran a command' : `Ran ${n} commands`;
    case 'web': {
      const searches = parts.filter((p) => {
        const t = normalizeName(p.tool);
        return t === 'web_search' || t === 'websearch' || t === 'image_search';
      }).length;
      if (searches === n) return `Searched the web · ${n} ${plural(n, 'query', 'queries')}`;
      if (searches === 0) return `Read ${n} ${plural(n, 'page', 'pages')}`;
      return `Searched and read ${n} ${plural(n, 'source', 'sources')}`;
    }
    case 'create': {
      const t = normalizeName(parts[0].tool);
      if (t === 'image_gen') return n === 1 ? 'Made an image' : `Made ${n} images`;
      if (t === 'video_gen') return n === 1 ? 'Made a video' : `Made ${n} videos`;
      if (t === 'presentation_gen') return 'Built a presentation';
      return arg ? `Showed you ${arg}` : 'Showed you the result';
    }
    case 'plan':
      return n === 1 ? 'Planned the work' : `Planned the work · ${n} steps`;
    case 'delegate':
      return n === 1 ? 'Asked a helper agent' : `Worked with ${n} helper agents`;
    case 'sessions':
      return 'Checked earlier work';
    case 'memory':
      return 'Recalled what you told it before';
    case 'apps':
      return arg ? `Connected to ${arg}` : 'Connected to an app';
    case 'automations':
      return n === 1 ? 'Set up an automation' : `Updated ${n} automations`;
    case 'projects':
      return arg ? `Opened ${arg}` : 'Opened your project';
    case 'skills':
      return arg ? `Used the ${arg} skill` : 'Used a skill';
    case 'ask':
      return 'Asked you a question';
    case 'retired':
      return 'Used an integration that has since been removed';
    case 'other':
      return `Used ${humanizeToolName(parts[0].tool)}`;
  }
}
