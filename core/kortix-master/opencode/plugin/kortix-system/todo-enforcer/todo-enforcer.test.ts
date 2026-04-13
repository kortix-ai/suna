import { afterEach, describe, expect, test } from "bun:test"

import { clearAllStartupAbortedSessions, markStartupAbortedSession } from "../lib/startup-aborted-sessions"

function assistant(text: string) {
	return { info: { role: "assistant" }, parts: [{ type: "text", text }] }
}

function todo(overrides: Record<string, unknown> = {}) {
	return {
		id: "todo-1",
		content: "finish the implementation",
		status: "pending",
		priority: "medium",
		...overrides,
	}
}

afterEach(() => {
	clearAllStartupAbortedSessions()
})

	describe("todo-enforcer plugin integration", () => {
		test("startup-aborted sessions do not get continued", async () => {
		const prompts: Array<{ sessionId: string; text: string }> = []
		const sessionId = "ses_todo_startup_abort"
		markStartupAbortedSession(sessionId)

		const pluginMod = await import(`./todo-enforcer.ts?todo-startup-abort=${Date.now()}`)
		const pluginFactory = pluginMod.default

		const client = {
			app: { log: async () => {} },
			session: {
				todo: async () => ({ data: [todo()] }),
				messages: async () => ({ data: [assistant("Still working on it")] }),
				promptAsync: async ({ path, body }: any) => {
					prompts.push({ sessionId: path.id, text: body.parts[0].text })
				},
			},
		} as any

		const plugin = await pluginFactory({ client })
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

			expect(prompts).toHaveLength(0)
		})

		test("session.aborted disables further todo continuations", async () => {
			const prompts: Array<{ sessionId: string; text: string }> = []
			const sessionId = "ses_todo_aborted"

			const pluginMod = await import(`./todo-enforcer.ts?todo-aborted=${Date.now()}`)
			const pluginFactory = pluginMod.default

			const client = {
				app: { log: async () => {} },
				session: {
					todo: async () => ({ data: [todo()] }),
					messages: async () => ({ data: [assistant("Still working on it")] }),
					promptAsync: async ({ path, body }: any) => {
						prompts.push({ sessionId: path.id, text: body.parts[0].text })
					},
				},
			} as any

			const plugin = await pluginFactory({ client })
			await plugin.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })
			await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

			expect(prompts).toHaveLength(0)
		})
	})
