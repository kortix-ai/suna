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
import { wsDomain } from '../../tool/shared/web-helpers';
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

/**
 * `linear/create_issue` → `Create Issue`. Never returns a raw identifier.
 *
 * MCP tool ids also arrive as `mcp__server__tool_name` — `__` is that
 * format's hierarchy separator, the same role `/` plays elsewhere. Without
 * normalizing it first, only the trailing `_` gets word-split, leaving the
 * server segment glued onto the leaf ("Mcp  Linear  Create Issue", still
 * effectively the raw identifier) — collapsing `__` to `/` first lets the
 * existing leaf-splitting logic below do the same job it already does for
 * `linear/create_issue`.
 */
export function humanizeToolName(toolName: string): string {
  const n = normalizeName(toolName).replace(/__+/g, '/');
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

type AutomationAction = 'create' | 'update' | 'delete' | 'read' | 'control' | 'test' | 'unknown';

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
      return 'read';
    default:
      // An action the bare `triggers` tool doesn't recognize either — its own
      // default branch (TriggersTool) renders a generic "Triggers" title, NOT
      // the list branch, so narration must not guess 'read' here or a real
      // mutation under an unrecognized name could pass as a "Checked" no-op.
      return 'unknown';
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

/** Last path segment, tolerant of both `/` and `\` separators — mirrors the
 * private helper `tool-meta.ts`/`derive-panels.ts` each keep their own copy
 * of, rather than exporting one from the off-limits `tool/` directory. */
function basename(p: string): string {
  const cleaned = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * `show`/`show_user` display an existing result — a file, a link, a block of
 * text. `getToolPrimaryArg` has no case for them, so it used to fall through
 * to its generic fallback-key list, which returns `input.path`/`input.url`
 * completely verbatim (a real sandbox path or e2b preview URL straight to a
 * non-technical user — rule 2 forbids exactly this). ShowTool itself renders
 * `input.title` as its own heading, so prefer that; then a description; and
 * only when neither exists fall back to a BASENAME or DOMAIN — never the raw
 * path/URL itself.
 */
function showLabel(part: ToolPart): string {
  const input = rawInput(part);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title) return title;
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description) return truncate(description, 60);
  const path = typeof input.path === 'string' ? input.path : '';
  if (path) return basename(path);
  const url = typeof input.url === 'string' ? input.url : '';
  if (url) return wsDomain(url);
  return '';
}

/** Trim + collapse-whitespace + ellipsize a free-text label. Mirrors the
 * private helper of the same name in `tool-meta.ts`/`derive-panels.ts`. */
function truncate(s: string, max = 60): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

function imageGenSentence(part: ToolPart): string {
  const action = rawInput(part).action as string | undefined;
  return (action && IMAGE_GEN_ACTION_SENTENCE[action]) || 'Worked on an image';
}

function presentationGenSentence(part: ToolPart): string {
  const action = rawInput(part).action as string | undefined;
  return (action && PRESENTATION_GEN_ACTION_SENTENCE[action]) || 'Worked on a presentation';
}

// ─── create, grouped (n > 1): same classify → allSame → specific-sentence
// pattern every other multiplexed family in this file already uses. `create`
// mixes three different media types (image/video/presentation) plus the
// non-multiplexed `show`/`show_user` display tools, so each part is first
// reduced to a `media:action` key. When every part in the group resolves to
// the *same* key, the group gets that key's own truthful, count-aware
// sentence (below). Otherwise the group is genuinely mixed — actions differ,
// or media types differ — and gets a vague-but-true sentence naming only
// what was touched, never what was done to it. A missing/unrecognized action
// always lands in that tool's own `unknown` key, never in `create`. ────────

type CreateMedia = 'image' | 'video' | 'presentation' | 'shown';

function createMediaOf(key: string): CreateMedia {
  return key.slice(0, key.indexOf(':')) as CreateMedia;
}

const IMAGE_GEN_ACTION_KEY: Record<string, string> = {
  generate: 'image:generate',
  edit: 'image:edit',
  upscale: 'image:upscale',
  remove_bg: 'image:remove_bg',
};

const PRESENTATION_GEN_ACTION_KEY: Record<string, string> = {
  create_slide: 'presentation:create_slide',
  list_slides: 'presentation:list_slides',
  list_presentations: 'presentation:list_presentations',
  delete_slide: 'presentation:delete_slide',
  delete_presentation: 'presentation:delete_presentation',
  validate_slide: 'presentation:validate_slide',
  export_pdf: 'presentation:export_pdf',
  export_pptx: 'presentation:export_pptx',
  preview: 'presentation:preview',
  serve: 'presentation:preview', // same component, same sentence
};

/** Classify one part into a `media:action` key. Every key this can return
 * has a matching entry in `CREATE_GROUP_SENTENCE` below. */
function createPartKey(part: ToolPart): string {
  const t = normalizeName(part.tool);
  if (t === 'image_gen') {
    const action = rawInput(part).action as string | undefined;
    return (action && IMAGE_GEN_ACTION_KEY[action]) || 'image:unknown';
  }
  if (t === 'video_gen') return 'video:create';
  if (t === 'presentation_gen') {
    const action = rawInput(part).action as string | undefined;
    return (action && PRESENTATION_GEN_ACTION_KEY[action]) || 'presentation:unknown';
  }
  // `show` / `show_user` never multiplex on an action, and any future tool
  // this file hasn't been told about yet falls here too — never a raw name.
  return 'shown:result';
}

