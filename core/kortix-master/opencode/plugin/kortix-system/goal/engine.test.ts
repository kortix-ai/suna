import { describe, expect, test } from "bun:test"
import { GOAL_SYSTEM_WRAPPER_TAG, createInitialGoalState } from "./config"
import { evaluateGoal } from "./engine"
import type { GoalToolCallSignal, GoalTranscriptSignals } from "./transcript"

function makeState(overrides: Record<string, unknown> = {}) {
	return {
		...createInitialGoalState(),
		goalId: "goal-test",
		sessionId: "ses-test",
		objective: "build the signup flow",
		status: "active" as const,
		startedAt: Date.now(),
		...overrides,
	}
}

function toolCall(tool: string, messageIndex: number, input: any = {}, output: any = "ok"): GoalToolCallSignal {
	return { messageIndex, tool, input, output }
}

function makeSignals(overrides: Partial<GoalTranscriptSignals> = {}): GoalTranscriptSignals {
	const latestAssistantMessage = {
		messageIndex: 0,
		text: "Still working on the signup flow.",
		completedToolCalls: [],
		completedWorkToolCalls: [],
	}
	return {
		assistantMessages: [latestAssistantMessage],
		latestAssistantMessage,
		completedToolCalls: [],
		completedWorkToolCalls: [],
		completedBashToolCalls: [],
		lastMutatingToolCall: null,
		latestGoalCompletionCall: null,
		hasAnyWorkSignal: false,
		tokensUsed: 0,
		...overrides,
	}
}

describe("evaluateGoal", () => {
	test("active goal emits Codex-style continuation prompt", () => {
		const decision = evaluateGoal(makeState(), makeSignals())

		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain(`<${GOAL_SYSTEM_WRAPPER_TAG}`)
		expect(decision.prompt).toContain("Continue working toward the active thread goal")
		expect(decision.prompt).toContain("build the signup flow")
		expect(decision.prompt).toContain("call update_goal with status \"complete\"")
	})

	test("valid update_goal completion stops the loop", () => {
		const edit = toolCall("edit", 1, { filePath: "src/signup.ts" }, "patched")
		const testRun = toolCall("bash", 2, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const updateGoal = toolCall("update_goal", 2, { status: "complete" }, "Completion requested")
		const decision = evaluateGoal(makeState(), makeSignals({
			assistantMessages: [{ messageIndex: 2, text: "Final audit complete.", completedToolCalls: [testRun, updateGoal], completedWorkToolCalls: [testRun] }],
			latestAssistantMessage: { messageIndex: 2, text: "Final audit complete.", completedToolCalls: [testRun, updateGoal], completedWorkToolCalls: [testRun] },
			completedToolCalls: [edit, testRun, updateGoal],
			completedWorkToolCalls: [edit, testRun],
			completedBashToolCalls: [testRun],
			lastMutatingToolCall: edit,
			latestGoalCompletionCall: updateGoal,
			hasAnyWorkSignal: true,
		}))

		expect(decision.action).toBe("stop")
		expect(decision.stopReason).toBe("complete")
	})

	test("rejects update_goal after mutation without same-turn bash verification", () => {
		const edit = toolCall("edit", 1, { filePath: "src/signup.ts" }, "patched")
		const updateGoal = toolCall("update_goal", 2, { status: "complete" }, "Completion requested")
		const decision = evaluateGoal(makeState(), makeSignals({
			assistantMessages: [{ messageIndex: 2, text: "Final audit complete.", completedToolCalls: [updateGoal], completedWorkToolCalls: [] }],
			latestAssistantMessage: { messageIndex: 2, text: "Final audit complete.", completedToolCalls: [updateGoal], completedWorkToolCalls: [] },
			completedToolCalls: [edit, updateGoal],
			completedWorkToolCalls: [edit],
			lastMutatingToolCall: edit,
			latestGoalCompletionCall: updateGoal,
			hasAnyWorkSignal: true,
		}))

		expect(decision.action).toBe("continue")
		expect(decision.reason).toContain("missing same-turn final verification")
		expect(decision.prompt).toContain("update_goal")
	})

	test("rejects stale update_goal completion request", () => {
		const read = toolCall("read", 1, { filePath: "src/signup.ts" }, "contents")
		const updateGoal = toolCall("update_goal", 1, { status: "complete" }, "Completion requested")
		const decision = evaluateGoal(makeState(), makeSignals({
			assistantMessages: [
				{ messageIndex: 1, text: "Done.", completedToolCalls: [read, updateGoal], completedWorkToolCalls: [read] },
				{ messageIndex: 2, text: "Actually, one more thought.", completedToolCalls: [], completedWorkToolCalls: [] },
			],
			latestAssistantMessage: { messageIndex: 2, text: "Actually, one more thought.", completedToolCalls: [], completedWorkToolCalls: [] },
			completedToolCalls: [read, updateGoal],
			completedWorkToolCalls: [read],
			latestGoalCompletionCall: updateGoal,
			hasAnyWorkSignal: true,
		}))

		expect(decision.action).toBe("continue")
		expect(decision.reason).toContain("stale completion request")
	})

	test("budget limit emits wrap-up prompt", () => {
		const decision = evaluateGoal(makeState({ tokenBudget: 100, tokensUsed: 125 }), makeSignals())

		expect(decision.action).toBe("budget_limit")
		expect(decision.stopReason).toBe("budget_limited")
		expect(decision.prompt).toContain("token budget")
	})

	test("stops with failed reason when max iterations reached", () => {
		const decision = evaluateGoal(makeState({ iteration: 50, maxIterations: 50 }), makeSignals())

		expect(decision.action).toBe("stop")
		expect(decision.stopReason).toBe("failed")
		expect(decision.reason).toContain("max iterations")
	})
})
