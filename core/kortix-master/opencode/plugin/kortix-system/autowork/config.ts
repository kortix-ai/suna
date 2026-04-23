/**
 * Autowork configuration + parsing.
 *
 * The completion contract is a single unique XML tag the worker emits
 * intentionally when it believes the task is 100% done and verified:
 *
 *   <kortix_autowork_complete>
 *     <verification>
 *       [real command output + exit codes]
 *     </verification>
 *     <requirements_check>
 *       - [x] "requirement 1" — evidence
 *       - [x] "requirement 2" — evidence
 *     </requirements_check>
 *   </kortix_autowork_complete>
 *
 * The tag name is namespaced so it cannot appear in prose, logs, or code
 * output by accident. Malformed or incomplete tags are rejected by the
 * engine and the loop continues.
 */

/** Unique XML tag the worker emits to declare completion. */
export const COMPLETION_TAG = "kortix_autowork_complete"

/** Unique XML tag the worker emits to declare an approved execution plan. */
export const PLAN_TAG = "kortix_autowork_plan"

/** Unique XML tag the worker emits to declare the final verifier pass succeeded. */
export const VERIFIED_TAG = "kortix_autowork_verified"

/** Wrapper tag around every plugin-injected prompt — used by the filter
 * to detect internal messages so they never trigger re-evaluation. */
export const SYSTEM_WRAPPER_TAG = "kortix_autowork_system"

/** Wrapper around the re-injected user-requirement block. */
export const REQUEST_TAG = "kortix_autowork_request"

export interface AutoworkOptions {
	maxIterations: number
}

export interface AutoworkState {
	active: boolean
	sessionId: string | null
	/** The original task prompt + appended user messages. */
	taskPrompt: string | null
	phase: "planning" | "execution" | "verifying"
	approvedPlan: string | null
	approvedCompletion: string | null
	iteration: number
	maxIterations: number
	startedAt: number
	completedAt: number | null
	stopReason: "complete" | "failed" | "cancelled" | null
	messageCountAtStart: number
	lastObservedAssistantMessageIndex: number
	lastInjectedAt: number
	consecutiveFailures: number
	lastFailureAt: number
	lastAbortAt: number
	stopped: boolean
}

export const AUTOWORK_DEFAULTS: AutoworkOptions = {
	maxIterations: 50,
}

export const AUTOWORK_THRESHOLDS = {
	baseCooldownMs: 3_000,
	maxConsecutiveFailures: 5,
	failureResetWindowMs: 5 * 60_000,
	abortGracePeriodMs: 3_000,
} as const

export function createInitialAutoworkState(): AutoworkState {
	return {
		active: false,
		sessionId: null,
		taskPrompt: null,
		phase: "planning",
		approvedPlan: null,
		approvedCompletion: null,
		iteration: 0,
		maxIterations: AUTOWORK_DEFAULTS.maxIterations,
		startedAt: 0,
		completedAt: null,
		stopReason: null,
		messageCountAtStart: 0,
		lastObservedAssistantMessageIndex: -1,
		lastInjectedAt: 0,
		consecutiveFailures: 0,
		lastFailureAt: 0,
		lastAbortAt: 0,
		stopped: false,
	}
}

