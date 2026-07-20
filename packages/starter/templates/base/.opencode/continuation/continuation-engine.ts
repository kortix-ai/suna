/**
 * Continuation Engine — session.idle evaluator
 *
 * Combines signals from IntentGate and TodoEnforcer to decide whether to inject
 * a continuation prompt when the session goes idle. Pure function — no I/O, no
 * LLM calls — so it is fully unit-testable.
 *
 * Decision flow:
 *   1. Feature check — continuation must be enabled
 *   2. Empty/aborted response → stop (don't loop on a crash)
 *   3. Safety limits — per-request cap, min work duration, abort circuit breaker, cooldown
 *   4. IntentGate — classify last assistant message (stop on completed/blocked/answer)
 *   5. TodoEnforcer — continue while native todos remain unfinished
 *   6. Default → stop (conservative)
 */

import type { Todo } from "@opencode-ai/sdk"
import { type ContinuationConfig, type ContinuationState, INTERNAL_MARKER } from "./config"
import { classifyIntent, type IntentResult } from "./intent-gate"
import { evaluateTodos, formatRemainingWork, type TodoEnforcerResult } from "./todo-enforcer"

// ─── Decision Types ───────────────────────────────────────────────────────────

export type ContinuationAction = "continue" | "stop"

export interface ContinuationDecision {
	action: ContinuationAction
	/** The prompt to inject if action === "continue" */
	prompt: string | null
	/** Human-readable reason for the decision (logged, not sent to model) */
	reason: string
	/** Signal sources that informed the decision */
	signals: {
		intent?: IntentResult
		todo?: TodoEnforcerResult
		safetyCheck?: string
	}
}

// ─── Safety Checks ────────────────────────────────────────────────────────────

function checkSafetyLimits(config: ContinuationConfig, state: ContinuationState): string | null {
	const now = Date.now()

	// Per-request limit
	if (state.totalSessionContinuations >= config.thresholds.maxSessionContinuations) {
		return `max continuations reached (${config.thresholds.maxSessionContinuations})`
	}

	// Min work duration (don't continue if the agent barely started)
	if (state.workCycleStartedAt > 0 && now - state.workCycleStartedAt < config.thresholds.minWorkDurationMs) {
		return `min work duration not met (${config.thresholds.minWorkDurationMs}ms)`
	}

	// Circuit breaker: too many consecutive aborts/empty responses
	if (state.consecutiveAborts >= config.thresholds.maxConsecutiveAborts) {
		return `circuit breaker: ${state.consecutiveAborts} consecutive aborts/empty responses`
	}

	// Cooldown: minimum time between continuation attempts
	if (state.lastContinuationAt > 0) {
		const elapsed = now - state.lastContinuationAt
		if (elapsed < config.thresholds.passiveCooldownMs) {
			return `cooldown: ${Math.round((config.thresholds.passiveCooldownMs - elapsed) / 1000)}s remaining`
		}
	}

	// Abort grace period: skip continuation shortly after an abort/error
	if (state.lastAbortAt > 0) {
		const timeSinceAbort = now - state.lastAbortAt
		if (timeSinceAbort < config.thresholds.abortGracePeriodMs) {
			return `abort grace period: ${Math.round((config.thresholds.abortGracePeriodMs - timeSinceAbort) / 1000)}s remaining`
		}
	}

	// In-flight guard: prevent double-fire race condition
	if (state.inflight) {
		return "continuation already in-flight — skipping to prevent double-fire"
	}

	return null
}

// ─── Continuation Prompt Builder ─────────────────────────────────────────────

function buildContinuationPrompt(todoResult: TodoEnforcerResult | null, state: ContinuationState): string {
	const parts: string[] = []

	parts.push("[SYSTEM REMINDER - TODO CONTINUATION]")
	parts.push("You have unfinished work. Continue from where you left off — do not stop.")
	parts.push(`Continuations so far this request: ${state.totalSessionContinuations}.`)

	if (todoResult && todoResult.remainingItems.length > 0) {
		parts.push("")
		parts.push(formatRemainingWork(todoResult))
	}

	parts.push("")
	parts.push(
		"Pick up the next pending/in-progress item and keep working until every todo is completed or genuinely blocked. Do not re-explain what was already done. If you are truly blocked on the user or an external dependency, state the blocker explicitly and ask.",
	)
	parts.push(INTERNAL_MARKER)

	return parts.join("\n")
}

// ─── Main Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate whether a session should continue after going idle.
 *
 * Open todos are AUTHORITATIVE: if tracked work remains, we continue — even if
 * the agent's final message was empty, a short note, or a premature "all done"
 * claim. This is the whole point of the enforcer: never self-stop mid-task.
 *
 * The only things that override open todos are (in order): the safety breakers,
 * a real pending-question tool (handled by the plugin before this runs), and a
 * hard external blocker (missing credentials / unreachable dependency) where the
 * agent genuinely cannot proceed. Rhetorical "should I...?" text does NOT stop a
 * session with open work — the agent must escalate via the question tool, which
 * the plugin detects reliably.
 */
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

	// Safety breakers first: per-request cap, min work duration, abort circuit
	// breaker (bounds looping on repeated empty/crashed turns), cooldown, in-flight.
	const safetyViolation = checkSafetyLimits(config, state)
	if (safetyViolation) {
		return { action: "stop", prompt: null, reason: `safety: ${safetyViolation}`, signals: { safetyCheck: safetyViolation } }
	}

	// A genuine external blocker (missing API key/credentials, unreachable service)
	// means the agent cannot proceed regardless of open todos — stop and report.
	let intentResult: IntentResult | undefined
	if (config.features.intentGate) {
		intentResult = classifyIntent(lastAssistantText, hadToolCalls, todos)
		if (intentResult.intent === "blocked-external") {
			return { action: "stop", prompt: null, reason: "intent: blocked on external dependency", signals: { intent: intentResult } }
		}
	}

	// Todos are authoritative.
	if (config.features.todoEnforcer) {
		const todoResult = evaluateTodos(todos)
		if (todoResult.verdict === "unfinished") {
			return {
				action: "continue",
				prompt: buildContinuationPrompt(todoResult, state),
				reason: `todos: ${todoResult.reason}`,
				signals: { intent: intentResult, todo: todoResult },
			}
		}
		// "done" (incl. no tracked work) or "blocked" (all remaining items await
		// an external condition) → stop. Nothing for the enforcer to drive.
		return { action: "stop", prompt: null, reason: `todos: ${todoResult.reason}`, signals: { intent: intentResult, todo: todoResult } }
	}

	return { action: "stop", prompt: null, reason: "todo enforcer disabled", signals: { intent: intentResult } }
}
