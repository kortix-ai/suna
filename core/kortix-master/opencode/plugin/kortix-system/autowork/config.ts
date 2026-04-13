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
	iteration: number
	maxIterations: number
	startedAt: number
	completedAt: number | null
	stopReason: "complete" | "failed" | "cancelled" | null
	messageCountAtStart: number
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
		iteration: 0,
		maxIterations: AUTOWORK_DEFAULTS.maxIterations,
		startedAt: 0,
		completedAt: null,
		stopReason: null,
		messageCountAtStart: 0,
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

// ── Validation of a parsed completion ───────────────────────────────────────

export type CompletionValidation =
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
