import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk"
import { type ContinuationState, createInitialState, DEFAULT_CONFIG, INTERNAL_MARKER, mergeConfig } from "./config"
import { evaluate } from "./continuation-engine"

const unfinished: Todo[] = [
	{ content: "build the parser", status: "completed", priority: "medium", id: "t1" },
	{ content: "wire the routes", status: "pending", priority: "high", id: "t2" },
]
const allDone: Todo[] = [{ content: "build the parser", status: "completed", priority: "medium", id: "t1" }]

/** A state that passes every safety gate (long-running work cycle, no recent activity). */
function readyState(): ContinuationState {
	const s = createInitialState()
	s.workCycleStartedAt = Date.now() - 60_000
	return s
}

describe("evaluate — safety gates stop even with open todos", () => {
	test("continuation disabled → stop", () => {
		const cfg = mergeConfig({ features: { continuation: false, todoEnforcer: true, intentGate: true } })
		const d = evaluate(cfg, readyState(), "Working.", true, unfinished)
		expect(d.action).toBe("stop")
		expect(d.reason).toContain("disabled")
	})

	test("per-request cap reached → stop", () => {
		const s = readyState()
		s.totalSessionContinuations = DEFAULT_CONFIG.thresholds.maxSessionContinuations
		const d = evaluate(DEFAULT_CONFIG, s, "Working.", true, unfinished)
		expect(d.action).toBe("stop")
		expect(d.reason).toContain("max continuations")
	})

	test("cooldown active → stop", () => {
		const s = readyState()
		s.lastContinuationAt = Date.now()
		const d = evaluate(DEFAULT_CONFIG, s, "Working.", true, unfinished)
		expect(d.action).toBe("stop")
		expect(d.reason).toContain("cooldown")
	})

	test("min work duration not met → stop", () => {
		const s = createInitialState()
		s.workCycleStartedAt = Date.now() // just started
		const d = evaluate(DEFAULT_CONFIG, s, "Working.", true, unfinished)
		expect(d.action).toBe("stop")
		expect(d.reason).toContain("min work duration")
	})

	test("circuit breaker (consecutive aborts/empties) → stop", () => {
		const s = readyState()
		s.consecutiveAborts = DEFAULT_CONFIG.thresholds.maxConsecutiveAborts
		const d = evaluate(DEFAULT_CONFIG, s, "", false, unfinished)
		expect(d.action).toBe("stop")
		expect(d.reason).toContain("circuit breaker")
	})

	test("in-flight guard → stop", () => {
		const s = readyState()
		s.inflight = true
		const d = evaluate(DEFAULT_CONFIG, s, "Working.", true, unfinished)
		expect(d.action).toBe("stop")
		expect(d.reason).toContain("in-flight")
	})
})

describe("evaluate — open todos are authoritative", () => {
	test("unfinished todos → CONTINUE with reminder prompt", () => {
		const d = evaluate(DEFAULT_CONFIG, readyState(), "Working.", true, unfinished)
		expect(d.action).toBe("continue")
		expect(d.prompt).toContain("[SYSTEM REMINDER - TODO CONTINUATION]")
		expect(d.prompt).toContain("wire the routes")
		expect(d.prompt).toContain(INTERNAL_MARKER)
	})

	test("empty final message but todos open → CONTINUE (the real self-stop case)", () => {
		const d = evaluate(DEFAULT_CONFIG, readyState(), "", false, unfinished)
		expect(d.action).toBe("continue")
	})

	test("short answer-style final note but todos open → CONTINUE", () => {
		const d = evaluate(DEFAULT_CONFIG, readyState(), "Created a.txt with alpha.", false, unfinished)
		expect(d.action).toBe("continue")
	})

	test("premature 'all tasks completed' claim but todos open → CONTINUE (trust todos, not the claim)", () => {
		const d = evaluate(DEFAULT_CONFIG, readyState(), "All tasks are now completed.", false, unfinished)
		expect(d.action).toBe("continue")
	})

	test("rhetorical 'would you like...' but todos open → CONTINUE (must use question tool to truly block)", () => {
		const d = evaluate(DEFAULT_CONFIG, readyState(), "Would you like me to deploy this now?", false, unfinished)
		expect(d.action).toBe("continue")
	})
})

describe("evaluate — legitimate stops", () => {
	test("todos all done → stop", () => {
		const d = evaluate(DEFAULT_CONFIG, readyState(), "Working.", true, allDone)
		expect(d.action).toBe("stop")
		expect(d.signals.todo?.verdict).toBe("done")
	})

	test("empty message + no tracked work → stop (don't loop on nothing)", () => {
		const d = evaluate(DEFAULT_CONFIG, readyState(), "", false, allDone)
		expect(d.action).toBe("stop")
	})

	test("hard external blocker overrides open todos → stop", () => {
		const d = evaluate(DEFAULT_CONFIG, readyState(), "I cannot connect to the database without credentials.", false, unfinished)
		expect(d.action).toBe("stop")
		expect(d.signals.intent?.intent).toBe("blocked-external")
	})

	test("all remaining todos look blocked → stop and report", () => {
		const blocked: Todo[] = [
			{ content: "ship feature", status: "completed", priority: "medium", id: "t1" },
			{ content: "waiting for user approval", status: "pending", priority: "medium", id: "t2" },
		]
		const d = evaluate(DEFAULT_CONFIG, readyState(), "Working.", true, blocked)
		expect(d.action).toBe("stop")
		expect(d.signals.todo?.verdict).toBe("blocked")
	})
})
