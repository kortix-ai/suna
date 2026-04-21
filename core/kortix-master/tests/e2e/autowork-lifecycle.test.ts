import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { clearAllStartupAbortedSessions } from "../../opencode/plugin/kortix-system/lib/startup-aborted-sessions"
import {
	assistantMessage,
	completedTool,
	createAutoworkHarness,
	validCompletion,
	validPlan,
	validVerified,
} from "./helpers/autowork-harness"

const tempRoots: string[] = []
const originalStorageBase = process.env.OPENCODE_STORAGE_BASE

afterEach(() => {
	if (originalStorageBase === undefined) delete process.env.OPENCODE_STORAGE_BASE
	else process.env.OPENCODE_STORAGE_BASE = originalStorageBase
	clearAllStartupAbortedSessions()
	for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStorage(): string {
	const root = mkdtempSync(path.join(tmpdir(), "kortix-autowork-e2e-"))
	tempRoots.push(root)
	const storageBase = path.join(root, ".local", "share", "opencode")
	mkdirSync(storageBase, { recursive: true })
	return storageBase
}

function completedTodo(content = "ship the approved plan") {
	return { id: `todo-${content}`, content, status: "completed", priority: "high" }
}

describe("autowork lifecycle e2e", () => {
	test("enters planning first and does not execute without an approved plan", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_plan_first", `e2e-plan-first-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage("Thinking about it.")])

		await harness.idle()

		expect(harness.prompts).toHaveLength(1)
		expect(harness.prompts[0]?.text).toContain("planning phase")
		expect(harness.prompts[0]?.text).toContain("<kortix_autowork_plan>")
		expect(harness.loadState()?.phase).toBe("planning")
	})

	test("valid plan transitions the loop into execution", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_plan_approve", `e2e-plan-approve-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage(validPlan())])

		await harness.idle()

		expect(harness.prompts).toHaveLength(1)
		expect(harness.prompts[0]?.text).toContain("Planning is complete")
		expect(harness.prompts[0]?.text).toContain("<kortix_autowork_plan>")
		expect(harness.loadState()?.phase).toBe("execution")
	})

	test("rejects immediate completion with no approved plan and no work signals", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_no_work", `e2e-no-work-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage(validCompletion())])

		await harness.idle()

		expect(harness.prompts).toHaveLength(1)
		expect(harness.prompts[0]?.text).toContain("<kortix_autowork_plan>")
		expect(harness.isActive()).toBe(true)
		expect(harness.loadState()?.phase).toBe("planning")
	})

	test("rejects completion while unfinished native todos remain", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_pending_todos", `e2e-pending-todos-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage(validPlan())])
		await harness.idle()

		harness.setTodos([{ id: "todo-1", content: "write regression test", status: "pending", priority: "high" }])
		harness.setMessages([
			assistantMessage(validPlan()),
			assistantMessage(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])

		await harness.idleAfterCooldown()

		expect(harness.prompts).toHaveLength(2)
		expect(harness.prompts[1]?.text).toContain("unfinished native todo items remain")
		expect(harness.prompts[1]?.text).toContain("write regression test")
		expect(harness.isActive()).toBe(true)
	})

	test("rejects completion when verification went stale after a later edit", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_stale_verification", `e2e-stale-verification-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage(validPlan())])
		await harness.idle()
		harness.setTodos([completedTodo()])

		harness.setMessages([
			assistantMessage(validPlan()),
			assistantMessage("Ran final tests once.", [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
			assistantMessage("Made one more code tweak.", [completedTool("edit", { filePath: "src/auth.ts" }, "patched")]),
			assistantMessage(validCompletion()),
		])

		await harness.idleAfterCooldown()

		expect(harness.prompts).toHaveLength(2)
		expect(harness.prompts[1]?.text).toContain("verification stale after newer code changes")
		expect(harness.isActive()).toBe(true)
	})

	test("moves into verifier phase after a valid completion candidate", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_verifier_phase", `e2e-verifier-phase-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage(validPlan())])
		await harness.idle()
		harness.setTodos([completedTodo()])

		harness.setMessages([
			assistantMessage(validPlan()),
			assistantMessage(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])

		await harness.idleAfterCooldown()

		expect(harness.prompts).toHaveLength(2)
		expect(harness.prompts[1]?.text).toContain("verifier phase")
		expect(harness.prompts[1]?.text).toContain("<kortix_autowork_verified>")
		expect(harness.isActive()).toBe(true)
		expect(harness.loadState()?.phase).toBe("verifying")
	})

	test("accepts completion only after planning, execution, and verifier pass", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_complete", `e2e-complete-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage(validPlan())])
		await harness.idle()

		harness.setTodos([completedTodo()])
		harness.setMessages([
			assistantMessage(validPlan()),
			assistantMessage(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])
		await harness.idleAfterCooldown()

		harness.setMessages([
			assistantMessage(validPlan()),
			assistantMessage(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
			assistantMessage(validVerified(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])

		await harness.idleAfterCooldown()

		expect(harness.prompts).toHaveLength(2)
		expect(harness.isActive()).toBe(false)
		expect(harness.loadState()?.active).toBe(false)
		expect(harness.loadState()?.stopReason).toBe("complete")
	})

	test("rejects verifier tags that do not rerun verification commands in the verifier message", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_verifier_reject", `e2e-verifier-reject-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage(validPlan())])
		await harness.idle()
		harness.setTodos([completedTodo()])

		harness.setMessages([
			assistantMessage(validPlan()),
			assistantMessage(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])
		await harness.idleAfterCooldown()

		harness.setMessages([
			assistantMessage(validPlan()),
			assistantMessage(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
			assistantMessage(validVerified()),
		])

		await harness.idleAfterCooldown()

		expect(harness.prompts).toHaveLength(3)
		expect(harness.prompts[2]?.text).toContain("verification commands not backed by completed bash runs")
		expect(harness.isActive()).toBe(true)
		expect(harness.loadState()?.phase).toBe("verifying")
	})

	test("requires native todo tracking before execution continues", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_e2e_require_todos", `e2e-require-todos-${Date.now()}`)
		await harness.sendUser("/autowork fix the bug")
		harness.setMessages([assistantMessage(validPlan())])
		await harness.idle()

		harness.setMessages([
			assistantMessage(validPlan()),
			assistantMessage("Starting implementation."),
		])

		await harness.idleAfterCooldown()

		expect(harness.prompts).toHaveLength(2)
		expect(harness.prompts[1]?.text).toContain("Native todo tracking is required")
		expect(harness.isActive()).toBe(true)
	})

	test("manual session abort stops autowork and prevents follow-up continuation", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createAutoworkHarness("ses_autowork_lifecycle_e2e", `e2e-abort-${Date.now()}`)
		await harness.sendUser("/autowork fix the lifecycle bug")

		expect(harness.isActive()).toBe(true)
		expect(harness.loadState()?.active).toBe(true)

		await harness.abort()

		harness.setMessages([assistantMessage("still working")])
		await harness.idle()

		expect(harness.prompts).toHaveLength(0)
		expect(harness.isActive()).toBe(false)
		expect(harness.loadState()).toBeNull()
	})
})