function tokenizeArgs(raw: string): string[] {
	const tokens = raw.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? []
	return tokens.map((token) => token.replace(/^['"]|['"]$/g, ""))
}

export function parseAutoworkArgs(raw: string): { options: AutoworkOptions; task: string } {
	const tokens = tokenizeArgs(raw.trim())
	const options: AutoworkOptions = { ...AUTOWORK_DEFAULTS }
	const taskTokens: string[] = []

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		if (!token) continue
		if (token === "--max-iterations") {
			const value = Number(tokens[i + 1])
			if (Number.isFinite(value) && value > 0) {
				options.maxIterations = value
				i += 1
				continue
			}
		}
		// Legacy flags from the old plain-string promise era — accepted and
		// silently dropped so existing callers (including spawned workers
		// that still send `--completion-promise TASK_COMPLETE`) don't break.
		if (token === "--completion-promise" || token === "--verification") {
			if (tokens[i + 1] !== undefined) i += 1
			continue
		}
		taskTokens.push(token)
	}

	return {
		options,
		task: taskTokens.join(" ").trim() || "Unspecified task",
	}
}

// ── Completion tag parser ────────────────────────────────────────────────────

export interface ParsedCompletion {
	verification: string
	requirementsCheck: string
	requirementItems: Array<{ checked: boolean; text: string }>
}

export interface ParsedPlan {
	statusQuo: string
	targetEndState: string
	endStateChecklist: string
	endStateItems: Array<{ checked: boolean; text: string }>
	ambiguityCheck: string
	ambiguityItems: Array<{ checked: boolean; text: string }>
	workPlan: string
	workPlanItems: Array<{ checked: boolean; text: string }>
	verificationGates: string
	verificationGateItems: Array<{ kind: "command" | "observe"; value: string }>
}

export interface ParsedVerified {
	verificationRerun: string
	finalCheck: string
	finalCheckItems: Array<{ checked: boolean; text: string }>
}

const VERIFICATION_COMMAND_LINE = /^\s*(?:\$|bun\b|pnpm\b|npm\b|yarn\b|npx\b|node\b|python\b|python3\b|pytest\b|uv\b|deno\b|cargo\b|go\b|curl\b|git\b|make\b)/i

/**
 * Parser for the completion tag.
 *
 * - Returns `null` if the outer `<kortix_autowork_complete>` tag is absent.
 * - Returns a `ParsedCompletion` if the outer tag is present, even if the
 *   children are missing or empty — downstream `validateCompletion` turns that
 *   into a structured rejection so the worker learns exactly what's missing.
 *
 * Only matches the LAST occurrence of the outer tag — the most recent
 * declaration wins.
 */
export function parseCompletionTag(text: string): ParsedCompletion | null {
	if (!text) return null

	const tagPattern = new RegExp(
		`<${COMPLETION_TAG}[^>]*>([\\s\\S]*?)<\\/${COMPLETION_TAG}>`,
		"gi",
	)
	const matches = [...text.matchAll(tagPattern)]
	if (matches.length === 0) return null
	const body = matches[matches.length - 1]?.[1] ?? ""

	const verification = extractInner(body, "verification") ?? ""
	const requirementsCheck = extractInner(body, "requirements_check") ?? ""
	const requirementItems = parseRequirementItems(requirementsCheck)

	return {
		verification: verification.trim(),
		requirementsCheck: requirementsCheck.trim(),
		requirementItems,
	}
}

export function parsePlanTag(text: string): ParsedPlan | null {
	if (!text) return null

	const tagPattern = new RegExp(
		`<${PLAN_TAG}[^>]*>([\\s\\S]*?)<\\/${PLAN_TAG}>`,
		"gi",
	)
	const matches = [...text.matchAll(tagPattern)]
	if (matches.length === 0) return null
	const body = matches[matches.length - 1]?.[1] ?? ""

	const statusQuo = extractInner(body, "status_quo") ?? ""
	const targetEndState = extractInner(body, "target_end_state") ?? ""
	const endStateChecklist = extractInner(body, "end_state_checklist") ?? ""
	const ambiguityCheck = extractInner(body, "ambiguity_check") ?? ""
	const workPlan = extractInner(body, "work_plan") ?? ""
	const verificationGates = extractInner(body, "verification_gates") ?? ""

	return {
		statusQuo: statusQuo.trim(),
		targetEndState: targetEndState.trim(),
		endStateChecklist: endStateChecklist.trim(),
		endStateItems: parseRequirementItems(endStateChecklist),
		ambiguityCheck: ambiguityCheck.trim(),
		ambiguityItems: parseRequirementItems(ambiguityCheck),
		workPlan: workPlan.trim(),
		workPlanItems: parseRequirementItems(workPlan),
		verificationGates: verificationGates.trim(),
		verificationGateItems: parseVerificationGateItems(verificationGates),
	}
}

export function parseVerifiedTag(text: string): ParsedVerified | null {
	if (!text) return null

	const tagPattern = new RegExp(
		`<${VERIFIED_TAG}[^>]*>([\\s\\S]*?)<\\/${VERIFIED_TAG}>`,
		"gi",
	)
	const matches = [...text.matchAll(tagPattern)]
	if (matches.length === 0) return null
	const body = matches[matches.length - 1]?.[1] ?? ""

	const verificationRerun = extractInner(body, "verification_rerun") ?? ""
	const finalCheck = extractInner(body, "final_check") ?? ""

	return {
		verificationRerun: verificationRerun.trim(),
		finalCheck: finalCheck.trim(),
		finalCheckItems: parseRequirementItems(finalCheck),
	}
}

function extractInner(body: string, tag: string): string | null {
	const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
	const match = body.match(pattern)
	if (!match) return null
	return match[1] ?? ""
}

function parseRequirementItems(block: string): Array<{ checked: boolean; text: string }> {
	const items: Array<{ checked: boolean; text: string }> = []
	const lines = block.split(/\r?\n/)
	for (const raw of lines) {
		const line = raw.trim()
		if (!line) continue
		const match = line.match(/^[-*]\s*\[([ xX])\]\s*(.*)$/)
		if (!match) continue
		items.push({
			checked: match[1]?.toLowerCase() === "x",
			text: (match[2] ?? "").trim(),
		})
	}
	return items
}

function parseVerificationGateItems(block: string): Array<{ kind: "command" | "observe"; value: string }> {
	const items: Array<{ kind: "command" | "observe"; value: string }> = []
	for (const raw of block.split(/\r?\n/)) {
		const line = raw.trim()
		if (!line) continue
		const match = line.match(/^[-*]\s*(command|observe)\s*:\s*(.*)$/i)
		if (!match) continue
		const kind = match[1]?.toLowerCase() === "command" ? "command" : "observe"
		const value = (match[2] ?? "").trim()
		if (!value) continue
		items.push({ kind, value })
	}
	return items
}

export function normalizeComparableText(text: string): string {
	return text.toLowerCase().replace(/[`"']/g, "").replace(/\s+/g, " ").trim()
}

export function planCommandGates(parsed: ParsedPlan): string[] {
	return parsed.verificationGateItems
		.filter((item) => item.kind === "command")
		.map((item) => normalizeShellCommand(item.value))
}

export function planObserveGates(parsed: ParsedPlan): string[] {
	return parsed.verificationGateItems
		.filter((item) => item.kind === "observe")
		.map((item) => item.value.trim())
}

export function normalizeShellCommand(command: string): string {
	return command.trim().replace(/^\$\s*/, "").replace(/\s+/g, " ")
}

export function extractVerificationCommands(verification: string): string[] {
	const commands: string[] = []
	for (const raw of verification.split(/\r?\n/)) {
		const line = raw.trim()
		if (!line || !VERIFICATION_COMMAND_LINE.test(line)) continue
		commands.push(normalizeShellCommand(line))
	}
	return commands
}

// ── Validation of a parsed completion ───────────────────────────────────────

export type CompletionValidation =
	| { ok: true }
	| { ok: false; reason: string; details: string }

export type PlanValidation =
	| { ok: true }
	| { ok: false; reason: string; details: string }

export type VerifiedValidation =
	| { ok: true }
	| { ok: false; reason: string; details: string }

export function validateCompletion(parsed: ParsedCompletion): CompletionValidation {
	if (!parsed.verification.trim()) {
		return {
			ok: false,
			reason: "empty <verification>",
			details:
				"The <verification> child was empty. You must include the actual commands you ran (with exit codes / output) that prove the task works. Not 'should work.' Real output.",
		}
	}
	if (!parsed.requirementsCheck.trim()) {
		return {
			ok: false,
			reason: "empty <requirements_check>",
			details:
				"The <requirements_check> child was empty. You must enumerate every user requirement as `- [x] \"requirement\" — evidence`.",
		}
	}
	if (parsed.requirementItems.length === 0) {
		return {
			ok: false,
			reason: "no checklist items in <requirements_check>",
			details:
				"The <requirements_check> child must contain at least one `- [x] \"requirement\" — evidence` line. Enumerate every user requirement.",
		}
	}
	const unchecked = parsed.requirementItems.filter((item) => !item.checked)
	if (unchecked.length > 0) {
		return {
			ok: false,
			reason: `${unchecked.length} unchecked requirement item(s)`,
			details:
				"The following requirement items are not marked `[x]`:\n" +
				unchecked.map((item) => `  - [ ] ${item.text}`).join("\n") +
				"\nEither complete them or explain in the item text why they are not applicable and mark them `[x]`.",
		}
	}
	return { ok: true }
}

export function validatePlan(parsed: ParsedPlan): PlanValidation {
	if (!parsed.statusQuo.trim()) {
		return {
			ok: false,
			reason: "empty <status_quo>",
			details:
				"The planning phase requires a concrete <status_quo> section that explains what the current state is today — code, behavior, or system reality.",
		}
	}
	if (!parsed.targetEndState.trim()) {
		return {
			ok: false,
			reason: "empty <target_end_state>",
			details:
				"The planning phase requires a concrete <target_end_state> section that describes what 'done' must look like when the work is truly complete.",
		}
	}
	if (!parsed.endStateChecklist.trim()) {
		return {
			ok: false,
			reason: "empty <end_state_checklist>",
			details:
				"The planning phase requires <end_state_checklist> with explicit checklist items that define what done must concretely look like.",
		}
	}
	if (parsed.endStateItems.length === 0) {
		return {
			ok: false,
			reason: "no checklist items in <end_state_checklist>",
			details:
				"<end_state_checklist> must contain at least one `- [x] \"end state\" — why this is required` line.",
		}
	}
	const uncheckedEndStateItems = parsed.endStateItems.filter((item) => !item.checked)
	if (uncheckedEndStateItems.length > 0) {
		return {
			ok: false,
			reason: `${uncheckedEndStateItems.length} unchecked end-state item(s)`,
			details:
				"Every end-state item must be explicitly confirmed before execution starts:\n" +
				uncheckedEndStateItems.map((item) => `  - [ ] ${item.text}`).join("\n"),
		}
	}
	if (!parsed.ambiguityCheck.trim()) {
		return {
			ok: false,
			reason: "empty <ambiguity_check>",
			details:
				"You must explicitly review ambiguity before execution. Use <ambiguity_check> with checklist items showing that blocking ambiguity has been resolved or clarified.",
		}
	}
	if (parsed.ambiguityItems.length === 0) {
		return {
			ok: false,
			reason: "no checklist items in <ambiguity_check>",
			details:
				"<ambiguity_check> must contain at least one checklist item such as `- [x] \"no blocking ambiguity remains\" — reason`.",
		}
	}
	const unresolvedAmbiguities = parsed.ambiguityItems.filter((item) => !item.checked)
	if (unresolvedAmbiguities.length > 0) {
		return {
			ok: false,
			reason: `${unresolvedAmbiguities.length} unresolved ambiguity item(s)`,
			details:
				"The following ambiguity items are still unchecked:\n" +
				unresolvedAmbiguities.map((item) => `  - [ ] ${item.text}`).join("\n") +
				"\nResolve them first or ask the user a clarifying question before execution.",
		}
	}
	if (!parsed.workPlan.trim()) {
		return {
			ok: false,
			reason: "empty <work_plan>",
			details:
				"The planning phase requires a <work_plan> checklist with the concrete execution steps that will move the status quo to the target end state.",
		}
	}
	if (parsed.workPlanItems.length === 0) {
		return {
			ok: false,
			reason: "no checklist items in <work_plan>",
			details:
				"<work_plan> must contain at least one checklist item. Break the work into concrete steps before entering the execution loop.",
		}
	}
	if (!parsed.verificationGates.trim()) {
		return {
			ok: false,
			reason: "empty <verification_gates>",
			details:
				"The planning phase requires <verification_gates> that spell out exactly what commands, checks, or observations will prove the work is done.",
		}
	}
	if (parsed.verificationGateItems.length === 0) {
		return {
			ok: false,
			reason: "no verification gates parsed",
			details:
				"<verification_gates> must contain at least one `- command: ...` or `- observe: ...` line so autowork can enforce proof of done.",
		}
	}
	return { ok: true }
}

export function validateVerified(parsed: ParsedVerified): VerifiedValidation {
	if (!parsed.verificationRerun.trim()) {
		return {
			ok: false,
			reason: "empty <verification_rerun>",
			details:
				"The verifier phase requires <verification_rerun> with the exact commands re-run during the final audit and their real outputs.",
		}
	}
	if (!parsed.finalCheck.trim()) {
		return {
			ok: false,
			reason: "empty <final_check>",
			details:
				"The verifier phase requires <final_check> with checklist items proving the approved plan and completion claim were fully satisfied.",
		}
	}
	if (parsed.finalCheckItems.length === 0) {
		return {
			ok: false,
			reason: "no checklist items in <final_check>",
			details:
				"<final_check> must contain at least one `- [x] \"check\" — evidence` line.",
		}
	}
	const unchecked = parsed.finalCheckItems.filter((item) => !item.checked)
	if (unchecked.length > 0) {
		return {
			ok: false,
			reason: `${unchecked.length} unchecked final check item(s)`,
			details:
				"The following verifier checklist items are not marked `[x]`:\n" +
				unchecked.map((item) => `  - [ ] ${item.text}`).join("\n") +
				"\nFinish the audit before emitting the verifier tag.",
		}
	}
	return { ok: true }
}

export function renderApprovedPlan(parsed: ParsedPlan): string {
	return [
		`<${PLAN_TAG}>`,
		`  <status_quo>`,
		parsed.statusQuo,
		`  </status_quo>`,
		`  <target_end_state>`,
		parsed.targetEndState,
		`  </target_end_state>`,
		`  <end_state_checklist>`,
		parsed.endStateChecklist,
		`  </end_state_checklist>`,
		`  <ambiguity_check>`,
		parsed.ambiguityCheck,
		`  </ambiguity_check>`,
		`  <work_plan>`,
		parsed.workPlan,
		`  </work_plan>`,
		`  <verification_gates>`,
		parsed.verificationGates,
		`  </verification_gates>`,
		`</${PLAN_TAG}>`,
	].join("\n")
}
