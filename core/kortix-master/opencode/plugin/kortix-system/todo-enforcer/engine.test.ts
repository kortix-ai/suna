import { describe, expect, test } from "bun:test"
import {
	DEFAULT_CONFIG,
	TODO_ENFORCER_SYSTEM_TAG,
	TODO_ENFORCER_TODOS_TAG,
	createInitialContinuationState,
} from "./config"
import { evaluate } from "./engine"

function makeState(overrides: Record<string, unknown> = {}) {
	return {
		...createInitialContinuationState(),
		sessionId: "ses-test",
		workCycleStartedAt: Date.now() - 20_000,
		...overrides,
	}
}

function todo(overrides: Record<string, unknown> = {}) {
	return {
		id: "todo-1",
		content: "finish the implementation",
		status: "pending",
		priority: "medium",
		...overrides,
	}
}

describe("todo-enforcer evaluate", () => {
	test("continues when unfinished native todos remain", () => {
		const decision = evaluate(DEFAULT_CONFIG, makeState(), "Implemented part of it and still working.", true, [todo() as any])
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain(`<${TODO_ENFORCER_SYSTEM_TAG}`)
		expect(decision.prompt).toContain(`<${TODO_ENFORCER_TODOS_TAG}`)
		expect(decision.prompt).toContain("finish the implementation")
	})

	test("continues even after a short conversational assistant turn if native todos remain", () => {
		const decision = evaluate(DEFAULT_CONFIG, makeState(), "Yep, on it.", false, [todo() as any])
		expect(decision.action).toBe("continue")
	})

	test("stops when todos are complete", () => {
		const decision = evaluate(DEFAULT_CONFIG, makeState(), "I finished everything.", false, [todo({ status: "completed" }) as any])
		expect(decision.action).toBe("stop")
		expect(decision.reason).toContain("all 1 items completed")
	})

	test("stops when all remaining todos are blocked", () => {
		const decision = evaluate(DEFAULT_CONFIG, makeState(), "Still working.", true, [todo({ content: "waiting for credentials" }) as any])
		expect(decision.action).toBe("stop")
		expect(decision.reason).toContain("item(s) appear blocked")
	})
})
