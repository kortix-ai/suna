/**
 * Autowork engine — pure loop enforcer.
 *
 * Phases:
 * 1. planning   — define status quo, target end state, ambiguity resolution,
 *                 work plan, and verification gates.
 * 2. execution  — do the work until a completion candidate is proven.
 * 3. verifying  — mandatory final audit pass before clean stop.
 */

import {
	COMPLETION_TAG,
	PLAN_TAG,
	REQUEST_TAG,
	SYSTEM_WRAPPER_TAG,
	VERIFIED_TAG,
	extractVerificationCommands,
	normalizeComparableText,
	normalizeShellCommand,
	parsePlanTag,
	planCommandGates,
	planObserveGates,
	renderApprovedPlan,
	validateCompletion,
	validatePlan,
	validateVerified,
	type AutoworkState,
} from "./config"
import type { AutoworkTranscriptSignals } from "./transcript"

export type AutoworkAction = "continue" | "stop"

export type AutoworkStopReason = "complete" | "failed" | "cancelled"

export interface AutoworkDecision {
	action: AutoworkAction
	prompt: string | null
	reason: string
	stopReason?: AutoworkStopReason
	nextPhase?: AutoworkState["phase"]
	approvedPlan?: string | null
	approvedCompletion?: string | null
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

function approvedPlanBlock(state: AutoworkState, approvedPlanOverride?: string | null): string {
	const approvedPlan = approvedPlanOverride ?? state.approvedPlan
	if (!approvedPlan?.trim()) return "(no approved plan recorded yet)"
	return approvedPlan
}

function approvedCompletionBlock(state: AutoworkState, approvedCompletionOverride?: string | null): string {
	const approvedCompletion = approvedCompletionOverride ?? state.approvedCompletion
	if (!approvedCompletion?.trim()) return "(no approved completion candidate recorded yet)"
	return approvedCompletion
}

function planTemplate(): string {
	return [
		`<${PLAN_TAG}>`,
		`  <status_quo>`,
		`    [What exists today. Current behavior, current bug, current gap, or current implementation state.]`,
		`  </status_quo>`,
		`  <target_end_state>`,
		`    [What 'done' must look like when this work is truly complete.]`,
		`  </target_end_state>`,
		`  <end_state_checklist>`,
		`    - [x] "exact end state 1" — why this must be true when the task is done`,
		`    - [x] "exact end state 2" — why this must be true when the task is done`,
		`  </end_state_checklist>`,
		`  <ambiguity_check>`,
		`    - [x] "no blocking ambiguity remains" — explain why, or cite the user clarification that resolved it`,
		`  </ambiguity_check>`,
		`  <work_plan>`,
		`    - [ ] inspect the relevant code / state`,
		`    - [ ] implement the smallest correct change`,
		`    - [ ] run the final verification gates`,
		`  </work_plan>`,
		`  <verification_gates>`,
		`    - command: bun test path/to/test.ts`,
		`    - command: bun run typecheck`,
		`    - observe: exact success condition / UI behavior / API response`,
		`  </verification_gates>`,
		`</${PLAN_TAG}>`,
	].join("\n")
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

function verifiedTemplate(): string {
	return [
		`<${VERIFIED_TAG}>`,
		`  <verification_rerun>`,
		`    [The final rerun commands from the verifier pass, with exit codes and outputs.]`,
		`  </verification_rerun>`,
		`  <final_check>`,
		`    - [x] "approved plan fully satisfied" — evidence`,
		`    - [x] "completion claim re-audited" — evidence`,
		`    - [x] "no known remaining gaps" — evidence`,
		`  </final_check>`,
		`</${VERIFIED_TAG}>`,
	].join("\n")
}

function buildPlanningPrompt(state: AutoworkState): string {
	const body = [
		`You are in the Kortix autowork planning phase. Iteration ${state.iteration + 1}/${state.maxIterations}.`,
		"",
		"Before execution starts, eliminate ambiguity and define what done means.",
		"",
		"Your job right now is to produce a precise plan that captures:",
		"- the current status quo",
		"- the exact target end state summary",
		"- an explicit end-state checklist of what must be true when the work is done",
		"- proof that blocking ambiguity is resolved",
		"- the concrete work plan",
		"- the exact verification gates that will prove the work is done",
		"",
		"If blocking ambiguity still remains, ask the user a focused clarifying question instead of pretending the plan is ready.",
		"",
		"**The user's full request (re-anchored):**",
		requestBlock(state),
		"",
		"Emit the plan contract on its own in your next message:",
		"",
		planTemplate(),
	].join("\n")
	return wrapSystem(body, { phase: "planning", iteration: `${state.iteration + 1}/${state.maxIterations}` })
}

function buildPlanRejectionPrompt(state: AutoworkState, reason: string, details: string): string {
	const body = [
		`Your <${PLAN_TAG}> tag was **REJECTED**.`,
		"",
		`**Reason:** ${reason}`,
		"",
		`**Details:**`,
		details,
		"",
		"Do not start execution yet. Fix the plan, eliminate ambiguity, and emit a corrected planning contract:",
		"",
		planTemplate(),
	].join("\n")
	return wrapSystem(body, { phase: "planning_rejected", iteration: `${state.iteration + 1}/${state.maxIterations}` })
}

function buildExecutionPrompt(state: AutoworkState, approvedPlanOverride?: string | null, planningJustFinished = false): string {
	const body = [
		planningJustFinished
			? `Planning is complete. You are now entering the Kortix autowork execution phase at iteration ${state.iteration + 1}/${state.maxIterations}.`
			: `You are in the Kortix autowork execution phase. Iteration ${state.iteration + 1}/${state.maxIterations}.`,
		"",
		"Keep working until the task is truly complete, deterministically verified, and every user requirement has concrete proof.",
		"",
		"**The user's full request (re-anchored every iteration):**",
		requestBlock(state),
		"",
		"**Approved plan (follow this unless the user changes scope):**",
		approvedPlanBlock(state, approvedPlanOverride),
		"",
		"Rules:",
		"- Do real work this turn. No restatement, no planning-in-place, no hedging.",
		"- Maintain the native todo list while autowork is active. Create it if it does not exist yet, and update it honestly as work progresses.",
		"- Read files before editing. Run tests before claiming success.",
		"- Your final verification must be re-run after the last code change. If you edit code after testing, rerun the tests.",
		"- If an approach fails, diagnose the root cause and try a focused fix.",
		"- If you are blocked on missing external input, state exactly what is blocked and why — then stop.",
		"",
		`When — and only when — the task is 100% done, deterministically verified, and every user requirement is satisfied, emit the completion contract on its own in your next message:`,
		"",
		completionTemplate(),
	].join("\n")
	return wrapSystem(body, { phase: planningJustFinished ? "execution_start" : "execution", iteration: `${state.iteration + 1}/${state.maxIterations}` })
}

function buildTodoTrackingPrompt(state: AutoworkState): string {
	const body = [
		"Native todo tracking is required while autowork is active.",
		"",
		"Create or update the real native todo list now before continuing execution.",
		"",
		"Rules:",
		"- Use the native todo tool / session todo list. Do not fake todo tracking with plain text or XML snippets.",
		"- Mirror the approved work plan as concrete native todo items.",
		"- Keep statuses honest: pending / in_progress / completed / cancelled.",
		"",
		"**Approved plan:**",
		approvedPlanBlock(state),
	].join("\n")
	return wrapSystem(body, { phase: "todo_required", iteration: `${state.iteration + 1}/${state.maxIterations}` })
}

function buildCompletionRejectionPrompt(state: AutoworkState, reason: string, details: string): string {
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
		"- The transcript shows completed bash runs for those verification commands after your last code change.",
		"- `<requirements_check>` covers EVERY planned end-state checklist item as `- [x] \"requirement\" — evidence` with concrete proof.",
		"",
		"**The user's full request (re-anchored):**",
		requestBlock(state),
		"",
		"**Approved plan:**",
		approvedPlanBlock(state),
		"",
		"When you are ready to try again, emit:",
		"",
		completionTemplate(),
	].join("\n")
	return wrapSystem(body, { phase: "execution_rejected", iteration: `${state.iteration + 1}/${state.maxIterations}` })
}

function buildVerifierPrompt(state: AutoworkState, approvedCompletionOverride?: string | null): string {
	const body = [
		`You are in the Kortix autowork verifier phase. Iteration ${state.iteration + 1}/${state.maxIterations}.`,
		"",
		"Do a final audit before clean completion. Assume the work may still be wrong until you prove otherwise.",
		"",
		"Re-check the approved plan, re-check the completion claim, rerun the verification commands, and only then emit the verifier contract.",
		"Your final_check must explicitly cover every planned end-state checklist item and every planned observe gate.",
		"",
		"**The user's full request:**",
		requestBlock(state),
		"",
		"**Approved plan:**",
		approvedPlanBlock(state),
		"",
		"**Approved completion candidate:**",
		approvedCompletionBlock(state, approvedCompletionOverride),
		"",
		"Emit the verifier contract on its own in your next message:",
		"",
		verifiedTemplate(),
	].join("\n")
	return wrapSystem(body, { phase: "verifying", iteration: `${state.iteration + 1}/${state.maxIterations}` })
}

function buildVerifierRejectionPrompt(state: AutoworkState, reason: string, details: string): string {
	const body = [
		`Your <${VERIFIED_TAG}> tag was **REJECTED**.`,
		"",
		`**Reason:** ${reason}`,
		"",
		`**Details:**`,
		details,
		"",
		"Stay in verifier mode until you can prove the final audit succeeded.",
		"- Re-run the verification commands for real.",
		"- Make sure final_check explicitly covers every planned end-state item and every planned observe gate.",
		"- Cross-check the approved plan and approved completion candidate.",
		"- Emit a corrected verifier contract only when the audit is genuinely complete.",
		"",
		"**Approved completion candidate:**",
		approvedCompletionBlock(state),
		"",
		verifiedTemplate(),
	].join("\n")
	return wrapSystem(body, { phase: "verifier_rejected", iteration: `${state.iteration + 1}/${state.maxIterations}` })
}

function validateVerificationEvidence(verification: string): { ok: true } | { ok: false; reason: string; details: string } {
	const commandLike = verification
		.split(/\r?\n/)
		.some((line) => /^\s*(?:\$|bun\b|pnpm\b|npm\b|yarn\b|npx\b|node\b|python\b|python3\b|pytest\b|uv\b|deno\b|cargo\b|go\b|curl\b|git\b|make\b)/i.test(line))
	if (!commandLike) {
		return {
			ok: false,
			reason: "verification evidence missing executable commands",
			details: "The verification block must show the actual commands you ran. Include at least one command-like line such as `$ bun test ...` or `$ curl ...`.",
		}
	}

	const resultLike = verification
		.split(/\r?\n/)
		.some((line) => /(\[exit\s+\d+\]|\b\d+\s+passed\b|\bstatus\s*[:=]\s*\d{3}\b|^\s*\d{3}\b|HTTP\/\d(?:\.\d)?\s+\d{3}|output:)/i.test(line))
	if (!resultLike) {
		return {
			ok: false,
			reason: "verification evidence missing concrete results",
			details: "The verification block must include the observed result of running the command — for example `[exit 0]`, an HTTP status, `4 passed`, or concrete tool output.",
		}
	}

	return { ok: true }
}

function describeOutstandingTodos(todoResult: AutoworkTranscriptSignals["todoResult"]): string {
	if (todoResult.remainingItems.length === 0) return "No remaining native todos were found."
	return ["The native todo list still has unfinished work:", ...todoResult.remainingItems.map((item) => `- [${item.status}] ${item.content}`)].join("\n")
}

function commandFromBashCall(call: AutoworkTranscriptSignals["completedBashToolCalls"][number]): string | null {
	const input = call.input as any
	if (typeof input === "string") return normalizeShellCommand(input)
	if (typeof input?.command === "string") return normalizeShellCommand(input.command)
	return null
}

function commandsMatch(expected: string, actual: string): boolean {
	return expected === actual || expected.includes(actual) || actual.includes(expected)
}

function parseApprovedPlan(state: AutoworkState) {
	if (!state.approvedPlan) return null
	return parsePlanTag(state.approvedPlan)
}

function coverageKey(text: string): string {
	const quoted = text.match(/"([^"]+)"|'([^']+)'/)
	if (quoted?.[1] || quoted?.[2]) return normalizeComparableText(quoted[1] ?? quoted[2] ?? "")
	const beforeEmDash = text.split("—")[0] ?? text
	return normalizeComparableText(beforeEmDash)
}

