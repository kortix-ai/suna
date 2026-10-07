/**
 * Tool name -> {label, category} registry — pure data, zero React/icon deps.
 * Hosts map `category` to their own icon set; `getToolInfo` (index.ts) already
 * covers icon+title+subtitle for the existing tool-card UI, this is a leaner,
 * icon-free sibling for hosts that just need "what kind of tool is this" (e.g.
 * `classifyPart`'s `ToolView`, filtering/grouping steps by category).
 *
 * Built-in tool names (bash, read, write, edit, grep, glob, webfetch, task,
 * todowrite, question, patch, list, …) get a hand-picked label. The category
 * comes from the tool's kind (`toolKind`), which also recognizes the plugin
 * families (agent_*, session_*, task_*, trigger_*, project_*, pty_*) by
 * prefix. Anything else falls back to a humanized version of the raw name
 * with category 'other'.
 */

import { type ToolKind, toolKind } from './tool-kind';

export type ToolCategory = 'shell' | 'files' | 'search' | 'edit' | 'web' | 'task' | 'other';

export interface ToolInfoEntry {
  label: string;
  category: ToolCategory;
}

/** Hand-picked labels, keyed by the tool's normalized (underscore, no `oc_` prefix) name. */
const TOOL_LABEL: Record<string, string> = {
  bash: 'Shell',
  pty_spawn: 'Spawn Terminal',
  pty_read: 'Terminal Output',
  pty_write: 'Terminal Input',
  pty_input: 'Terminal Input',
  pty_kill: 'Kill Process',
  read: 'Read File',
  list: 'List Directory',
  ls: 'List Directory',
  write: 'Write File',
  edit: 'Edit File',
  multiedit: 'Edit File',
  morph_edit: 'Edit File',
  apply_patch: 'Apply Patch',
  patch: 'Apply Patch',
  grep: 'Search Code',
  glob: 'Find Files',
  image_search: 'Image Search',
  session_search: 'Search Sessions',
  webfetch: 'Fetch Page',
  scrape_webpage: 'Scrape Page',
  websearch: 'Web Search',
  web_search: 'Web Search',
  image_gen: 'Generate Image',
  video_gen: 'Generate Video',
  task: 'Delegate to Agent',
  todowrite: 'Plan Tasks',
  todoread: 'Read Plan',
  question: 'Ask Question',
  presentation_gen: 'Presentation',
  show: 'Show Output',
  show_user: 'Show Output',
  prune: 'Prune Context',
  distill: 'Distill Context',
  compress: 'Compress Context',
  context_info: 'Context Info',
};

/** The category of each tool kind (`toolKind`). */
const CATEGORY_OF_KIND: Record<ToolKind, ToolCategory> = {
  read: 'files',
  list: 'files',
  glob: 'search',
  grep: 'search',
  write: 'edit',
  edit: 'edit',
  apply_patch: 'edit',
  bash: 'shell',
  pty: 'shell',
  web_search: 'web',
  webfetch: 'web',
  media: 'web',
  show: 'task',
  task: 'task',
  delegate: 'task',
  sessions: 'task',
  todowrite: 'task',
  question: 'task',
  automations: 'task',
  projects: 'task',
  memory: 'other',
  connectors: 'other',
  skill: 'other',
  context: 'other',
  retired: 'other',
  other: 'other',
};

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
  return {
    label: TOOL_LABEL[normalizeToolName(name)] ?? humanizeToolName(name),
    category: CATEGORY_OF_KIND[toolKind(name)],
  };
}
