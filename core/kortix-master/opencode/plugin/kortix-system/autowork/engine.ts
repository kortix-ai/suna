/**
 * Autowork engine — pure loop enforcer.
 *
 * Per iteration the engine does exactly one thing:
 * 1. Scan recent assistant text for a well-formed <kortix_autowork_complete> tag.
 * 2. If present and valid → STOP "complete".
 * 3. If present but malformed → continue with a structured rejection prompt.
 * 4. If absent → continue with the standard continuation prompt.
 *
 * No verification phase, no todo-list dependency, no premature-completion gate.
 * The completion tag IS the structured contract, and re-injecting the original
 * request on every turn is the anti-drift mechanism.
 */

import {
	COMPLETION_TAG,
	REQUEST_TAG,
	SYSTEM_WRAPPER_TAG,
	parseCompletionTag,
	validateCompletion,
	type AutoworkState,
} from "./config"

export type AutoworkAction = "continue" | "stop"

export type AutoworkStopReason = "complete" | "failed" | "cancelled"

export interface AutoworkDecision {
	action: AutoworkAction
	prompt: string | null
	reason: string
	stopReason?: AutoworkStopReason
}

function wrapSystem(body: string, attrs: Record<string, string>): string {
	const attrString = Object.entries(attrs)
		.map(([k, v]) => `${k}="${v}"`)
		.join(" ")
	return `<${SYSTEM_WRAPPER_TAG}${attrString ? " " + attrString : ""}>\n${body}\n</${SYSTEM_WRAPPER_TAG}>`
}

function requestBlock(state: AutoworkState): string {
	const request = state.taskPrompt?.trim() || "(no task prompt recorded)"
	return `<${REQUEST_TAG}>\n${request}\n</${REQUEST_TAG}>`
}

function completionTemplate(): string {
	return [
		`<${COMPLETION_TAG}>`,
		`  <verification>`,
		`    [Concrete evidence — the exact commands you ran, their exit codes, the outputs that prove the task works. Not "should work." Reproducible.]`,
		`  </verification>`,
		`  <requirements_check>`,
		`    - [x] "exact user requirement 1" — how it was satisfied + proof (file path / command output / test id)`,
		`    - [x] "exact user requirement 2" — how it was satisfied + proof`,
		`  </requirements_check>`,
		`</${COMPLETION_TAG}>`,
	].join("\n")
}

function buildContinuePrompt(state: AutoworkState): string {
	const body = [
		`You are in the Kortix autowork loop. Iteration ${state.iteration + 1}/${state.maxIterations}.`,
		"",
		"Keep working on the task until it is truly complete, deterministically verified, and every single requirement from the user has been satisfied with concrete proof.",
		"",
		"**The user's full request (re-anchored every iteration):**",
		requestBlock(state),
		"",
		"Rules:",
		"- Do real work this turn. No restatement, no planning-in-place, no hedging. Move the work forward.",
		"- Read files before editing. Run tests before claiming success.",
		"- If an approach fails, diagnose the root cause and try a focused fix.",
		"- If you are blocked on missing external input, state exactly what is blocked and why — then stop.",
		"",
		`When — and only when — the task is 100% done, deterministically verified, and every user requirement is satisfied, emit the completion contract on its own in your next message:`,
		"",
		completionTemplate(),
		"",
		"The autowork plugin parses this tag strictly. Both children are required. Every `requirements_check` item must be `- [x]` with concrete evidence. Malformed, empty, or unchecked → the plugin rejects it and the loop continues.",
	].join("\n")
	return wrapSystem(body, {
		phase: "continue",
		iteration: `${state.iteration + 1}/${state.maxIterations}`,
	})
}

function buildRejectionPrompt(state: AutoworkState, reason: string, details: string): string {
	const body = [
		`Your <${COMPLETION_TAG}> tag was **REJECTED**.`,
		"",
		`**Reason:** ${reason}`,
		"",
		`**Details:**`,
		details,
		"",
		"Keep working. Do not emit the completion tag again until:",
		"- `<verification>` contains the actual commands you ran and their real output (not descriptions).",
		"- `<requirements_check>` lists EVERY user requirement as `- [x] \"requirement\" — evidence` with concrete proof.",
		"",
		"**The user's full request (re-anchored):**",
		requestBlock(state),
		"",
		"When you are ready to try again, emit:",
		"",
		completionTemplate(),
	].join("\n")
	return wrapSystem(body, {
		phase: "rejected",
		iteration: `${state.iteration + 1}/${state.maxIterations}`,
	})
}

export function evaluateAutowork(state: AutoworkState, assistantTexts: string[]): AutoworkDecision {
	if (!state.active) {
		return { action: "stop", prompt: null, reason: "inactive", stopReason: "cancelled" }
	}
	if (state.iteration >= state.maxIterations) {
		return {
			action: "stop",
			prompt: null,
			reason: `max iterations reached (${state.maxIterations})`,
			stopReason: "failed",
		}
	}

	// Scan assistant texts newest-first for a completion tag.
	let parsed = null
	for (let i = assistantTexts.length - 1; i >= 0; i--) {
		const candidate = parseCompletionTag(assistantTexts[i] ?? "")
		if (candidate) {
			parsed = candidate
			break
		}
	}

	if (parsed) {
		const validation = validateCompletion(parsed)
		if (validation.ok) {
			return {
				action: "stop",
				prompt: null,
				reason: "completion tag validated",
				stopReason: "complete",
			}
		}
		return {
			action: "continue",
			prompt: buildRejectionPrompt(state, validation.reason, validation.details),
			reason: `completion rejected: ${validation.reason}`,
		}
	}

	return {
		action: "continue",
		prompt: buildContinuePrompt(state),
		reason: `iteration ${state.iteration + 1}/${state.maxIterations}`,
	}
}

export function checkAutoworkSafetyGates(
	state: AutoworkState,
	abortGracePeriodMs: number,
	maxConsecutiveFailures: number,
	failureResetWindowMs: number,
	baseCooldownMs: number,
): string | null {
	if (state.stopped) return "continuation stopped — use /autowork to restart"
	if (state.lastAbortAt > 0) {
		const timeSinceAbort = Date.now() - state.lastAbortAt
		if (timeSinceAbort < abortGracePeriodMs) {
			return `abort grace period: ${Math.round((abortGracePeriodMs - timeSinceAbort) / 1000)}s remaining`
		}
	}
	if (state.consecutiveFailures >= maxConsecutiveFailures) {
		if (state.lastFailureAt > 0 && Date.now() - state.lastFailureAt >= failureResetWindowMs) {
			return "__reset_failures__"
		}
		return `max consecutive failures (${state.consecutiveFailures}) — pausing for ${Math.round(failureResetWindowMs / 60000)} min`
	}
	if (state.lastInjectedAt > 0 && state.consecutiveFailures > 0) {
		const effectiveCooldown = baseCooldownMs * Math.pow(2, Math.min(state.consecutiveFailures, 5))
		const elapsed = Date.now() - state.lastInjectedAt
		if (elapsed < effectiveCooldown) {
			return `backoff cooldown: ${Math.round((effectiveCooldown - elapsed) / 1000)}s remaining (failure ${state.consecutiveFailures})`
		}
	}
	if (state.lastInjectedAt > 0 && state.consecutiveFailures === 0) {
		const elapsed = Date.now() - state.lastInjectedAt
		if (elapsed < baseCooldownMs) {
			return `minimum cooldown: ${Math.round((baseCooldownMs - elapsed) / 1000)}s remaining`
		}
	}
	return null
}