function missingCoverage(expected: string[], actual: string[]): string[] {
	const normalizedActual = actual.map((item) => coverageKey(item))
	return expected.filter((item) => {
		const normalizedExpected = coverageKey(item)
		return !normalizedActual.some((candidate) => candidate.includes(normalizedExpected) || normalizedExpected.includes(candidate))
	})
}

function validateCompletionAgainstPlan(
	state: AutoworkState,
	requirementItems: Array<{ checked: boolean; text: string }>,
): { ok: true } | { ok: false; reason: string; details: string } {
	const approvedPlan = parseApprovedPlan(state)
	if (!approvedPlan) {
		return {
			ok: false,
			reason: "missing approved plan context",
			details: "Autowork lost the approved plan context. Restart the loop so the plan can be re-established before completion.",
		}
	}

	const missingEndState = missingCoverage(
		approvedPlan.endStateItems.map((item) => item.text),
		requirementItems.map((item) => item.text),
	)
	if (missingEndState.length > 0) {
		return {
			ok: false,
			reason: "completion does not cover all planned end-state items",
			details:
				"Your <requirements_check> must explicitly cover every item from the approved <end_state_checklist>. Missing coverage for:\n" +
				missingEndState.map((item) => `  - ${item}`).join("\n"),
		}
	}

	return { ok: true }
}

