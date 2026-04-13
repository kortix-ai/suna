import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { clearAllStartupAbortedSessions } from "../../opencode/plugin/kortix-system/lib/startup-aborted-sessions"

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

function assistant(text: string) {
	return { info: { role: "assistant" }, parts: [{ type: "text", text }] }
}

describe("autowork lifecycle e2e", () => {
	test("manual session abort stops autowork and prevents follow-up continuation", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()

		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const autoworkMod = await import(`../../opencode/plugin/kortix-system/autowork/autowork.ts?autowork-e2e=${Date.now()}`)
		const stateMod = await import(`../../opencode/plugin/kortix-system/autowork/state.ts?autowork-e2e=${Date.now()}`)
		const todoMod = await import(`../../opencode/plugin/kortix-system/todo-enforcer/todo-enforcer.ts?autowork-e2e=${Date.now()}`)

		const client = {
			app: { log: async () => {} },
			session: {
				messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
				todo: async () => ({ data: [{ id: "todo-1", content: "fix it", status: "pending", priority: "high" }] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const autowork = await autoworkMod.default({ client })
		const todoEnforcer = await todoMod.default({ client })
		const sessionId = "ses_autowork_lifecycle_e2e"

		messages.set(sessionId, [])
		await autowork["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork fix the lifecycle bug" }] },
		)

		expect(autoworkMod.autoworkActiveSessions.has(sessionId)).toBe(true)
		expect(stateMod.loadAutoworkState(sessionId)?.active).toBe(true)

		await autowork.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })
		await todoEnforcer.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })

		messages.set(sessionId, [assistant("still working")])
		await autowork.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
		await todoEnforcer.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(autoworkMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)).toBeNull()
	})
})
