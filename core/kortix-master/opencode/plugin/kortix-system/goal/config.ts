/**
 * Goal configuration + argument parsing.
 *
 * This replaces the old XML-driven autonomous state machine with a Codex-style
 * persistent goal: one objective per session, explicit lifecycle statuses, and
 * model-facing goal tools where update_goal can only request completion.
 */

export const GOAL_SYSTEM_WRAPPER_TAG = "kortix_goal_system"
export const GOAL_OBJECTIVE_TAG = "untrusted_objective"

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete"

export type GoalStopReason = "complete" | "failed" | "cancelled" | "budget_limited"

export interface GoalOptions {
	maxIterations: number
	tokenBudget: number | null
}

export interface GoalState {
	goalId: string | null
	sessionId: string | null
	objective: string | null
	status: GoalStatus
	iteration: number
	maxIterations: number
	tokenBudget: number | null
	tokensUsed: number
	timeUsedSeconds: number
	startedAt: number
	updatedAt: number
	completedAt: number | null
	stopReason: GoalStopReason | null
	messageCountAtStart: number
	lastObservedAssistantMessageIndex: number
	lastInjectedAt: number
	consecutiveFailures: number
	lastFailureAt: number
	lastAbortAt: number
	budgetLimitPrompted: boolean
}

export const GOAL_DEFAULTS: GoalOptions = {
	maxIterations: 50,
	tokenBudget: null,
}

export const GOAL_THRESHOLDS = {
	baseCooldownMs: 3_000,
	maxConsecutiveFailures: 5,
	failureResetWindowMs: 5 * 60_000,
	abortGracePeriodMs: 3_000,
} as const

export function createInitialGoalState(): GoalState {
	return {
		goalId: null,
		sessionId: null,
		objective: null,
		status: "paused",
		iteration: 0,
		maxIterations: GOAL_DEFAULTS.maxIterations,
		tokenBudget: GOAL_DEFAULTS.tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		startedAt: 0,
		updatedAt: 0,
		completedAt: null,
		stopReason: null,
		messageCountAtStart: 0,
		lastObservedAssistantMessageIndex: -1,
		lastInjectedAt: 0,
		consecutiveFailures: 0,
		lastFailureAt: 0,
		lastAbortAt: 0,
		budgetLimitPrompted: false,
	}
}

function tokenizeArgs(raw: string): string[] {
	const tokens = raw.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? []
	return tokens.map((token) => token.replace(/^['"]|['"]$/g, ""))
}

function parsePositiveInteger(value: string | undefined): number | null {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) return null
	return Math.floor(parsed)
}

export function parseGoalArgs(raw: string): { options: GoalOptions; objective: string } {
	const tokens = tokenizeArgs(raw.trim())
	const options: GoalOptions = { ...GOAL_DEFAULTS }
	const objectiveTokens: string[] = []

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		if (!token) continue

		if (token === "--max-iterations") {
			const value = parsePositiveInteger(tokens[i + 1])
			if (value !== null) {
				options.maxIterations = value
				i += 1
				continue
			}
		}

		if (token === "--token-budget" || token === "--budget") {
			const value = parsePositiveInteger(tokens[i + 1])
			if (value !== null) {
				options.tokenBudget = value
				i += 1
				continue
			}
		}

		objectiveTokens.push(token)
	}

	return {
		options,
		objective: objectiveTokens.join(" ").trim() || "Unspecified goal",
	}
}

export function remainingTokens(state: GoalState): number | null {
	if (state.tokenBudget === null) return null
	return Math.max(0, state.tokenBudget - state.tokensUsed)
}

export function isGoalActive(state: GoalState | null | undefined): state is GoalState {
	return !!state && state.status === "active" && !!state.goalId
}
