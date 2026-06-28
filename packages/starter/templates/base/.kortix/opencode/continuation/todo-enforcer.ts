/**
 * Todo Enforcer — Detect unfinished tracked work
 *
 * Inspects the session's todo list (via client.session.todo()) and determines
 * whether there's unfinished work that should prevent the session from stopping.
 *
 * Three outcomes:
 *   - "done"       → All tracked work is complete or cancelled
 *   - "unfinished" → There are pending/in-progress items → should continue
 *   - "blocked"    → Work exists but appears blocked → should stop and report
 */

import type { Todo } from "@opencode-ai/sdk"

// ─── Types ───────────────────────────────────────────────────────────────────

export type TodoVerdict = "done" | "unfinished" | "blocked"

export interface TodoEnforcerResult {
	verdict: TodoVerdict
	reason: string
	/** Pending/in-progress items (for the continuation prompt) */
	remainingItems: Todo[]
	/** Total items in the todo list */
	totalItems: number
	/** Completed items */
	completedItems: number
}

// ─── Blocked detection ───────────────────────────────────────────────────────

// Heuristic: if a todo item's content mentions these, it's likely blocked
const BLOCKED_KEYWORDS = [
	"waiting",
	"blocked",
	"need.*from",
	"depends on",
	"after.*approval",
	"pending.*review",
	"requires.*access",
	"missing.*credentials",
]

function looksBlocked(todo: Todo): boolean {
	const text = todo.content.toLowerCase()
	return BLOCKED_KEYWORDS.some((kw) => new RegExp(kw, "i").test(text))
}

// ─── Enforcer ────────────────────────────────────────────────────────────────

/**
 * Evaluate a session's todo list to determine if work is complete.
 *
 * @param todos - The session's current todo list
 * @returns Verdict with remaining items and counts
 */
export function evaluateTodos(todos: Todo[]): TodoEnforcerResult {
	// No todos at all — can't enforce, treat as done
	if (!todos || todos.length === 0) {
		return {
			verdict: "done",
			reason: "no tracked work",
			remainingItems: [],
			totalItems: 0,
			completedItems: 0,
		}
	}

	const completed = todos.filter((t) => t.status === "completed" || t.status === "cancelled")
	const remaining = todos.filter((t) => t.status === "pending" || t.status === "in_progress")

	// All done
	if (remaining.length === 0) {
		return {
			verdict: "done",
			reason: `all ${todos.length} items completed`,
			remainingItems: [],
			totalItems: todos.length,
			completedItems: completed.length,
		}
	}

	// Check if remaining items look blocked
	const blockedItems = remaining.filter(looksBlocked)
	if (blockedItems.length > 0 && blockedItems.length === remaining.length) {
		// ALL remaining items look blocked — don't continue
		return {
			verdict: "blocked",
			reason: `${remaining.length} item(s) appear blocked`,
			remainingItems: remaining,
			totalItems: todos.length,
			completedItems: completed.length,
		}
	}

	// Unfinished work — should continue
	const inProgress = remaining.filter((t) => t.status === "in_progress")
	const pending = remaining.filter((t) => t.status === "pending")

	const parts: string[] = []
	if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`)
	if (pending.length > 0) parts.push(`${pending.length} pending`)

	return {
		verdict: "unfinished",
		reason: `${remaining.length} remaining (${parts.join(", ")}) of ${todos.length} total`,
		remainingItems: remaining,
		totalItems: todos.length,
		completedItems: completed.length,
	}
}

/**
 * Build a concise reminder of remaining work for the continuation prompt.
 */
export function formatRemainingWork(result: TodoEnforcerResult): string {
	if (result.remainingItems.length === 0) return ""

	const lines = [`[TODO ENFORCER] ${result.completedItems}/${result.totalItems} complete. Remaining:`]
	for (const item of result.remainingItems) {
		const status = item.status === "in_progress" ? "🔄" : "⬜"
		const priority = item.priority === "high" ? " ❗" : ""
		lines.push(`  ${status} ${item.content}${priority}`)
	}
	return lines.join("\n")
}
