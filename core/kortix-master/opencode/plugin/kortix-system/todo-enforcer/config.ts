export const TODO_ENFORCER_INTERNAL_MARKER = "<!-- KORTIX_TODO_ENFORCER_INTERNAL -->"
export const TODO_ENFORCER_SYSTEM_TAG = "kortix_todo_enforcer_system"
export const TODO_ENFORCER_TODOS_TAG = "kortix_todo_enforcer_todos"

export interface ContinuationFeatures {
	continuation: boolean
	todoEnforcer: boolean
}

export interface ContinuationThresholds {
	abortGracePeriodMs: number
	minWorkDurationMs: number
	maxSessionContinuations: number
	maxConsecutiveAborts: number
	passiveCooldownMs: number
}

export interface ContinuationConfig {
	features: ContinuationFeatures
	thresholds: ContinuationThresholds
}

export interface ContinuationState {
	sessionId: string | null
	totalSessionContinuations: number
	workCycleStartedAt: number
	consecutiveAborts: number
	lastAbortAt: number
	lastContinuationAt: number
	inflight: boolean
}

export const DEFAULT_CONFIG: ContinuationConfig = {
	features: {
		continuation: true,
		todoEnforcer: true,
	},
	thresholds: {
		abortGracePeriodMs: 3_000,
		minWorkDurationMs: 8_000,
		maxSessionContinuations: 50,
		maxConsecutiveAborts: 3,
		passiveCooldownMs: 5_000,
	},
}

export function createInitialContinuationState(): ContinuationState {
	return {
		sessionId: null,
		totalSessionContinuations: 0,
		workCycleStartedAt: 0,
		consecutiveAborts: 0,
		lastAbortAt: 0,
		lastContinuationAt: 0,
		inflight: false,
	}
}
