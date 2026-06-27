import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk"
import { evaluateTodos, formatRemainingWork } from "./todo-enforcer"

let counter = 0
function todo(content: string, status: string, priority = "medium"): Todo {
	counter += 1
	return { content, status, priority, id: `todo-${counter}` }
}

describe("evaluateTodos", () => {
	test("no todos → done (nothing to enforce)", () => {
		const r = evaluateTodos([])
		expect(r.verdict).toBe("done")
		expect(r.totalItems).toBe(0)
	})

	test("all completed → done", () => {
		const r = evaluateTodos([todo("a", "completed"), todo("b", "completed")])
		expect(r.verdict).toBe("done")
		expect(r.completedItems).toBe(2)
		expect(r.remainingItems).toHaveLength(0)
	})

	test("cancelled counts as resolved → done", () => {
		const r = evaluateTodos([todo("a", "completed"), todo("b", "cancelled")])
		expect(r.verdict).toBe("done")
	})

	test("pending item → unfinished", () => {
		const r = evaluateTodos([todo("a", "completed"), todo("b", "pending")])
		expect(r.verdict).toBe("unfinished")
		expect(r.remainingItems).toHaveLength(1)
		expect(r.completedItems).toBe(1)
	})

	test("in_progress item → unfinished", () => {
		const r = evaluateTodos([todo("a", "in_progress")])
		expect(r.verdict).toBe("unfinished")
	})

	test("all remaining look blocked → blocked", () => {
		const r = evaluateTodos([todo("done thing", "completed"), todo("waiting for user approval", "pending"), todo("blocked on missing credentials", "pending")])
		expect(r.verdict).toBe("blocked")
	})

	test("partial blocked (some real work remains) → unfinished", () => {
		const r = evaluateTodos([todo("waiting for review", "pending"), todo("write the parser", "pending")])
		expect(r.verdict).toBe("unfinished")
	})
})

describe("formatRemainingWork", () => {
	test("renders remaining items with status + high-priority marker", () => {
		const r = evaluateTodos([todo("done", "completed"), todo("ship it", "in_progress", "high"), todo("test it", "pending")])
		const out = formatRemainingWork(r)
		expect(out).toContain("[TODO ENFORCER] 1/3 complete")
		expect(out).toContain("ship it")
		expect(out).toContain("❗") // high priority marker
		expect(out).toContain("test it")
	})

	test("empty when nothing remains", () => {
		const r = evaluateTodos([todo("a", "completed")])
		expect(formatRemainingWork(r)).toBe("")
	})
})