function validateVerifierAgainstPlan(
	state: AutoworkState,
	finalCheckItems: Array<{ checked: boolean; text: string }>,
): { ok: true; expectedCommands: string[] } | { ok: false; reason: string; details: string; expectedCommands: string[] } {
	const approvedPlan = parseApprovedPlan(state)
	if (!approvedPlan) {
		return {
			ok: false,
			reason: "missing approved plan context",
			details: "Autowork lost the approved plan context. Restart the loop so the plan can be re-established before verifier completion.",
			expectedCommands: [],
		}
	}

	const expectedCommands = planCommandGates(approvedPlan)
	const expectedFinalCoverage = [
		...approvedPlan.endStateItems.map((item) => item.text),
		...planObserveGates(approvedPlan),
	]
	const missingFinalCoverage = missingCoverage(
		expectedFinalCoverage,
		finalCheckItems.map((item) => item.text),
	)
	if (missingFinalCoverage.length > 0) {
		return {
			ok: false,
			reason: "verifier final check does not cover all planned proof items",
			details:
				"Your <final_check> must explicitly cover every planned end-state item and every planned observe gate. Missing coverage for:\n" +
				missingFinalCoverage.map((item) => `  - ${item}`).join("\n"),
			expectedCommands,
		}
	}

	return { ok: true, expectedCommands }
}

