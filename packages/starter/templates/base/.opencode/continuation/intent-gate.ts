/**
 * Intent Gate — Lightweight turn classifier
 *
 * Classifies the last assistant message to determine whether continuation is
 * appropriate. Keeps the engine from looping on conversational turns,
 * user-blocked states, or answer-only responses.
 *
 * Classification is heuristic-based (no LLM call). The goal is to catch obvious
 * stop-cases cheaply before the engine consults todo state.
 */

import type { Todo } from "@opencode-ai/sdk"

// ─── Intent Types ────────────────────────────────────────────────────────────

export type Intent =
	| "answer" // Simple Q&A — no continuation needed
	| "executing" // Actively working on a task (tool calls present)
	| "planning" // Laid out a plan, may need to execute
	| "blocked-human" // Waiting on the user for input/decision/credentials
	| "blocked-external" // Waiting on external dependency (OAuth, API key, etc.)
	| "blocked-question" // Waiting for user to answer a question tool call
	| "completed" // Explicitly signaled completion
	| "unknown" // Can't classify — fall through to other signals

export interface IntentResult {
	intent: Intent
	reason: string
	shouldContinue: boolean
}

// ─── Classification ──────────────────────────────────────────────────────────

// Patterns that indicate the assistant is waiting on the user
const BLOCKED_HUMAN_PATTERNS = [
	/(?:should i|shall i|would you like|do you want|let me know|please confirm|waiting for your)/i,
	/(?:which (?:option|approach|one)|what do you (?:think|prefer))/i,
	/(?:before i proceed|proceed with|go ahead with)/i,
	/(?:could you (?:provide|share|clarify|specify))/i,
	/(?:i need you to|please (?:provide|share|specify|tell me))/i,
	/(?:can you (?:provide|share|clarify|confirm|let me know))/i,
	/(?:your (?:input|feedback|approval|confirmation|decision) (?:is needed|needed|required))/i,
	/(?:once you(?:'ve)? (?:decided|confirmed|reviewed|provided))/i,
	/(?:how would you like|what would you like me to)/i,
]

// Patterns that indicate external blockers
const BLOCKED_EXTERNAL_PATTERNS = [
	/(?:api key|api_key|token|credential|secret|password).*(?:not set|missing|required|needed|unavailable)/i,
	/(?:oauth|authorization|authenticate).*(?:required|needed|first)/i,
	/(?:connect|configure|set up).*(?:first|before)/i,
	/(?:environment variable|env var).*(?:not set|missing|required)/i,
	/(?:cannot|can't|unable to) (?:access|connect|reach|authenticate)/i,
]

// Patterns that indicate explicit completion — require strong, specific signal words.
// Deliberately conservative: prefer false negatives over false positives.
// (We do NOT match bare "done" — too many false positives in work-in-progress messages.)
const COMPLETION_PATTERNS = [
	// "all tasks/items/todos are completed/done/finished"
	/(?:all (?:tasks?|items?|todos?|steps?) (?:are )?(?:now )?(?:completed?|done|finished))/i,
	// "everything is done/complete/finished"
	/(?:everything (?:is (?:now )?)?(?:done|complete|finished))/i,
	// "the task/work/implementation is complete"
	/(?:the (?:task|work|implementation|feature|refactor) (?:is (?:now )?)?(?:complete|done|finished))/i,
	// "successfully completed/implemented/deployed/shipped [something]"
	/(?:successfully (?:completed?|implemented|deployed|shipped|finished)) (?:all|the|this)/i,
	// "implementation/refactoring/migration is complete"
	/(?:implementation|refactoring|migration|integration) (?:is (?:now )?)?(?:complete|done|finished)/i,
]

// Patterns that indicate answer-only (no action taken)
const ANSWER_ONLY_PATTERNS = [
	/(?:^here'?s? (?:the|an|a) (?:explanation|answer|summary))/i,
	/(?:^in (?:short|summary|brief)[,:])/i,
	/(?:^to answer your question)/i,
	/(?:^the (?:answer|reason|explanation) is)/i,
	/(?:^(?:yes|no)[,.]?\s+(?:the|this|that|you|it))/i,
]

// Patterns indicating the agent is reporting completed work (stop passive continuation)
const REPORTING_PATTERNS = [
	/(?:^|\n)(?:here(?:'s| is) what i (?:did|changed|implemented|added|fixed))/i,
	/(?:^|\n)(?:i(?:'ve| have) (?:completed?|finished|implemented|added|fixed|updated|refactored))/i,
	/(?:^|\n)(?:the (?:following|above) (?:changes|modifications|updates) (?:have been|were) made)/i,
]

// Patterns that indicate the agent used the question tool (awaiting user answer)
const PENDING_QUESTION_PATTERNS = [
	/\[question tool\]/i,
	/awaiting your (response|answer|input)/i,
	/please (answer|respond to) (the|this) question/i,
]

// Patterns indicating a plan was laid out
const PLANNING_PATTERNS = [
	/(?:here'?s? (?:the|my|a) plan)/i,
	/(?:i'?ll|i will|let me) (?:start|begin) (?:by|with)/i,
	/(?:step \d|phase \d|first,? i'?ll)/i,
	/(?:the approach|my approach|implementation plan)/i,
	/(?:plan of action|here'?s? (?:how|what) i'?ll)/i,
]

/**
 * Classify the last assistant message to determine if continuation is appropriate.
 *
 * @param lastAssistantText - The text content of the last assistant message
 * @param hadToolCalls - Whether the assistant's last turn included tool calls
 * @param todos - Current todo state (if available)
 */
export function classifyIntent(lastAssistantText: string, hadToolCalls: boolean, todos?: Todo[]): IntentResult {
	const text = lastAssistantText.trim()

	// Empty response — likely still processing or error
	if (!text && !hadToolCalls) {
		return { intent: "unknown", reason: "empty response", shouldContinue: false }
	}

	// 0. Check for pending question (agent waiting for user answer)
	for (const pattern of PENDING_QUESTION_PATTERNS) {
		if (pattern.test(text)) {
			return { intent: "blocked-question", reason: "pending question awaiting user", shouldContinue: false }
		}
	}

	// 1. Check for explicit completion signals (strong signals only)
	for (const pattern of COMPLETION_PATTERNS) {
		if (pattern.test(text)) {
			return { intent: "completed", reason: "explicit completion signal", shouldContinue: false }
		}
	}

	// 2. Check for external blockers (higher priority than human-blocked)
	for (const pattern of BLOCKED_EXTERNAL_PATTERNS) {
		if (pattern.test(text)) {
			return { intent: "blocked-external", reason: "waiting on external dependency", shouldContinue: false }
		}
	}

	// 3. Check for human-blocked state
	for (const pattern of BLOCKED_HUMAN_PATTERNS) {
		if (pattern.test(text)) {
			return { intent: "blocked-human", reason: "waiting on user input", shouldContinue: false }
		}
	}

	// 4. If the turn had tool calls, the agent was actively working
	if (hadToolCalls) {
		return { intent: "executing", reason: "tool calls present", shouldContinue: true }
	}

	// 5. Check if this looks like a plan (planning → might need to continue to execute)
	for (const pattern of PLANNING_PATTERNS) {
		if (pattern.test(text)) {
			// Only continue if there are pending todos
			const hasPendingWork = todos?.some((t) => t.status === "pending" || t.status === "in_progress")
			return {
				intent: "planning",
				reason: hasPendingWork ? "plan with pending work" : "plan laid out",
				shouldContinue: hasPendingWork ?? false,
			}
		}
	}

	// 6. Check for reporting patterns (agent just summarized what it did)
	for (const pattern of REPORTING_PATTERNS) {
		if (pattern.test(text)) {
			return { intent: "completed", reason: "agent reporting completed work", shouldContinue: false }
		}
	}

	// 7. Check for answer-only patterns
	for (const pattern of ANSWER_ONLY_PATTERNS) {
		if (pattern.test(text)) {
			return { intent: "answer", reason: "answer-only response", shouldContinue: false }
		}
	}

	// 8. Short text without tool calls — likely conversational
	// 300 chars: enough room for brief work summaries but catches most pure Q&A
	if (text.length < 300 && !hadToolCalls) {
		return { intent: "answer", reason: "short response without tools", shouldContinue: false }
	}

	// 9. Fall through — can't classify, let other signals decide
	return { intent: "unknown", reason: "unclassified", shouldContinue: false }
}
