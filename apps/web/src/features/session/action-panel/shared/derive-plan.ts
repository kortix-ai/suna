/**
 * The agent's PLAN — not its log.
 *
 * Progress used to be a transcript of tool calls: "Recalled what you told it
 * before", "Searched and read 6 sources", "Ran a command". That is an audit
 * trail. It restates the chat in worse words, it is unbounded (a long run makes
 * a thousand rows), and none of it answers the only question a non-technical
 * user has: *how far along is this?*
 *
 * The agent already answers that itself. `todo_write` is the plan it wrote in
 * its own words — "Create the CSV. Build the workbook. Export the PDF." Six
 * items, not six hundred, and each one is a thing a person actually asked for.
 * So Progress shows the plan and its state, and the tool calls go where they
 * belong: Advanced mode.
 *
 * `todo_write` re-sends the WHOLE checklist on every call, so the latest call is
 * the only true one — see `collapseSnapshots`, which fixed the same bug in the
 * detail view when three snapshots rendered as three separate to-do lists.
 */

import type { ToolPart } from '@/ui';
import { parseTodos, type TodoItem } from '../../tool/shared/todo-helpers';
import { normalizeName } from '../../tool/tool-meta';

function isTodoTool(tool: string): boolean {
  const n = normalizeName(tool);
  return n === 'todo_write' || n === 'todowrite';
}

/**
 * `todos` arrives as an array OR a JSON string, exactly like `show`'s `items` —
 * the model serializes it and nothing normalizes it on the way in. An
 * `Array.isArray` check alone sees a string and silently reports "no plan",
 * which would empty this card on every run that has one.
 */
function readTodos(value: unknown): TodoItem[] {
  if (typeof value === 'string') {
    try {
      return parseTodos(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return parseTodos(value);
}

/** The agent's current plan, or an empty list if it never made one. */
export function derivePlan(parts: ToolPart[]): TodoItem[] {
  // Walk backwards: the last checklist the agent wrote is the only one still
  // true. Earlier snapshots are superseded, not additional.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!isTodoTool(part.tool)) continue;

    const state = (part.state ?? {}) as {
      input?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };

    // Input first (what the agent asked for), then metadata (what the backend
    // echoed back) — the same order the todo tool's own view resolves them in.
    const todos = readTodos(state.input?.todos);
    if (todos.length > 0) return todos;

    const fromMetadata = readTodos(state.metadata?.todos);
    if (fromMetadata.length > 0) return fromMetadata;
  }

  return [];
}

export interface PlanProgress {
  done: number;
  total: number;
  /** The task the agent is on right now, if it has said which. */
  current?: TodoItem;
}

/** Cancelled tasks still count as settled — the agent is not going back to them. */
export function planProgress(todos: TodoItem[]): PlanProgress {
  const done = todos.filter((t) => t.status === 'completed' || t.status === 'cancelled').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return { done, total: todos.length, current };
}
