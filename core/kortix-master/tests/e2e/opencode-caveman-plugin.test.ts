import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function ctx(sessionID = "ses_caveman") {
	return {
		sessionID,
		messageID: "msg_caveman",
		directory: mkdtempSync(join(tmpdir(), "caveman-session-")),
		worktree: "/workspace",
	}
}

	describe("opencode caveman plugin", () => {
		test("keeps defaults invisible, exposes tools, and compresses files", async () => {
			const mod = await import(new URL("../../opencode/plugin/opencode-caveman-plugin/opencode-caveman-plugin.ts?e2e=" + Date.now(), import.meta.url).href)
			const plugin = await mod.default({}, {
				default_mode: "full",
				agent_modes: {
					general: "full",
				},
			})
			const hooks = plugin.tool ?? {}
			const call = ctx()

			expect(Object.keys(hooks)).toEqual(expect.arrayContaining(["caveman_mode", "caveman_compress"]))
			expect(plugin["command.execute.before"]).toBeUndefined()

			const plain = { parts: [{ type: "text", text: "explain auth" }] as Array<any> }
			await plugin["chat.message"]({ sessionID: call.sessionID, agent: "general" }, plain)
			expect(plain.parts[0]?.text).toBe("explain auth")

			const system = { system: [] as string[] }
			await plugin["experimental.chat.system.transform"]({ sessionID: call.sessionID }, system)
			expect(system.system.join("\n")).toContain("CAVEMAN FULL ACTIVE")

			const state = await hooks.caveman_mode.execute({ action: "get" }, call)
			expect(state).toContain('"effective_mode": "full"')

			const note = join(call.directory, "CLAUDE.md")
			await Bun.write(note, "You should always make sure to run tests before pushing.\n\n```sh\npnpm test\n```\n")
			const result = await hooks.caveman_compress.execute({ file_path: note }, call)
			expect(result).toContain('"saved_percent"')
			expect(await Bun.file(join(call.directory, "CLAUDE.original.md")).exists()).toBe(true)
		})

		test("auto-enables configured defaults and clear remains tool-only + sticky", async () => {
			const mod = await import(new URL("../../opencode/plugin/opencode-caveman-plugin/opencode-caveman-plugin.ts?defaults=" + Date.now(), import.meta.url).href)
			const plugin = await mod.default({}, {
				default_mode: "full",
				agent_modes: {
					worker: "ultra",
					orchestrator: "lite",
				},
			})

			const fallback = { system: [] as string[] }
			await plugin["experimental.chat.system.transform"]({ sessionID: "ses_fallback" }, fallback)
			expect(fallback.system.join("\n")).toContain("CAVEMAN FULL ACTIVE")

			const workerMessage = { parts: [{ type: "text", text: "build auth" }] as Array<any> }
			await plugin["chat.message"]({ sessionID: "ses_worker", agent: "worker" }, workerMessage)
			expect(workerMessage.parts[0]?.text).toBe("build auth")

			const workerSystem = { system: [] as string[] }
			await plugin["experimental.chat.system.transform"]({ sessionID: "ses_worker" }, workerSystem)
			expect(workerSystem.system.join("\n")).toContain("CAVEMAN ULTRA ACTIVE")

			const stateBefore = await plugin.tool?.caveman_mode.execute({ action: "get" }, { ...ctx("ses_worker"), agent: "worker" })
			expect(stateBefore).toContain('"effective_mode": "ultra"')

			const clear = await plugin.tool?.caveman_mode.execute({ action: "clear" }, { ...ctx("ses_worker"), agent: "worker" })
			expect(clear).toContain('"disabled": true')

			const afterOff = { parts: [{ type: "text", text: "keep going" }] as Array<any> }
			await plugin["chat.message"]({ sessionID: "ses_worker", agent: "worker" }, afterOff)
			expect(afterOff.parts[0]?.text).toBe("keep going")

			const stillOff = { system: [] as string[] }
			await plugin["experimental.chat.system.transform"]({ sessionID: "ses_worker" }, stillOff)
			expect(stillOff.system).toHaveLength(0)
		})

		test("opencode config wires only the caveman plugin", async () => {
			const file = await Bun.file(new URL("../../opencode/opencode.jsonc", import.meta.url)).text()
			expect(file).not.toContain('"command"')
			expect(file).toContain('./plugin/opencode-caveman-plugin/opencode-caveman-plugin.ts')
			expect(file).toContain('"default_mode": "full"')
			expect(file).toContain('"general": "full"')
			expect(file).toContain('"worker": "ultra"')
		})
	})
