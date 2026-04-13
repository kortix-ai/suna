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
		test("switches persistent mode, exposes tools, and compresses files", async () => {
			const mod = await import(new URL("../../opencode/plugin/opencode-caveman-plugin/opencode-caveman-plugin.ts?e2e=" + Date.now(), import.meta.url).href)
			const plugin = await mod.default({})
			const hooks = plugin.tool ?? {}
			const call = ctx()

			expect(Object.keys(hooks)).toEqual(expect.arrayContaining(["caveman_mode", "caveman_compress"]))
			expect(plugin["command.execute.before"]).toBeUndefined()

			const activate = { parts: [{ type: "text", text: "talk like caveman ultra" }] as Array<any> }
			await plugin["chat.message"]({ sessionID: call.sessionID }, activate)
			expect(activate.parts[0]?.text).toContain("Caveman mode set to ultra")

			const system = { system: [] as string[] }
			await plugin["experimental.chat.system.transform"]({ sessionID: call.sessionID }, system)
		expect(system.system.join("\n")).toContain("CAVEMAN ULTRA ACTIVE")

		const state = await hooks.caveman_mode.execute({ action: "get" }, call)
		expect(state).toContain('"mode": "ultra"')

		const note = join(call.directory, "CLAUDE.md")
		await Bun.write(note, "You should always make sure to run tests before pushing.\n\n```sh\npnpm test\n```\n")
			const result = await hooks.caveman_compress.execute({ file_path: note }, call)
			expect(result).toContain('"saved_percent"')
			expect(await Bun.file(join(call.directory, "CLAUDE.original.md")).exists()).toBe(true)

			const compressRewrite = { parts: [{ type: "text", text: "/caveman:compress CLAUDE.md" }] as Array<any> }
			await plugin["chat.message"]({ sessionID: call.sessionID }, compressRewrite)
			expect(compressRewrite.parts[0]?.text).toContain("Use caveman_compress on CLAUDE.md")

			const clear = { parts: [{ type: "text", text: "stop caveman" }] }
			await plugin["chat.message"]({ sessionID: call.sessionID }, clear)
		const after = { system: [] as string[] }
		await plugin["experimental.chat.system.transform"]({ sessionID: call.sessionID }, after)
		expect(after.system).toHaveLength(0)
	})

		test("opencode config wires only the caveman plugin", async () => {
			const file = await Bun.file(new URL("../../opencode/opencode.jsonc", import.meta.url)).text()
			expect(file).not.toContain('"command"')
			expect(file).toContain('./plugin/opencode-caveman-plugin/opencode-caveman-plugin.ts')
		})
	})
