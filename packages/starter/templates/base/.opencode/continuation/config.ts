/**
 * Kortix Continuation — Configuration
 *
 * Always-on passive auto-continuation. When a session goes idle with unfinished
 * tracked work (native opencode todos), the runtime re-prompts the agent to keep
 * going instead of letting it self-stop mid-task.
 *
 * This module ships ONLY the passive todo enforcer: no /autowork loop, no keyword
 * activation, no algorithm variants. Keep it small.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Marker appended to every system-injected continuation prompt so the enforcer
 *  never mistakes its own injection for a real user message. */
export const INTERNAL_MARKER = "<!-- KORTIX_INTERNAL -->"

// ─── Feature Toggles ─────────────────────────────────────────────────────────

export interface ContinuationFeatures {
	/** Master switch — session.idle → auto-continue */
	continuation: boolean
	/** Check native todos for unfinished tracked work */
	todoEnforcer: boolean
	/** Classify the last assistant turn before continuing (stop on Q&A / blocked / done) */
	intentGate: boolean
}

// ─── Thresholds & Limits ─────────────────────────────────────────────────────

export interface ContinuationThresholds {
	/** Grace period (ms) after an abort/error event — skip continuation during this window */
	abortGracePeriodMs: number
	/** Min time (ms) the agent must have been working before continuation kicks in */
	minWorkDurationMs: number
	/** Max continuations per user request (absolute safety cap, reset on each new user message) */
	maxSessionContinuations: number
	/** Max consecutive aborts/empty responses before continuation gives up for this request */
	maxConsecutiveAborts: number
	/** Cooldown (ms) between continuation attempts — prevents spam */
	passiveCooldownMs: number
}

// ─── Full Config ──────────────────────────────────────────────────────────────

export interface ContinuationConfig {
	features: ContinuationFeatures
	thresholds: ContinuationThresholds
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_FEATURES: ContinuationFeatures = {
	continuation: true,
	todoEnforcer: true,
	intentGate: true,
}

export const DEFAULT_THRESHOLDS: ContinuationThresholds = {
	abortGracePeriodMs: 3_000, // 3s grace after abort/error events
	minWorkDurationMs: 8_000, // agent must have worked at least 8s before continuation kicks in
	maxSessionContinuations: 50, // per user request — high; this is a safety net, not the expected path
	maxConsecutiveAborts: 3, // 3 consecutive aborts/empty responses → stop continuation for this request
	passiveCooldownMs: 5_000, // 5s minimum between continuation attempts
}

export const DEFAULT_CONFIG: ContinuationConfig = {
	features: { ...DEFAULT_FEATURES },
	thresholds: { ...DEFAULT_THRESHOLDS },
}

// ─── Runtime State ────────────────────────────────────────────────────────────

/** Mutable per-session runtime state for the continuation engine. */
export interface ContinuationState {
	/** Session ID being tracked */
	sessionId: string | null
	/** Continuations injected for the current user request */
	totalSessionContinuations: number
	/** Timestamp when the current work cycle started (the last real user message) */
	workCycleStartedAt: number
	/** Consecutive aborted/empty responses — circuit breaker */
	consecutiveAborts: number
	/** Timestamp of the last abort/error — for the grace period */
	lastAbortAt: number
	/** Timestamp of the last continuation attempt — for the cooldown */
	lastContinuationAt: number
	/** Whether a continuation prompt is currently in-flight (prevents double-fire) */
	inflight: boolean
	/** ID of the last real (non-internal) user message seen — drives per-request budget reset */
	lastUserMessageId: string | null
}

export function createInitialState(): ContinuationState {
	return {
		sessionId: null,
		totalSessionContinuations: 0,
		workCycleStartedAt: 0,
		consecutiveAborts: 0,
		lastAbortAt: 0,
		lastContinuationAt: 0,
		inflight: false,
		lastUserMessageId: null,
	}
}

// ─── Config Helpers ───────────────────────────────────────────────────────────

/** Merge partial config into defaults. */
export function mergeConfig(partial: Partial<ContinuationConfig>): ContinuationConfig {
	return {
		features: { ...DEFAULT_FEATURES, ...partial.features },
		thresholds: { ...DEFAULT_THRESHOLDS, ...partial.thresholds },
	}
}
