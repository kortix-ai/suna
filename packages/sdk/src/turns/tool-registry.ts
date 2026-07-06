/**
 * Tool name -> {label, category} registry — pure data, zero React/icon deps.
 * Hosts map `category` to their own icon set; `getToolInfo` (index.ts) already
 * covers icon+title+subtitle for the existing tool-card UI, this is a leaner,
 * icon-free sibling for hosts that just need "what kind of tool is this" (e.g.
 * `classifyPart`'s `ToolView`, filtering/grouping steps by category).
 *
 * Canonical opencode built-in tool names (bash, read, write, edit, grep, glob,
 * webfetch, task, todowrite, question, patch, list, …) get a hand-picked
 * label. Kortix's plugin tool families (agent_*, session_*, task_*, trigger_*,
 * project_*, pty_*, and their `-`/`oc-` variants) are recognized by prefix so
 * new tools in an existing family are categorized correctly without a
 * registry update. Anything else falls back to a humanized version of the
 * raw name with category 'other'.
 */

export type ToolCategory = 'shell' | 'files' | 'search' | 'edit' | 'web' | 'task' | 'other';

export interface ToolInfoEntry {
  label: string;
  category: ToolCategory;
}

/** Registry keyed by the tool's normalized (underscore, no `oc_` prefix) name. */
const TOOL_REGISTRY: Record<string, ToolInfoEntry> = {
  // Shell / terminal
  bash: { label: 'Shell', category: 'shell' },
  pty_spawn: { label: 'Spawn Terminal', category: 'shell' },
  pty_read: { label: 'Terminal Output', category: 'shell' },
  pty_write: { label: 'Terminal Input', category: 'shell' },
  pty_input: { label: 'Terminal Input', category: 'shell' },
  pty_kill: { label: 'Kill Process', category: 'shell' },

  // Read-only file access
  read: { label: 'Read File', category: 'files' },
  list: { label: 'List Directory', category: 'files' },
  ls: { label: 'List Directory', category: 'files' },

  // Mutating file operations
  write: { label: 'Write File', category: 'edit' },
  edit: { label: 'Edit File', category: 'edit' },
  multiedit: { label: 'Edit File', category: 'edit' },
  morph_edit: { label: 'Edit File', category: 'edit' },
  apply_patch: { label: 'Apply Patch', category: 'edit' },
  patch: { label: 'Apply Patch', category: 'edit' },

  // Search
  grep: { label: 'Search Code', category: 'search' },
  glob: { label: 'Find Files', category: 'search' },
  image_search: { label: 'Image Search', category: 'search' },
  session_search: { label: 'Search Sessions', category: 'search' },

  // Web
  webfetch: { label: 'Fetch Page', category: 'web' },
  scrape_webpage: { label: 'Scrape Page', category: 'web' },
  websearch: { label: 'Web Search', category: 'web' },
  web_search: { label: 'Web Search', category: 'web' },
  image_gen: { label: 'Generate Image', category: 'web' },
  video_gen: { label: 'Generate Video', category: 'web' },

  // Task / agent orchestration + planning
  task: { label: 'Delegate to Agent', category: 'task' },
  todowrite: { label: 'Plan Tasks', category: 'task' },
  todoread: { label: 'Read Plan', category: 'task' },
  question: { label: 'Ask Question', category: 'task' },
  presentation_gen: { label: 'Presentation', category: 'task' },
  show: { label: 'Show Output', category: 'task' },
  show_user: { label: 'Show Output', category: 'task' },

  // DCP / context management
  prune: { label: 'Prune Context', category: 'other' },
  distill: { label: 'Distill Context', category: 'other' },
  compress: { label: 'Compress Context', category: 'other' },
  context_info: { label: 'Context Info', category: 'other' },
};

/** Tool-name-family prefixes that should categorize even when the exact tool
 *  isn't in TOOL_REGISTRY (forward-compat for new tools in an existing
 *  family, e.g. a new `agent_*` or `trigger_*` tool). Checked in order. */
const PREFIX_CATEGORIES: Array<{ prefix: string; category: ToolCategory }> = [
  { prefix: 'pty_', category: 'shell' },
  { prefix: 'agent_', category: 'task' },
  { prefix: 'session_', category: 'task' },
  { prefix: 'task_', category: 'task' },
  { prefix: 'trigger_', category: 'task' },
  { prefix: 'project_', category: 'task' },
];

function stripOcPrefix(name: string): string {
  return name.replace(/^oc[-_]/, '');
}

/** Normalize a tool name to the registry's canonical (underscore) key form.
 *  Exported for other turns/ modules (e.g. `view-model.ts`'s per-tool
 *  dispatch) that need the same `oc-`/dash normalization `toolInfo` uses. */
export function normalizeToolName(name: string): string {
  return stripOcPrefix(name).replace(/-/g, '_');
}

/** Turn a raw/normalized tool name into a human label, e.g. `session_spawn` -> "Session Spawn". */
export function humanizeToolName(name: string): string {
  const normalized = normalizeToolName(name);
  return normalized
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Look up display info for a tool name. Never throws, always returns a
 * usable label — unknown tools humanize their raw name with category
 * 'other' (or a family category, if the name matches a known prefix).
 */
export function toolInfo(name: string): ToolInfoEntry {
  const normalized = normalizeToolName(name);
  const known = TOOL_REGISTRY[normalized];
  if (known) return known;

  for (const { prefix, category } of PREFIX_CATEGORIES) {
    if (normalized.startsWith(prefix)) {
      return { label: humanizeToolName(name), category };
    }
  }

  return { label: humanizeToolName(name), category: 'other' };
}
