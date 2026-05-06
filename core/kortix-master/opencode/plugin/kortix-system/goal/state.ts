import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureKortixDir } from "../lib/paths"
import { GOAL_DEFAULTS, createInitialGoalState, type GoalOptions, type GoalState, type GoalStatus, type GoalStopReason } from "./config"

function stateDir(): string {
	return `${ensureKortixDir(import.meta.dir)}/goal-states`
}

function statePath(sessionId: string): string {
	return join(stateDir(), `${sessionId}.json`)
}

function normalizeLoadedState(parsed: Partial<GoalState>): GoalState | null {
	if (!parsed.sessionId || !parsed.goalId || !parsed.status) return null
	return { ...createInitialGoalState(), ...parsed } as GoalState
}

export function persistGoalState(state: GoalState): void {
	try {
		if (!state.sessionId) return
		const dir = stateDir()
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
		writeFileSync(statePath(state.sessionId), JSON.stringify(state, null, 2), "utf-8")
	} catch {
		// non-fatal: goal mode should not crash OpenCode if persistence hiccups
	}
}

export function loadGoalState(sessionId: string): GoalState | null {
	try {
		const path = statePath(sessionId)
		if (!existsSync(path)) return null
		return normalizeLoadedState(JSON.parse(readFileSync(path, "utf-8")) as Partial<GoalState>)
	} catch {
		return null
	}
}

export function loadAllGoalStates(): Map<string, GoalState> {
	const states = new Map<string, GoalState>()
	try {
		const dir = stateDir()
		if (!existsSync(dir)) return states
		for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
			try {
				const state = normalizeLoadedState(JSON.parse(readFileSync(join(dir, file), "utf-8")) as Partial<GoalState>)
				if (state?.sessionId) states.set(state.sessionId, state)
			} catch {
				// ignore broken state file
			}
		}
	} catch {
		// ignore
	}
	return states
}

export function removeGoalState(sessionId: string): void {
	try {
		const path = statePath(sessionId)
		if (existsSync(path)) unlinkSync(path)
	} catch {
		// ignore
	}
}

export function startGoal(
	objective: string,
	sessionId: string,
	messageCountAtStart = 0,
	options: Partial<GoalOptions> = {},
): GoalState {
	const now = Date.now()
	const state: GoalState = {
		...createInitialGoalState(),
		goalId: randomUUID(),
		sessionId,
		objective: objective.trim() || "Unspecified goal",
		status: "active",
		maxIterations: options.maxIterations ?? GOAL_DEFAULTS.maxIterations,
		tokenBudget: options.tokenBudget ?? GOAL_DEFAULTS.tokenBudget,
		messageCountAtStart,
		lastObservedAssistantMessageIndex: messageCountAtStart - 1,
		startedAt: now,
		updatedAt: now,
	}
	persistGoalState(state)
	return state
}

export function setGoalStatus(state: GoalState, status: GoalStatus, stopReason: GoalStopReason | null = null): GoalState {
	const now = Date.now()
	const updated: GoalState = {
		...state,
		status,
		stopReason,
		updatedAt: now,
		completedAt: status === "complete" || status === "budget_limited" ? now : state.completedAt,
	}
	persistGoalState(updated)
	return updated
}

export function appendGoalContext(state: GoalState, text: string): GoalState {
	const updated: GoalState = {
		...state,
		objective: state.objective ? `${state.objective}\n\n${text}` : text,
		updatedAt: Date.now(),
	}
	persistGoalState(updated)
	return updated
}

export function updateGoalUsage(state: GoalState, tokensUsed: number): GoalState {
	const now = Date.now()
	const updated: GoalState = {
		...state,
		tokensUsed: Math.max(0, Math.floor(tokensUsed)),
		timeUsedSeconds: state.startedAt > 0 ? Math.max(0, Math.floor((now - state.startedAt) / 1000)) : state.timeUsedSeconds,
		updatedAt: now,
	}
	persistGoalState(updated)
	return updated
}

export function advanceGoal(state: GoalState): GoalState {
	const updated: GoalState = {
		...state,
		iteration: state.iteration + 1,
		lastInjectedAt: Date.now(),
		consecutiveFailures: 0,
		updatedAt: Date.now(),
	}
	persistGoalState(updated)
	return updated
}

export function noteGoalAssistantMessage(state: GoalState, messageIndex: number): GoalState {
	if (messageIndex <= state.lastObservedAssistantMessageIndex) return state
	const updated: GoalState = {
		...state,
		lastObservedAssistantMessageIndex: messageIndex,
		updatedAt: Date.now(),
	}
	persistGoalState(updated)
	return updated
}

export function recordGoalFailure(state: GoalState): GoalState {
	const updated: GoalState = {
		...state,
		consecutiveFailures: state.consecutiveFailures + 1,
		lastFailureAt: Date.now(),
		updatedAt: Date.now(),
	}
	persistGoalState(updated)
	return updated
}

export function recordGoalAbort(state: GoalState): GoalState {
	const updated: GoalState = {
		...state,
		lastAbortAt: Date.now(),
		updatedAt: Date.now(),
	}
	persistGoalState(updated)
	return updated
}

export function markBudgetLimitPrompted(state: GoalState): GoalState {
	const updated: GoalState = {
		...state,
		budgetLimitPrompted: true,
		updatedAt: Date.now(),
	}
	persistGoalState(updated)
	return updated
}
