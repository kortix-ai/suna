/**
 * Todo Enforcer — detect unfinished tracked work.
 *
 * Evaluates the native OpenCode todo list and decides whether there is
 * unfinished work that should block a session from idling out.
 */

import type { Todo } from "@opencode-ai/sdk"

export type TodoVerdict = "done" | "unfinished" | "blocked"

export interface TodoEnforcerResult {
	verdict: TodoVerdict
	reason: string
	remainingItems: Todo[]
	totalItems: number
	completedItems: number
}

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
	return BLOCKED_KEYWORDS.some((keyword) => new RegExp(keyword, "i").test(text))
}

export function evaluateTodos(todos: Todo[]): TodoEnforcerResult {
	if (!todos || todos.length === 0) {
		return {
			verdict: "done",
			reason: "no tracked work",
			remainingItems: [],
			totalItems: 0,
			completedItems: 0,
		}
	}

	const completed = todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled")
	const remaining = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress")

	if (remaining.length === 0) {
		return {
			verdict: "done",
			reason: `all ${todos.length} items completed`,
			remainingItems: [],
			totalItems: todos.length,
			completedItems: completed.length,
		}
	}

	const blockedItems = remaining.filter(looksBlocked)
	if (blockedItems.length > 0 && blockedItems.length === remaining.length) {
		return {
			verdict: "blocked",
			reason: `${remaining.length} item(s) appear blocked`,
			remainingItems: remaining,
			totalItems: todos.length,
			completedItems: completed.length,
		}
	}

	const inProgress = remaining.filter((todo) => todo.status === "in_progress")
	const pending = remaining.filter((todo) => todo.status === "pending")
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
