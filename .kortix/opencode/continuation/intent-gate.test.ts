import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk"
import { classifyIntent } from "./intent-gate"

const pendingTodos: Todo[] = [{ content: "do the thing", status: "pending", priority: "medium", id: "t1" }]

describe("classifyIntent", () => {
	test("empty response → unknown, do not continue", () => {
		const r = classifyIntent("", false)
		expect(r.intent).toBe("unknown")
		expect(r.shouldContinue).toBe(false)
	})

	test("tool calls present → executing, continue", () => {
		const r = classifyIntent("Editing the file now.", true)
		expect(r.intent).toBe("executing")
		expect(r.shouldContinue).toBe(true)
	})

	test("explicit completion → completed, stop", () => {
		const r = classifyIntent("All tasks are now completed and the feature works.", false)
		expect(r.intent).toBe("completed")
		expect(r.shouldContinue).toBe(false)
	})

	test("external blocker → blocked-external, stop", () => {
		const r = classifyIntent("I cannot connect to the database without credentials.", false)
		expect(r.intent).toBe("blocked-external")
		expect(r.shouldContinue).toBe(false)
	})

	test("waiting on user → blocked-human, stop", () => {
		const r = classifyIntent("Which approach would you like me to take?", false)
		expect(r.intent).toBe("blocked-human")
		expect(r.shouldContinue).toBe(false)
	})

	test("pending question tool → blocked-question, stop", () => {
		const r = classifyIntent("Awaiting your answer to the question.", false)
		expect(r.intent).toBe("blocked-question")
		expect(r.shouldContinue).toBe(false)
	})

	test("plan with pending todos → planning, continue", () => {
		const r = classifyIntent("Here's the plan: first I'll set up the schema, then wire the routes.", false, pendingTodos)
		expect(r.intent).toBe("planning")
		expect(r.shouldContinue).toBe(true)
	})

	test("plan with no todos → planning, do not continue", () => {
		const r = classifyIntent("Here's my plan for the refactor.", false, [])
		expect(r.intent).toBe("planning")
		expect(r.shouldContinue).toBe(false)
	})

	test("short answer-only → answer, stop", () => {
		const r = classifyIntent("Yes, that file lives in src/index.ts.", false)
		expect(r.intent).toBe("answer")
		expect(r.shouldContinue).toBe(false)
	})

	test("reporting completed work → completed, stop", () => {
		const r = classifyIntent("I've implemented the parser and added tests for every branch of the grammar.", false)
		expect(r.intent).toBe("completed")
		expect(r.shouldContinue).toBe(false)
	})
})