// ─── Outputs: which create-family parts are something the agent actually
// MADE, versus one it merely inspected, exported again, or removed. Used by
// derive-panels.ts's `deriveOutputs` (the Easy-mode "Outputs" card) so that
// card can never disagree with what this file's own narration just said
// happened — a `delete_presentation` narrated above as a deletion must never
// also surface as "a presentation the agent made", and `list_presentations`
// (a pure read) is not an output at all. A missing/unrecognized action
// defaults to "yes, it's an artifact" — the same vague-but-true bias
// `imageGenSentence` / `presentationGenSentence` use for narration. ─────────

export type CreateArtifactKind = 'image' | 'video' | 'presentation';

/** presentation_gen actions that extend or export the deck itself. The other
 * six actions are pure reads (list_slides, list_presentations,
 * validate_slide, preview, serve) or destructive (delete_slide,
 * delete_presentation) — none of those produced anything the agent made. */
const PRESENTATION_GEN_ARTIFACT_ACTIONS = new Set(['create_slide', 'export_pdf', 'export_pptx']);

/**
 * The kind of artifact this call produced, or `null` if it did not make
 * anything worth surfacing in Outputs (a delete, a listing, a preview, …).
 *
 * `image_gen` has no pure-read action — generate/edit/upscale/remove_bg (and
 * a missing/unrecognized action) all leave behind a real image file the user
 * asked for and will want to open (see ImageGenTool, which renders a
 * resulting image for every one of these). Only the LABEL differs by action
 * (see `imageGenSentence` — calling an edit "Made an image" would be a lie);
 * the artifact itself must always surface here, or a user who asks to
 * edit/upscale/remove a background gets an empty Outputs card despite the
 * agent having actually produced something.
 */
export function createArtifactKind(part: ToolPart): CreateArtifactKind | null {
  const t = normalizeName(part.tool);
  if (t === 'image_gen') return 'image';
  if (t === 'video_gen') return 'video';
  if (t === 'presentation_gen') {
    const action = rawInput(part).action as string | undefined;
    if (!action) return 'presentation';
    return PRESENTATION_GEN_ARTIFACT_ACTIONS.has(action) ? 'presentation' : null;
  }
  // `show` / `show_user` display an existing result rather than make a new
  // artifact, and any future `create`-family tool this file hasn't been
  // taught about yet falls here too — never guess it made something.
  return null;
}

/** One truthful, count-aware sentence per key, used only when every part in
 * the group shares the exact same key (see `narrateStep`'s 'create' case). */
const CREATE_GROUP_SENTENCE: Record<string, (n: number) => string> = {
  'image:generate': (n) => `Made ${n} images`,
  'image:edit': (n) => `Edited ${n} images`,
  'image:upscale': (n) => `Upscaled ${n} images`,
  'image:remove_bg': (n) => `Removed backgrounds from ${n} images`,
  'image:unknown': (n) => `Worked on ${n} images`,
  'video:create': (n) => `Made ${n} videos`,
  'presentation:create_slide': (n) => `Added ${n} slides`,
  'presentation:delete_slide': (n) => `Deleted ${n} slides`,
  'presentation:delete_presentation': (n) => `Deleted ${n} presentations`,
  'presentation:list_slides': () => "Checked a presentation's slides",
  'presentation:list_presentations': () => 'Checked your presentations',
  'presentation:validate_slide': () => 'Checked slides',
  'presentation:export_pdf': (n) => `Exported ${n} presentations to PDF`,
  'presentation:export_pptx': (n) => `Exported ${n} presentations to PPTX`,
  'presentation:preview': (n) => `Previewed ${n} presentations`,
  'presentation:unknown': (n) => `Worked on ${n} presentations`,
  'shown:result': (n) => `Showed you ${n} results`,
};

const CREATE_MEDIA_NOUN: Record<CreateMedia, string> = {
  image: 'image',
  video: 'video',
  presentation: 'presentation',
  shown: 'result',
};

/** The group's actions (or its media types) genuinely differ — say only what
 * was touched, in neutral terms that hold no matter which specific action
 * each part turns out to be. Vague-but-true always beats specific-but-false. */
function mixedCreateSentence(keys: string[]): string {
  const counts: Record<CreateMedia, number> = { image: 0, video: 0, presentation: 0, shown: 0 };
  for (const key of keys) counts[createMediaOf(key)]++;
  const segments: string[] = [];
  (Object.keys(counts) as CreateMedia[]).forEach((media) => {
    const c = counts[media];
    if (c) segments.push(`${c} ${plural(c, CREATE_MEDIA_NOUN[media], `${CREATE_MEDIA_NOUN[media]}s`)}`);
  });
  return `Worked on ${joinWithAnd(segments)}`;
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
        // `show` / `show_user`, and any future create-family tool this file
        // hasn't been taught about yet — never route through the generic
        // `getToolPrimaryArg` fallback (it returns raw paths/URLs verbatim).
        const label = showLabel(p);
        return label ? `Showed you ${label}` : 'Showed you the result';
      }

      const keys = parts.map(createPartKey);
      if (allSame(keys)) return CREATE_GROUP_SENTENCE[keys[0]](n);
      return mixedCreateSentence(keys);
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
          case 'unknown':
            // An action neither this file nor the tool's own component
            // recognizes — never guess it's a harmless read.
            return 'Worked with your automations';
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
    case 'other': {
      if (n === 1) return `Used ${humanizeToolName(parts[0].tool)}`;
      // Never inspect only parts[0] — a mixed group of unrecognized/MCP tools
      // must name every distinct one, not silently drop the rest.
      const names = Array.from(new Set(parts.map((p) => humanizeToolName(p.tool))));
      if (names.length === 1) return `Used ${names[0]} · ${n} times`;
      return `Used ${joinWithAnd(names)}`;
    }
  }
}