function validateTranscriptBackedVerification(
	verification: string,
	signals: AutoworkTranscriptSignals,
	options?: { sameMessageIndex?: number | null; expectedCommands?: string[] },
): { ok: true } | { ok: false; reason: string; details: string } {
	const commands = extractVerificationCommands(verification)
	if (commands.length === 0) {
		return {
			ok: false,
			reason: "verification evidence missing executable commands",
			details: "The verification block must list the exact commands you ran so the transcript can be cross-checked against real bash executions.",
		}
	}

	const requiredCommands = options?.expectedCommands?.length ? options.expectedCommands : commands
	const sameMessageIndex = options?.sameMessageIndex ?? null
	const bashCalls = signals.completedBashToolCalls
		.filter((call) => sameMessageIndex === null || call.messageIndex === sameMessageIndex)
		.map((call) => ({ call, command: commandFromBashCall(call) }))
		.filter((entry): entry is { call: AutoworkTranscriptSignals["completedBashToolCalls"][number]; command: string } => Boolean(entry.command))

	if (bashCalls.length === 0) {
		return {
			ok: false,
			reason: "verification commands not backed by completed bash runs",
			details: sameMessageIndex === null
				? "The transcript does not show completed bash executions for the verification commands. Re-run them with the bash tool and then try again."
				: "The latest assistant message does not include completed bash executions for the verification commands. Re-run them in the verifier message and then try again.",
		}
	}

	const lastMutationIndex = signals.lastMutatingToolCall?.messageIndex ?? null
	for (const command of requiredCommands) {
		const matches = bashCalls.filter(({ command: actual }) => commandsMatch(command, actual))
		if (matches.length === 0) {
			return {
				ok: false,
				reason: "verification commands not backed by completed bash runs",
				details: `The verification block claims you ran \`${command}\`, but the transcript has no completed bash tool call for that command. Run it for real, then try again.`,
			}
		}
		if (sameMessageIndex === null && lastMutationIndex !== null && !matches.some(({ call }) => call.messageIndex >= lastMutationIndex)) {
			return {
				ok: false,
				reason: "verification stale after newer code changes",
				details: `The transcript only shows \`${command}\` before a later code-changing tool call. Re-run your final verification after the last edit, then emit the completion contract again.`,
			}
		}
	}

	return { ok: true }
}

