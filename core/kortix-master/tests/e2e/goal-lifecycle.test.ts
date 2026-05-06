import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { clearAllStartupAbortedSessions } from "../../opencode/plugin/kortix-system/lib/startup-aborted-sessions"
import { assistantMessage, completedTool, createGoalHarness } from "./helpers/goal-harness"

const tempRoots: string[] = []
const originalStorageBase = process.env.OPENCODE_STORAGE_BASE

afterEach(() => {
	if (originalStorageBase === undefined) delete process.env.OPENCODE_STORAGE_BASE
	else process.env.OPENCODE_STORAGE_BASE = originalStorageBase
	clearAllStartupAbortedSessions()
	for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStorage(): string {
	const root = mkdtempSync(path.join(tmpdir(), "kortix-goal-e2e-"))
	tempRoots.push(root)
	const storageBase = path.join(root, ".local", "share", "opencode")
	mkdirSync(storageBase, { recursive: true })
	return storageBase
}

describe("goal lifecycle e2e", () => {
	test("/goal continues on idle with objective re-anchored", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createGoalHarness("ses_goal_e2e_continue", `e2e-continue-${Date.now()}`)
		await harness.sendUser("/goal fix the bug")
		harness.setMessages([assistantMessage("Thinking about it.")])

		await harness.idle()

		expect(harness.prompts).toHaveLength(1)
		expect(harness.prompts[0]?.text).toContain("Continue working toward the active thread goal")
		expect(harness.prompts[0]?.text).toContain("fix the bug")
		expect(harness.prompts[0]?.text).toContain("update_goal")
		expect(harness.loadState()?.status).toBe("active")
		expect(harness.isActive()).toBe(true)
	})

	test("rejects update_goal when verification went stale after a later edit", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createGoalHarness("ses_goal_e2e_stale_verification", `e2e-stale-verification-${Date.now()}`)
		await harness.sendUser("/goal fix the bug")

		harness.setMessages([
			assistantMessage("Ran final tests once.", [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
			assistantMessage("Made one more code tweak.", [completedTool("edit", { filePath: "src/auth.ts" }, "patched")]),
			assistantMessage("Done.", [completedTool("update_goal", { status: "complete" }, "Completion requested")]),
		])

		await harness.idle()

		expect(harness.prompts).toHaveLength(1)
		expect(harness.prompts[0]?.text).toContain("missing same-turn final verification")
		expect(harness.isActive()).toBe(true)
		expect(harness.loadState()?.status).toBe("active")
	})

	test("accepts completion when update_goal is backed by same-turn final verification", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createGoalHarness("ses_goal_e2e_complete", `e2e-complete-${Date.now()}`)
		await harness.sendUser("/goal fix the bug")

		harness.setMessages([
			assistantMessage("Patched and verified.", [
				completedTool("edit", { filePath: "src/auth.ts" }, "patched"),
				completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed"),
				completedTool("update_goal", { status: "complete" }, "Completion requested"),
			]),
		])

		await harness.idle()

		expect(harness.prompts).toHaveLength(0)
		expect(harness.isActive()).toBe(false)
		expect(harness.loadState()?.status).toBe("complete")
		expect(harness.loadState()?.stopReason).toBe("complete")
	})

	test("budget-limited goals emit one wrap-up prompt and stop continuing", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createGoalHarness("ses_goal_e2e_budget", `e2e-budget-${Date.now()}`)
		await harness.sendUser("/goal --token-budget 1 fix the bug")
		harness.setMessages([{ info: { role: "assistant", tokens: { input: 2 } }, parts: [{ type: "text", text: "Using tokens" }] }])

		await harness.idle()

		expect(harness.prompts).toHaveLength(1)
		expect(harness.prompts[0]?.text).toContain("token budget")
		expect(harness.loadState()?.status).toBe("budget_limited")
		expect(harness.isActive()).toBe(false)
	})

	test("manual session abort pauses goal and prevents follow-up continuation", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const harness = await createGoalHarness("ses_goal_lifecycle_e2e", `e2e-abort-${Date.now()}`)
		await harness.sendUser("/goal fix the lifecycle bug")

		expect(harness.isActive()).toBe(true)
		expect(harness.loadState()?.status).toBe("active")

		await harness.abort()

		harness.setMessages([assistantMessage("still working")])
		await harness.idle()

		expect(harness.prompts).toHaveLength(0)
		expect(harness.isActive()).toBe(false)
		expect(harness.loadState()?.status).toBe("paused")
	})
})
