import { describe, expect, test } from "bun:test"
import { createInitialGoalState, isGoalActive, parseGoalArgs, remainingTokens } from "./config"

describe("parseGoalArgs", () => {
	test("parses --max-iterations", () => {
		const parsed = parseGoalArgs(`--max-iterations 12 ship the feature`)
		expect(parsed.options.maxIterations).toBe(12)
		expect(parsed.objective).toBe("ship the feature")
	})

	test("parses token budget aliases", () => {
		const parsed = parseGoalArgs(`--budget 5000 --max-iterations 10 build it`)
		expect(parsed.options.tokenBudget).toBe(5000)
		expect(parsed.options.maxIterations).toBe(10)
		expect(parsed.objective).toBe("build it")
	})

	test("falls back to defaults when no flags", () => {
		const parsed = parseGoalArgs("ship the feature")
		expect(parsed.options.maxIterations).toBe(50)
		expect(parsed.options.tokenBudget).toBeNull()
		expect(parsed.objective).toBe("ship the feature")
	})
})

describe("goal state helpers", () => {
	test("remainingTokens reflects configured budgets", () => {
		const state = { ...createInitialGoalState(), tokenBudget: 1000, tokensUsed: 250 }
		expect(remainingTokens(state)).toBe(750)
	})

	test("remainingTokens is null for unbounded goals", () => {
		const state = { ...createInitialGoalState(), tokenBudget: null, tokensUsed: 250 }
		expect(remainingTokens(state)).toBeNull()
	})

	test("isGoalActive requires active status and a goal id", () => {
		expect(isGoalActive({ ...createInitialGoalState(), status: "active", goalId: "goal-1" })).toBe(true)
		expect(isGoalActive({ ...createInitialGoalState(), status: "paused", goalId: "goal-1" })).toBe(false)
		expect(isGoalActive({ ...createInitialGoalState(), status: "active", goalId: null })).toBe(false)
	})
})