function evaluatePlanningPhase(state: AutoworkState, signals: AutoworkTranscriptSignals): AutoworkDecision {
	if (signals.latestPlanCandidate && signals.latestAssistantMessage && signals.latestPlanCandidate.messageIndex !== signals.latestAssistantMessage.messageIndex) {
		return {
			action: "continue",
			prompt: buildPlanRejectionPrompt(state, "stale planning contract", "A planning contract appeared in an earlier assistant message, but it was followed by newer assistant output. The plan only counts when it appears in the latest assistant turn."),
			reason: "plan rejected: stale planning contract",
		}
	}

	if (signals.latestPlanCandidate) {
		const validation = validatePlan(signals.latestPlanCandidate.parsed)
		if (!validation.ok) {
			return {
				action: "continue",
				prompt: buildPlanRejectionPrompt(state, validation.reason, validation.details),
				reason: `plan rejected: ${validation.reason}`,
			}
		}

		const approvedPlan = renderApprovedPlan(signals.latestPlanCandidate.parsed)
		return {
			action: "continue",
			prompt: buildExecutionPrompt(state, approvedPlan, true),
			reason: "planning contract validated",
			nextPhase: "execution",
			approvedPlan,
		}
	}

	return {
		action: "continue",
		prompt: buildPlanningPrompt(state),
		reason: `planning iteration ${state.iteration + 1}/${state.maxIterations}`,
	}
}

