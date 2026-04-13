import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { clearAllStartupAbortedSessions, markStartupAbortedSession } from "../lib/startup-aborted-sessions"
import { COMPLETION_TAG } from "./config"

const tempRoots: string[] = []
const originalStorageBase = process.env.OPENCODE_STORAGE_BASE

afterEach(() => {
	if (originalStorageBase === undefined) delete process.env.OPENCODE_STORAGE_BASE
	else process.env.OPENCODE_STORAGE_BASE = originalStorageBase
	clearAllStartupAbortedSessions()
	for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStorage(): string {
	const root = mkdtempSync(path.join(tmpdir(), "kortix-autowork-test-"))
	tempRoots.push(root)
	const storageBase = path.join(root, ".local", "share", "opencode")
	mkdirSync(storageBase, { recursive: true })
	return storageBase
}

function assistant(text: string) {
	return { info: { role: "assistant" }, parts: [{ type: "text", text }] }
}

function validCompletion(): string {
	return [
		"All done. Here is the completion contract:",
		"",
		`<${COMPLETION_TAG}>`,
		"  <verification>",
		"    $ bun test tests/auth.test.ts",
		"    [exit 0] 12 passed",
		"  </verification>",
		"  <requirements_check>",
		'    - [x] "fix the bug" — patched src/auth.ts:47, regression test added',
		"  </requirements_check>",
		`</${COMPLETION_TAG}>`,
	].join("\n")
}

describe("Autowork plugin integration", () => {
	test("continues on idle and stops on a valid completion tag", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-test=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-test=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const plugin = await pluginFactory({ client })
		const sessionId = "ses_autowork_1"

		messages.set(sessionId, [])

		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork fix the bug" }] },
		)

		// First idle — worker hasn't emitted anything useful yet, continue.
		messages.set(sessionId, [assistant("Investigating root cause of the bug")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts.length).toBe(1)
		expect(prompts[0]?.text).toContain("Iteration 1/50")
		expect(prompts[0]?.text).toContain("fix the bug") // re-anchored original task

		// Second idle after worker emits a valid completion tag → stop.
		messages.set(sessionId, [assistant(validCompletion())])
		await new Promise((resolve) => setTimeout(resolve, 3100))
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		const persisted = stateMod.loadAutoworkState(sessionId)
		expect(persisted?.active).toBe(false)
		expect(persisted?.stopReason).toBe("complete")
	})

	test("rejects completion with unchecked requirement item", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-reject=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const plugin = await pluginFactory({ client })
		const sessionId = "ses_autowork_reject"

		messages.set(sessionId, [])
		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork build feature" }] },
		)

		const halfDone = [
			`<${COMPLETION_TAG}>`,
			"  <verification>ran tests — partial</verification>",
			"  <requirements_check>",
			'    - [x] "build the endpoint" — done',
			'    - [ ] "write tests" — still todo',
			"  </requirements_check>",
			`</${COMPLETION_TAG}>`,
		].join("\n")

		messages.set(sessionId, [assistant(halfDone)])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts.length).toBe(1)
		expect(prompts[0]?.text).toContain("REJECTED")
		expect(prompts[0]?.text).toContain("unchecked requirement item")
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(true)
	})

	test("re-anchors user follow-up messages in the next continuation", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-followup=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const plugin = await pluginFactory({ client })
		const sessionId = "ses_autowork_followup"

		messages.set(sessionId, [])
		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork add auth middleware" }] },
		)

		// User sends a follow-up mid-loop with additional requirements.
		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "Also make sure it handles expired tokens with a 401." }] },
		)

		messages.set(sessionId, [assistant("Working on it.")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts.length).toBe(1)
		// Both the original task and the follow-up must appear in the re-anchored request block.
		expect(prompts[0]?.text).toContain("add auth middleware")
		expect(prompts[0]?.text).toContain("expired tokens with a 401")
	})

	test("max iterations stops the loop with failed reason", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-maxiter=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-maxiter=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const plugin = await pluginFactory({ client })
		const sessionId = "ses_autowork_maxiter"

		messages.set(sessionId, [])
		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork --max-iterations 1 fix it" }] },
		)

		messages.set(sessionId, [assistant("iteration 1 work")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
		expect(prompts.length).toBe(1)

		// Second idle should hit max iterations and stop.
		messages.set(sessionId, [assistant("iteration 1 work"), assistant("iteration 2 work")])
		await new Promise((resolve) => setTimeout(resolve, 3500))
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		// The plugin should have stopped with "failed" reason — verify via the
		// in-memory active set first (which the plugin always mutates), then via
		// the persisted state file.
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		const persisted = stateMod.loadAutoworkState(sessionId)
		expect(persisted).not.toBeNull()
		expect(persisted?.active).toBe(false)
		expect(persisted?.stopReason).toBe("failed")
	})

	test("startup-aborted sessions do not resume persisted autowork", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const sessionId = "ses_autowork_startup_abort"

		const stateMod = await import(`./state.ts?autowork-startup-state=${Date.now()}`)
		stateMod.startAutowork("fix the zombie session", sessionId, 0, 50)
		markStartupAbortedSession(sessionId)

		const pluginMod = await import(`./autowork.ts?autowork-startup-abort=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const plugin = await pluginFactory({ client })
		messages.set(sessionId, [assistant("Still working")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)).toBeNull()
	})

	test("does not activate autowork when a message merely mentions /autowork", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-mention=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const plugin = await pluginFactory({ client })
		const sessionId = "ses_autowork_mention"

		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "If you need to restart it later, use /autowork with a fresh task." }] },
		)

		messages.set(sessionId, [assistant("Still idle")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
	})

	test("ignores stale pending autowork commands instead of deriving garbage task text", async () => {
			process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-stale-pending=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const plugin = await pluginFactory({ client })
		const sessionId = "ses_autowork_stale_pending"

			await plugin["command.execute.before"]({
				command: "autowork",
				sessionID: sessionId,
				arguments: "",
			})
			const realNow = Date.now
			Date.now = () => realNow() + 16_000
			await plugin["chat.message"](
				{ sessionID: sessionId },
				{ parts: [{ type: "text", text: '<todo status="in_progress" priority="high">Inspect bug</todo>' }] },
			)
			Date.now = realNow

			messages.set(sessionId, [assistant("Still idle")])
			await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
	})

	test("session.aborted cancels autowork and removes persisted state", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const messages = new Map<string, any[]>()
		const pluginMod = await import(`./autowork.ts?autowork-abort-cancel=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-abort-cancel=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async () => {},
			},
		} as any

		const plugin = await pluginFactory({ client })
		const sessionId = "ses_autowork_abort_cancel"

		messages.set(sessionId, [])
		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork fix the bug" }] },
		)

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(true)
		expect(stateMod.loadAutoworkState(sessionId)?.active).toBe(true)

		await plugin.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)).toBeNull()
	})

	test("autowork-cancel clears persisted state even when in-memory state is inactive", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const messages = new Map<string, any[]>()
		const stateMod = await import(`./state.ts?autowork-cancel-persisted=${Date.now()}`)
		stateMod.startAutowork("fix the bug", "ses_autowork_cancel_persisted", 0, 50)

		const pluginMod = await import(`./autowork.ts?autowork-cancel-persisted=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				promptAsync: async () => {},
			},
		} as any

		const plugin = await pluginFactory({ client })
		const sessionId = "ses_autowork_cancel_persisted"

		await plugin.event({ event: { type: "session.deleted", properties: { sessionID: sessionId } } })
		stateMod.startAutowork("fix the bug", sessionId, 0, 50)

		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork-cancel" }] },
		)

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)).toBeNull()
	})
})
