import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { clearAllStartupAbortedSessions, markStartupAbortedSession } from "../lib/startup-aborted-sessions"

const tempRoots: string[] = []
const originalStorageBase = process.env.OPENCODE_STORAGE_BASE

afterEach(() => {
	if (originalStorageBase === undefined) delete process.env.OPENCODE_STORAGE_BASE
	else process.env.OPENCODE_STORAGE_BASE = originalStorageBase
	clearAllStartupAbortedSessions()
	for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStorage(): string {
	const root = mkdtempSync(path.join(tmpdir(), "kortix-goal-test-"))
	tempRoots.push(root)
	const storageBase = path.join(root, ".local", "share", "opencode")
	mkdirSync(storageBase, { recursive: true })
	return storageBase
}

function assistant(text: string) {
	return { info: { role: "assistant" }, parts: [{ type: "text", text }] }
}

function assistantWithParts(text: string, parts: any[] = []) {
	return { info: { role: "assistant" }, parts: [{ type: "text", text }, ...parts] }
}

function completedTool(tool: string, input: any = {}, output: any = "ok") {
	return { type: "tool", tool, state: { status: "completed", input, output } }
}

function makeClient(messages: Map<string, any[]>, prompts: Array<{ sessionId: string; text: string }>) {
	return {
		app: { log: async () => {} },
		session: {
			messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
			promptAsync: async ({ path, body }: any) => {
				prompts.push({ sessionId: path.id, text: body.parts[0].text })
			},
		},
	} as any
}

async function activateGoal(plugin: any, sessionId: string, command = "/goal fix the auth bug") {
	await plugin["chat.message"]({ sessionID: sessionId }, { parts: [{ type: "text", text: command }] })
}

async function idleWithCooldown(plugin: any, stateMod: any, sessionId: string) {
	const state = stateMod.loadGoalState(sessionId)
	const realNow = Date.now
	const targetNow = Math.max(realNow(), (state?.lastInjectedAt ?? realNow()) + 4_000)
	Date.now = () => targetNow
	try {
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
	} finally {
		Date.now = realNow
	}
}

describe("Goal plugin integration", () => {
	test("/goal starts a persistent objective and continues on idle", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./goal.ts?goal-start=${Date.now()}`)
		const stateMod = await import(`./state.ts?goal-start=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_goal_start"

		messages.set(sessionId, [])
		await activateGoal(plugin, sessionId, "/goal repair config e2e")
		messages.set(sessionId, [assistant("I will inspect the config.")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.text).toContain("Continue working toward the active thread goal")
		expect(prompts[0]?.text).toContain("repair config e2e")
		expect(prompts[0]?.text).toContain("update_goal")
		expect(stateMod.loadGoalState(sessionId)?.status).toBe("active")
		expect(pluginMod.goalActiveSessions.has(sessionId)).toBe(true)
	})

	test("valid update_goal completion marks the goal complete", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./goal.ts?goal-complete=${Date.now()}`)
		const stateMod = await import(`./state.ts?goal-complete=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_goal_complete"

		messages.set(sessionId, [])
		await activateGoal(plugin, sessionId)
		messages.set(sessionId, [
			assistantWithParts("Patched and verified.", [
				completedTool("edit", { filePath: "src/auth.ts" }, "patched"),
				completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed"),
				completedTool("update_goal", { status: "complete" }, "Completion requested"),
			]),
		])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(stateMod.loadGoalState(sessionId)?.status).toBe("complete")
		expect(stateMod.loadGoalState(sessionId)?.stopReason).toBe("complete")
		expect(pluginMod.goalActiveSessions.has(sessionId)).toBe(false)
	})

	test("invalid update_goal completion continues with rejection prompt", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./goal.ts?goal-reject=${Date.now()}`)
		const stateMod = await import(`./state.ts?goal-reject=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_goal_reject"

		messages.set(sessionId, [])
		await activateGoal(plugin, sessionId)
		messages.set(sessionId, [
			assistantWithParts("Patched, done.", [
				completedTool("edit", { filePath: "src/auth.ts" }, "patched"),
				completedTool("update_goal", { status: "complete" }, "Completion requested"),
			]),
		])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.text).toContain("REJECTED")
		expect(prompts[0]?.text).toContain("missing same-turn final verification")
		expect(stateMod.loadGoalState(sessionId)?.status).toBe("active")
		expect(pluginMod.goalActiveSessions.has(sessionId)).toBe(true)
	})

	test("/goal pause and /goal resume control continuation", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./goal.ts?goal-pause-resume=${Date.now()}`)
		const stateMod = await import(`./state.ts?goal-pause-resume=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_goal_pause_resume"

		messages.set(sessionId, [])
		await activateGoal(plugin, sessionId)
		await activateGoal(plugin, sessionId, "/goal pause")
		messages.set(sessionId, [assistant("Idle while paused")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
		expect(prompts).toHaveLength(0)
		expect(stateMod.loadGoalState(sessionId)?.status).toBe("paused")

		await activateGoal(plugin, sessionId, "/goal resume")
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
		expect(prompts).toHaveLength(1)
		expect(stateMod.loadGoalState(sessionId)?.status).toBe("active")
	})

	test("/goal clear removes persisted state", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./goal.ts?goal-clear=${Date.now()}`)
		const stateMod = await import(`./state.ts?goal-clear=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_goal_clear"

		messages.set(sessionId, [])
		await activateGoal(plugin, sessionId)
		await activateGoal(plugin, sessionId, "/goal clear")

		expect(stateMod.loadGoalState(sessionId)).toBeNull()
		expect(pluginMod.goalActiveSessions.has(sessionId)).toBe(false)
	})

	test("max iterations stops the goal with failed reason", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./goal.ts?goal-maxiter=${Date.now()}`)
		const stateMod = await import(`./state.ts?goal-maxiter=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_goal_maxiter"

		messages.set(sessionId, [])
		await activateGoal(plugin, sessionId, "/goal --max-iterations 1 fix it")
		messages.set(sessionId, [assistant("Still working")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
		expect(prompts).toHaveLength(1)

		messages.set(sessionId, [assistant("Still working"), assistant("Still working more")])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(stateMod.loadGoalState(sessionId)?.status).toBe("paused")
		expect(stateMod.loadGoalState(sessionId)?.stopReason).toBe("failed")
		expect(pluginMod.goalActiveSessions.has(sessionId)).toBe(false)
	})

	test("model-facing goal tools create, read, and request completion", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./goal.ts?goal-tools=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_goal_tools"

		messages.set(sessionId, [])
		const created = await plugin.tool.create_goal.execute({ objective: "ship the goal tools", token_budget: 1000 }, { sessionID: sessionId })
		const fetched = await plugin.tool.get_goal.execute({}, { sessionID: sessionId })
		const duplicate = await plugin.tool.create_goal.execute({ objective: "second goal" }, { sessionID: sessionId })
		const completion = await plugin.tool.update_goal.execute({ status: "complete" }, { sessionID: sessionId })

		expect(created).toContain("ship the goal tools")
		expect(fetched).toContain("Status: active")
		expect(duplicate).toContain("already has a goal")
		expect(completion).toContain("Completion requested")
	})

	test("session.aborted pauses goal without deleting it", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./goal.ts?goal-abort=${Date.now()}`)
		const stateMod = await import(`./state.ts?goal-abort=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_goal_abort"

		messages.set(sessionId, [])
		await activateGoal(plugin, sessionId)
		await plugin.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })

		expect(stateMod.loadGoalState(sessionId)?.status).toBe("paused")
		expect(pluginMod.goalActiveSessions.has(sessionId)).toBe(false)
	})

	test("startup-aborted sessions do not resume persisted goals", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const sessionId = "ses_goal_startup_abort"
		const stateMod = await import(`./state.ts?goal-startup-state=${Date.now()}`)
		stateMod.startGoal("fix the zombie session", sessionId, 0)
		markStartupAbortedSession(sessionId)

		const pluginMod = await import(`./goal.ts?goal-startup-abort=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		messages.set(sessionId, [assistant("Still working")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(pluginMod.goalActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadGoalState(sessionId)).toBeNull()
	})
})