function evaluateExecutionPhase(state: AutoworkState, signals: AutoworkTranscriptSignals): AutoworkDecision {
	if (signals.latestCompletionCandidate && signals.latestAssistantMessage && signals.latestCompletionCandidate.messageIndex !== signals.latestAssistantMessage.messageIndex) {
		return {
			action: "continue",
			prompt: buildCompletionRejectionPrompt(state, "stale completion tag", "A completion tag appeared in an earlier assistant message, but it was followed by newer assistant output. The completion contract only counts when it appears in the latest assistant turn."),
			reason: "completion rejected: stale completion tag",
		}
	}

	if (signals.latestCompletionCandidate) {
		if (signals.todoResult.totalItems === 0) {
			return {
				action: "continue",
				prompt: buildTodoTrackingPrompt(state),
				reason: "completion rejected: native todo tracking missing",
			}
		}

		const validation = validateCompletion(signals.latestCompletionCandidate.parsed)
		if (!validation.ok) {
			return {
				action: "continue",
				prompt: buildCompletionRejectionPrompt(state, validation.reason, validation.details),
				reason: `completion rejected: ${validation.reason}`,
			}
		}

		if (signals.todoResult.verdict === "unfinished") {
			return {
				action: "continue",
				prompt: buildCompletionRejectionPrompt(state, "unfinished native todo items remain", describeOutstandingTodos(signals.todoResult)),
				reason: "completion rejected: unfinished native todo items remain",
			}
		}

		if (!signals.hasAnyWorkSignal) {
			return {
				action: "continue",
				prompt: buildCompletionRejectionPrompt(state, "no completed tool-backed work signal", "The transcript does not show any completed non-question tool calls since autowork started. A well-formed completion tag alone is not enough — do real work and verify it before stopping."),
				reason: "completion rejected: no completed tool-backed work signal",
			}
		}

		const verificationEvidence = validateVerificationEvidence(signals.latestCompletionCandidate.parsed.verification)
		if (!verificationEvidence.ok) {
			return {
				action: "continue",
				prompt: buildCompletionRejectionPrompt(state, verificationEvidence.reason, verificationEvidence.details),
				reason: `completion rejected: ${verificationEvidence.reason}`,
			}
		}

		const completionCoverage = validateCompletionAgainstPlan(state, signals.latestCompletionCandidate.parsed.requirementItems)
		if (!completionCoverage.ok) {
			return {
				action: "continue",
				prompt: buildCompletionRejectionPrompt(state, completionCoverage.reason, completionCoverage.details),
				reason: `completion rejected: ${completionCoverage.reason}`,
			}
		}

		const transcriptVerification = validateTranscriptBackedVerification(
			signals.latestCompletionCandidate.parsed.verification,
			signals,
			{ expectedCommands: parseApprovedPlan(state) ? planCommandGates(parseApprovedPlan(state)!) : [] },
		)
		if (!transcriptVerification.ok) {
			return {
				action: "continue",
				prompt: buildCompletionRejectionPrompt(state, transcriptVerification.reason, transcriptVerification.details),
				reason: `completion rejected: ${transcriptVerification.reason}`,
			}
		}

		return {
			action: "continue",
			prompt: buildVerifierPrompt(state, signals.latestCompletionCandidate.text),
			reason: "completion candidate validated; entering verifier phase",
			nextPhase: "verifying",
			approvedCompletion: signals.latestCompletionCandidate.text,
		}
	}

	if (signals.todoResult.totalItems === 0) {
		return {
			action: "continue",
			prompt: buildTodoTrackingPrompt(state),
			reason: "execution blocked: native todo tracking missing",
		}
	}

	return {
		action: "continue",
		prompt: buildExecutionPrompt(state),
		reason: `execution iteration ${state.iteration + 1}/${state.maxIterations}`,
	}
}

