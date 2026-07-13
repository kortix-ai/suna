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
 *
 * GOVERNING RULE: narration must never mislead. A tool's family and sentence
 * are decided by what its registered component actually renders/does (see
 * apps/web/src/features/session/tool/tools/*.tsx), not by how its name reads.
 * Several tools register the *same* component under multiple aliases (e.g.
 * `task_create` and `agent_task_create` both render `AgentSpawnTool`) — those
 * aliases must always resolve to the same family and the same sentence.
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

// `todo_write` is the model's own step checklist — nothing is delegated to
// another agent. This is the ONLY thing left in `plan`; every `task_*` /
// `agent_task_*` alias below shares a component with an explicit agent_*
// delegation tool, so it belongs in `delegate`, not here.
assign('plan', ['todo_write', 'todowrite']);

// Every one of these renders one of: AgentSpawnTool, AgentTaskUpdateTool,
// AgentMessageTool, TaskDoneTool, AgentStopTool, AgentStatusTool, or
// TaskListTool — the same components the bare `agent_*` tools render. A
// `task_*` alias and its `agent_task_*` twin MUST land here together, or the
// same backend action narrates two different ways depending on which the
// model happened to emit.
assign('delegate', [
  // spawn a helper agent to do work (renders AgentSpawnTool / SessionSpawnTool)
  'agent_spawn', 'agent_task', 'agent_task_create', 'agent_task_start',
  'task', 'task_create', 'task_start',
  'session_spawn', 'session_start_background',
  // send an instruction/update to a running helper (AgentMessageTool / AgentTaskUpdateTool)
  'agent_message', 'agent_task_message', 'task_message',
  'agent_task_update', 'task_update',
  'session_message',
  // read-only status check on helpers/tasks (AgentStatusTool / TaskListTool)
  'agent_status', 'agent_task_list', 'agent_task_get', 'task_list', 'task_get',
  // stop a running helper (AgentStopTool)
  'agent_stop', 'agent_task_cancel', 'task_cancel',
  // mark a helper's task done (TaskDoneTool)
  'agent_task_approve', 'task_approve', 'task_done',
  // remove a task (TaskDeleteTool)
  'task_delete',
]);
// Genuine read-only lookups of past/other session state — no delegation happens here.
assign('sessions', [
  'session_get', 'session_read', 'session_search',
  'session_lineage', 'session_stats', 'session_list', 'session_list_background',
  'session_list_spawned',
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

/** `["a"]` → `"a"`; `["a","b"]` → `"a and b"`; `["a","b","c"]` → `"a, b, and c"`. */
function joinWithAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** The primary arg of the first part, if it has one (a filename, a query, …). */
function firstArg(parts: ToolPart[]): string {
  return parts.length ? getToolPrimaryArg(parts[0]) : '';
}

/** Raw tool input, for the rare case a sentence must depend on an argument
 * rather than the tool name (e.g. the bare `triggers` tool's `action` field). */
function rawInput(part: ToolPart): Record<string, unknown> {
  const state = (part.state ?? {}) as { input?: Record<string, unknown> };
  return state.input ?? {};
}

// ─── delegate: what is this task/agent call actually doing? ────────────────

type DelegateAction = 'spawn' | 'message' | 'status' | 'stop' | 'done' | 'delete';

const DELEGATE_ACTION: Record<string, DelegateAction> = {
  agent_spawn: 'spawn',
  agent_task: 'spawn',
  agent_task_create: 'spawn',
  agent_task_start: 'spawn',
  task: 'spawn',
  task_create: 'spawn',
  task_start: 'spawn',
  session_spawn: 'spawn',
  session_start_background: 'spawn',

  agent_message: 'message',
  agent_task_message: 'message',
  task_message: 'message',
  // agent_task_update / task_update are NOT looked up here — they're
  // themselves action-multiplexed, and `delegateAction` below resolves them
  // from their own `action` field before ever consulting this table.
  session_message: 'message',

  agent_status: 'status',
  agent_task_list: 'status',
  agent_task_get: 'status',
  task_list: 'status',
  task_get: 'status',

  agent_stop: 'stop',
  agent_task_cancel: 'stop',
  task_cancel: 'stop',

  agent_task_approve: 'done',
  task_approve: 'done',
  task_done: 'done',

  task_delete: 'delete',
};

/**
 * `agent_task_update` / `task_update` are themselves action-multiplexed: the
 * same tool name further dispatches on its own `action` field to render one
 * of four unrelated components (AgentSpawnTool / AgentMessageTool /
 * AgentStopTool / TaskDoneTool — see AgentTaskUpdateTool). The static
 * DELEGATE_ACTION table can't see that field, so resolve it here first;
 * every other delegate tool keeps its fixed table lookup. Default ('message')
 * matches the component's own default branch.
 */
function delegateAction(part: ToolPart): DelegateAction {
  const t = normalizeName(part.tool);
  if (t === 'agent_task_update' || t === 'task_update') {
    switch ((rawInput(part).action as string) || '') {
      case 'start':
        return 'spawn';
      case 'cancel':
        return 'stop';
      case 'approve':
        return 'done';
      default:
        return 'message';
    }
  }
  return DELEGATE_ACTION[t] ?? 'message';
}

// ─── automations: create/update vs read vs delete vs pause/resume vs a test dry run ─

type AutomationAction = 'create' | 'update' | 'delete' | 'read' | 'control' | 'test';

function classifyAutomationAction(action: string): AutomationAction {
  switch (action) {
    case 'create':
      return 'create';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    case 'test':
      // A dry run: the trigger's component title is literally "Test Trigger"
      // and nothing is created, paused, or resumed. Must stay distinct from
      // 'control' or a dry run reads as a real mutation.
      return 'test';
    case 'pause':
    case 'resume':
      return 'control';
    case 'list':
    case 'get':
    default:
      return 'read';
  }
}

function automationAction(part: ToolPart): AutomationAction {
  const t = normalizeName(part.tool);
  if (t === 'triggers') {
    // The tool's own default is 'list' when the model omits the field —
    // match that exactly so the narration can never disagree with the UI.
    const action = (rawInput(part).action as string) || 'list';
    return classifyAutomationAction(action);
  }
  const m = t.match(/^trigger_(.+)$/);
  return classifyAutomationAction(m ? m[1] : 'list');
}

// ─── apps: discovery/reads vs actually connecting vs running a connected tool ─

type AppAction = 'connect' | 'read' | 'call';

const APP_ACTION: Record<string, AppAction> = {
  connector_setup: 'connect',
  connector_get: 'read',
  connector_list: 'read',
  kortix_executor_discover: 'read',
  kortix_executor_describe: 'read',
  kortix_executor_connectors: 'read',
  kortix_executor_call: 'call',
};

function appAction(part: ToolPart): AppAction {
  return APP_ACTION[normalizeName(part.tool)] ?? 'read';
}

// ─── projects: opening/viewing vs creating vs updating vs a delete that is a no-op ─

type ProjectAction = 'open' | 'create' | 'update' | 'delete';

const PROJECT_ACTION: Record<string, ProjectAction> = {
  project_get: 'open',
  project_list: 'open',
  project_select: 'open',
  // A real mutation — renames the project and can change its default_branch /
  // manifest_path (PATCH /v1/projects/:projectId) — never "opened".
  project_update: 'update',
  project_create: 'create',
  project_delete: 'delete',
};

function projectAction(part: ToolPart): ProjectAction {
  return PROJECT_ACTION[normalizeName(part.tool)] ?? 'open';
}

function allSame<T>(items: T[]): boolean {
  return items.every((i) => i === items[0]);
}

// ─── memory: the bare `memory` tool multiplexes over `command` (view/create/
// str_replace/insert/rename/delete) like a filesystem editor; the search
// tools (memory_search, mem_search, ltm_search, get_mem) are genuine
// read-only lookups and always narrate as a recall. ─────────────────────────

type MemoryAction = 'read' | 'write' | 'delete' | 'unknown';

const MEMORY_COMMAND_ACTION: Record<string, MemoryAction> = {
  view: 'read',
  create: 'write',
  str_replace: 'write',
  insert: 'write',
  rename: 'write',
  delete: 'delete',
};

function memoryAction(part: ToolPart): MemoryAction {
  const t = normalizeName(part.tool);
  if (t !== 'memory') return 'read'; // memory_search/mem_search/ltm_search/get_mem
  const command = rawInput(part).command as string | undefined;
  return (command && MEMORY_COMMAND_ACTION[command]) || 'unknown';
}

// ─── create: image_gen/presentation_gen multiplex over `action` too ────────
// (see titleMap in image-gen-tool.tsx and the action switch in
// presentation-gen-tool.tsx). A per-tool action→sentence table, each with a
// vague-but-true default for a missing/unrecognized action, keeps this from
// turning into a pile of one-off `if` branches.

const IMAGE_GEN_ACTION_SENTENCE: Record<string, string> = {
  generate: 'Made an image',
  edit: 'Edited an image',
  upscale: 'Upscaled an image',
  remove_bg: 'Removed an image background',
};

const PRESENTATION_GEN_ACTION_SENTENCE: Record<string, string> = {
  create_slide: 'Added a slide to a presentation',
  list_slides: "Checked a presentation's slides",
  list_presentations: 'Checked your presentations',
  delete_slide: 'Deleted a slide from a presentation',
  delete_presentation: 'Deleted a presentation',
  validate_slide: 'Checked a slide',
  export_pdf: 'Exported a presentation to PDF',
  export_pptx: 'Exported a presentation to PPTX',
  preview: 'Previewed a presentation',
  serve: 'Previewed a presentation',
};

function imageGenSentence(part: ToolPart): string {
  const action = rawInput(part).action as string | undefined;
  return (action && IMAGE_GEN_ACTION_SENTENCE[action]) || 'Worked on an image';
}

function presentationGenSentence(part: ToolPart): string {
  const action = rawInput(part).action as string | undefined;
  return (action && PRESENTATION_GEN_ACTION_SENTENCE[action]) || 'Worked on a presentation';
}

/** Only the one action per tool that actually creates new media counts
 * towards a group's "Made N images/presentations" tally — everything else
 * (edit/upscale/delete/export/preview/…) must not be folded into that count.
 * A missing action is treated as a creation, matching each component's own
 * generic default title (e.g. image_gen falls back to "Image Gen"). */
function isImageCreation(part: ToolPart): boolean {
  const action = rawInput(part).action as string | undefined;
  return !action || action === 'generate';
}

function isPresentationCreation(part: ToolPart): boolean {
  const action = rawInput(part).action as string | undefined;
  return !action || action === 'create_slide';
}

/**
 * One sentence for a group of same-family calls.
 * `parts` is guaranteed non-empty and homogeneous by `group-steps` — homogeneous
 * by *family*, not by tool, so a single call can still mix several distinct
 * tools (e.g. `image_gen` + `video_gen`, or `connector_get` + `connector_setup`).
 * Every branch below inspects every part, never just `parts[0]`.
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
      if (n === 1) {
        const p = parts[0];
        const t = normalizeName(p.tool);
        if (t === 'image_gen') return imageGenSentence(p);
        if (t === 'video_gen') return 'Made a video';
        if (t === 'presentation_gen') return presentationGenSentence(p);
        return arg ? `Showed you ${arg}` : 'Showed you the result';
      }

      let images = 0;
      let videos = 0;
      let presentations = 0;
      let shown = 0;
      for (const p of parts) {
        switch (normalizeName(p.tool)) {
          case 'image_gen':
            if (isImageCreation(p)) images++;
            else shown++;
            break;
          case 'video_gen':
            videos++;
            break;
          case 'presentation_gen':
            if (isPresentationCreation(p)) presentations++;
            else shown++;
            break;
          default:
            shown++;
            break;
        }
      }

      const segments: string[] = [];
      if (images) segments.push(`${images} ${plural(images, 'image', 'images')}`);
      if (videos) segments.push(`${videos} ${plural(videos, 'video', 'videos')}`);
      if (presentations)
        segments.push(`${presentations} ${plural(presentations, 'presentation', 'presentations')}`);

      if (segments.length === 0) {
        return `Showed you ${n} ${plural(n, 'result', 'results')}`;
      }
      const made = `Made ${joinWithAnd(segments)}`;
      return shown ? `${made} and showed you more` : made;
    }
    case 'plan':
      return n === 1 ? 'Planned the work' : `Planned the work · ${n} steps`;
    case 'delegate': {
      const actions = parts.map(delegateAction);
      if (allSame(actions)) {
        switch (actions[0]) {
          case 'spawn':
            return n === 1 ? 'Asked a helper agent' : `Worked with ${n} helper agents`;
          case 'message':
            return n === 1
              ? 'Sent instructions to a helper agent'
              : `Sent instructions to ${n} helper agents`;
          case 'status':
            return 'Checked on a helper agent';
          case 'stop':
            return n === 1 ? 'Stopped a helper agent' : `Stopped ${n} helper agents`;
          case 'done':
            return n === 1 ? 'A helper agent finished a task' : `Helper agents finished ${n} tasks`;
          case 'delete':
            return n === 1 ? 'Removed a task' : `Removed ${n} tasks`;
        }
      }
      return n === 1 ? 'Worked with a helper agent' : `Worked with helper agents · ${n} steps`;
    }
    case 'sessions':
      return 'Checked earlier work';
    case 'memory': {
      const actions = parts.map(memoryAction);
      if (allSame(actions)) {
        switch (actions[0]) {
          case 'write':
            return n === 1 ? 'Wrote to its memory' : `Wrote to its memory · ${n} updates`;
          case 'delete':
            return n === 1 ? 'Deleted from its memory' : `Deleted ${n} things from its memory`;
          case 'read':
            return 'Recalled what you told it before';
        }
      }
      return 'Worked with its memory';
    }
    case 'apps': {
      const actions = parts.map(appAction);
      if (allSame(actions)) {
        switch (actions[0]) {
          case 'connect':
            if (n === 1) return arg ? `Connected to ${arg}` : 'Connected to an app';
            return `Connected to ${n} apps`;
          case 'call':
            return n === 1 ? 'Used a connected app' : `Used ${n} connected apps`;
          case 'read':
            return 'Checked your connected apps';
        }
      }
      return 'Worked with your connected apps';
    }
    case 'automations': {
      const actions = parts.map(automationAction);
      if (allSame(actions)) {
        switch (actions[0]) {
          case 'create':
            return n === 1 ? 'Set up an automation' : `Set up ${n} automations`;
          case 'update':
            return n === 1 ? 'Updated an automation' : `Updated ${n} automations`;
          case 'delete':
            return n === 1 ? 'Deleted an automation' : `Deleted ${n} automations`;
          case 'control':
            return n === 1 ? 'Adjusted an automation' : `Adjusted ${n} automations`;
          case 'test':
            // A dry run — nothing is created, changed, or paused.
            return n === 1 ? 'Tested an automation' : `Tested ${n} automations`;
          case 'read':
            return 'Checked your automations';
        }
      }
      return 'Worked with your automations';
    }
    case 'projects': {
      const actions = parts.map(projectAction);
      if (allSame(actions)) {
        switch (actions[0]) {
          case 'delete':
            return n === 1
              ? "Tried to delete a project — deletion isn't allowed"
              : `Tried to delete ${n} projects — deletion isn't allowed`;
          case 'create':
            if (n === 1) return arg ? `Created ${arg}` : 'Created a project';
            return `Created ${n} projects`;
          case 'update':
            // A real mutation (rename / default_branch / manifest_path) — never "opened".
            if (n === 1) return arg ? `Updated ${arg}` : 'Updated your project';
            return `Updated ${n} projects`;
          case 'open':
            if (n === 1) return arg ? `Opened ${arg}` : 'Opened your project';
            return `Opened ${n} projects`;
        }
      }
      return arg ? `Worked in ${arg}` : 'Worked in your project';
    }
    case 'skills': {
      if (n === 1) return arg ? `Used the ${arg} skill` : 'Used a skill';
      return `Used ${n} skills`;
    }
    case 'ask':
      return 'Asked you a question';
    case 'retired':
      return 'Used an integration that has since been removed';
    case 'other':
      return `Used ${humanizeToolName(parts[0].tool)}`;
  }
}
