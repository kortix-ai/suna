import { describe, expect, test } from "bun:test"
import { evaluateTodos } from "./todo-enforcer"

function todo(overrides: Record<string, unknown> = {}) {
	return {
		id: "todo-1",
		content: "ship the feature",
		status: "pending",
		priority: "medium",
		...overrides,
	}
}

describe("evaluateTodos", () => {
	test("returns unfinished when pending work remains", () => {
		const result = evaluateTodos([
			todo({ status: "completed" }),
			todo({ id: "todo-2", content: "write tests", status: "in_progress", priority: "high" }),
		])
		expect(result.verdict).toBe("unfinished")
		expect(result.completedItems).toBe(1)
		expect(result.remainingItems).toHaveLength(1)
		expect(result.remainingItems[0]?.content).toBe("write tests")
	})

	test("returns blocked when all remaining items look blocked", () => {
		const result = evaluateTodos([
			todo({ content: "waiting for API key", status: "pending" }),
			todo({ id: "todo-2", content: "blocked pending review", status: "in_progress" }),
		])
		expect(result.verdict).toBe("blocked")
	})

	test("returns done when no remaining work exists", () => {
		const result = evaluateTodos([
			todo({ status: "completed" }),
			todo({ id: "todo-2", status: "cancelled" }),
		])
		expect(result.verdict).toBe("done")
	})
})
