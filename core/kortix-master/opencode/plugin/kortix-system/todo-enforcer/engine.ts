/**
 * Passive continuation engine for unfinished todo-tracked work.
 */

import type { Todo } from "@opencode-ai/sdk"
import type { ContinuationConfig, ContinuationState } from "./config"
import {
	TODO_ENFORCER_INTERNAL_MARKER,
	TODO_ENFORCER_SYSTEM_TAG,
	TODO_ENFORCER_TODOS_TAG,
} from "./config"
import { evaluateTodos, type TodoEnforcerResult } from "../lib/todo-enforcer"

export type ContinuationAction = "continue" | "stop"

export interface ContinuationDecision {
	action: ContinuationAction
	prompt: string | null
	reason: string
	signals: {
		todo?: TodoEnforcerResult
		safetyCheck?: string
	}
}

function wrapSystem(body: string, attrs: Record<string, string>): string {
	const attrString = Object.entries(attrs)
		.map(([key, value]) => `${key}="${value}"`)
		.join(" ")
	return `<${TODO_ENFORCER_SYSTEM_TAG}${attrString ? " " + attrString : ""}>\n${body}\n</${TODO_ENFORCER_SYSTEM_TAG}>`
}

function todosBlock(todoResult: TodoEnforcerResult): string {
	const items = todoResult.remainingItems.map((item) => {
		const priority = item.priority === "high" ? ' priority="high"' : ""
		return `  <todo status="${item.status}"${priority}>${item.content}</todo>`
	})
	return [
		`<${TODO_ENFORCER_TODOS_TAG} completed="${todoResult.completedItems}" total="${todoResult.totalItems}">`,
		...items,
		`</${TODO_ENFORCER_TODOS_TAG}>`,
	].join("\n")
}

function checkSafetyLimits(config: ContinuationConfig, state: ContinuationState): string | null {
	const now = Date.now()

	if (state.totalSessionContinuations >= config.thresholds.maxSessionContinuations) {
		return `max session continuations reached (${config.thresholds.maxSessionContinuations})`
	}
	if (state.workCycleStartedAt > 0 && now - state.workCycleStartedAt < config.thresholds.minWorkDurationMs) {
		return `min work duration not met (${config.thresholds.minWorkDurationMs}ms)`
	}
	if (state.consecutiveAborts >= config.thresholds.maxConsecutiveAborts) {
		return `circuit breaker: ${state.consecutiveAborts} consecutive aborts/empty responses — stopping passive continuation`
	}
	if (state.lastContinuationAt > 0) {
		const elapsed = now - state.lastContinuationAt
		if (elapsed < config.thresholds.passiveCooldownMs) {
			return `passive cooldown: ${Math.round((config.thresholds.passiveCooldownMs - elapsed) / 1000)}s remaining`
		}
	}
	if (state.lastAbortAt > 0) {
		const timeSinceAbort = now - state.lastAbortAt
		if (timeSinceAbort < config.thresholds.abortGracePeriodMs) {
			return `abort grace period: ${Math.round((config.thresholds.abortGracePeriodMs - timeSinceAbort) / 1000)}s remaining`
		}
	}
	if (state.inflight) {
		return "continuation already in-flight — skipping to prevent double-fire"
	}

	return null
}

function buildContinuationPrompt(todoResult: TodoEnforcerResult, state: ContinuationState): string {
	const body = [
		`You are in the Kortix native-todo continuation loop. Continuation ${state.totalSessionContinuations + 1}.`,
		"",
		"Keep working until the native OpenCode todo list is truly finished. Do real work this turn — no restating, no fake completion, no stopping early.",
		"",
		"Native todo state driving this continuation:",
		todosBlock(todoResult),
		"",
		"Rules:",
		"- Pick up the next pending/in_progress native todo item and move it forward.",
		"- Update the native todo list honestly as work changes state.",
		"- Do not stop while any real work item remains pending or in_progress.",
		"- If every remaining native todo is genuinely blocked on user/external input, leave those todos explicitly blocked in content and report the blocker clearly.",
		"- Do not re-explain completed work unless it is necessary to unblock the next step.",
		"",
		TODO_ENFORCER_INTERNAL_MARKER,
	].join("\n")
	return wrapSystem(body, {
		phase: "continue",
		completed: `${todoResult.completedItems}`,
		total: `${todoResult.totalItems}`,
	})
}

export function evaluate(
	config: ContinuationConfig,
	state: ContinuationState,
	lastAssistantText: string,
	hadToolCalls: boolean,
	todos: Todo[],
): ContinuationDecision {
	if (!config.features.continuation) {
		return { action: "stop", prompt: null, reason: "continuation disabled", signals: {} }
	}

	if (!lastAssistantText.trim() && !hadToolCalls) {
		return {
			action: "stop",
			prompt: null,
			reason: "empty/aborted assistant response — skipping continuation",
			signals: { safetyCheck: "empty_response" },
		}
	}

	const safetyViolation = checkSafetyLimits(config, state)
	if (safetyViolation) {
		return {
			action: "stop",
			prompt: null,
			reason: `safety: ${safetyViolation}`,
			signals: { safetyCheck: safetyViolation },
		}
	}

	if (!config.features.todoEnforcer) {
		return { action: "stop", prompt: null, reason: "todo enforcer disabled", signals: {} }
	}

	const todoResult = evaluateTodos(todos)
	if (todoResult.verdict === "done" || todoResult.verdict === "blocked") {
		return {
			action: "stop",
			prompt: null,
			reason: `todos: ${todoResult.reason}`,
			signals: { todo: todoResult },
		}
	}

	return {
		action: "continue",
		prompt: buildContinuationPrompt(todoResult, state),
		reason: `todos: ${todoResult.reason}`,
		signals: { todo: todoResult },
	}
}