function evaluateVerifierPhase(state: AutoworkState, signals: AutoworkTranscriptSignals): AutoworkDecision {
	if (signals.latestVerifiedCandidate && signals.latestAssistantMessage && signals.latestVerifiedCandidate.messageIndex !== signals.latestAssistantMessage.messageIndex) {
		return {
			action: "continue",
			prompt: buildVerifierRejectionPrompt(state, "stale verifier tag", "A verifier tag appeared in an earlier assistant message, but it was followed by newer assistant output. The verifier contract only counts when it appears in the latest assistant turn."),
			reason: "verifier rejected: stale verifier tag",
		}
	}

	if (signals.latestVerifiedCandidate) {
		if (signals.todoResult.totalItems === 0) {
			return {
				action: "continue",
				prompt: buildVerifierRejectionPrompt(state, "native todo tracking missing", "The verifier phase requires the real native todo list so the final audit can confirm the work history. Create/update the native todos and try again."),
				reason: "verifier rejected: native todo tracking missing",
			}
		}

		const validation = validateVerified(signals.latestVerifiedCandidate.parsed)
		if (!validation.ok) {
			return {
				action: "continue",
				prompt: buildVerifierRejectionPrompt(state, validation.reason, validation.details),
				reason: `verifier rejected: ${validation.reason}`,
			}
		}

		if (signals.todoResult.verdict === "unfinished") {
			return {
				action: "continue",
				prompt: buildVerifierRejectionPrompt(state, "unfinished native todo items remain", describeOutstandingTodos(signals.todoResult)),
				reason: "verifier rejected: unfinished native todo items remain",
			}
		}

		const rerunEvidence = validateVerificationEvidence(signals.latestVerifiedCandidate.parsed.verificationRerun)
		if (!rerunEvidence.ok) {
			return {
				action: "continue",
				prompt: buildVerifierRejectionPrompt(state, rerunEvidence.reason, rerunEvidence.details),
				reason: `verifier rejected: ${rerunEvidence.reason}`,
			}
		}

		const verifierCoverage = validateVerifierAgainstPlan(state, signals.latestVerifiedCandidate.parsed.finalCheckItems)
		if (!verifierCoverage.ok) {
			return {
				action: "continue",
				prompt: buildVerifierRejectionPrompt(state, verifierCoverage.reason, verifierCoverage.details),
				reason: `verifier rejected: ${verifierCoverage.reason}`,
			}
		}
		const transcriptVerification = validateTranscriptBackedVerification(
			signals.latestVerifiedCandidate.parsed.verificationRerun,
			signals,
			{ sameMessageIndex: signals.latestVerifiedCandidate.messageIndex, expectedCommands: verifierCoverage.expectedCommands },
		)
		if (!transcriptVerification.ok) {
			return {
				action: "continue",
				prompt: buildVerifierRejectionPrompt(state, transcriptVerification.reason, transcriptVerification.details),
				reason: `verifier rejected: ${transcriptVerification.reason}`,
			}
		}

		return {
			action: "stop",
			prompt: null,
			reason: "verifier tag validated",
			stopReason: "complete",
		}
	}

	return {
		action: "continue",
		prompt: buildVerifierPrompt(state),
		reason: `verifier iteration ${state.iteration + 1}/${state.maxIterations}`,
	}
}

export function evaluateAutowork(state: AutoworkState, signals: AutoworkTranscriptSignals): AutoworkDecision {
	if (!state.active) return { action: "stop", prompt: null, reason: "inactive", stopReason: "cancelled" }
	if (state.iteration >= state.maxIterations) {
		return { action: "stop", prompt: null, reason: `max iterations reached (${state.maxIterations})`, stopReason: "failed" }
	}

	if (state.phase === "planning") return evaluatePlanningPhase(state, signals)
	if (state.phase === "execution") return evaluateExecutionPhase(state, signals)
	return evaluateVerifierPhase(state, signals)
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
		if (timeSinceAbort < abortGracePeriodMs) return `abort grace period: ${Math.round((abortGracePeriodMs - timeSinceAbort) / 1000)}s remaining`
	}
	if (state.consecutiveFailures >= maxConsecutiveFailures) {
		if (state.lastFailureAt > 0 && Date.now() - state.lastFailureAt >= failureResetWindowMs) return "__reset_failures__"
		return `max consecutive failures (${state.consecutiveFailures}) — pausing for ${Math.round(failureResetWindowMs / 60000)} min`
	}
	if (state.lastInjectedAt > 0 && state.consecutiveFailures > 0) {
		const effectiveCooldown = baseCooldownMs * Math.pow(2, Math.min(state.consecutiveFailures, 5))
		const elapsed = Date.now() - state.lastInjectedAt
		if (elapsed < effectiveCooldown) return `backoff cooldown: ${Math.round((effectiveCooldown - elapsed) / 1000)}s remaining (failure ${state.consecutiveFailures})`
	}
	if (state.lastInjectedAt > 0 && state.consecutiveFailures === 0) {
		const elapsed = Date.now() - state.lastInjectedAt
		if (elapsed < baseCooldownMs) return `minimum cooldown: ${Math.round((baseCooldownMs - elapsed) / 1000)}s remaining`
	}
	return null
}
