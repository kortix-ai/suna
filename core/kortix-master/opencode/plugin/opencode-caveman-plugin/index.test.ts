import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compressFile } from "./compress"
import { parseNatural } from "./parse"

describe("caveman parse", () => {
	test("parses slash mode change with remainder", () => {
		expect(parseNatural("/caveman ultra explain auth"))
			.toEqual({ type: "set", mode: "ultra", rest: "explain auth" })
	})

	test("parses natural stop with remainder", () => {
		expect(parseNatural("stop caveman, explain normally"))
			.toEqual({ type: "clear", rest: "explain normally" })
	})

	test("parses compress shortcut", () => {
		expect(parseNatural("/caveman:compress CLAUDE.md"))
			.toEqual({ type: "compress", path: "CLAUDE.md" })
	})
})

describe("caveman compress", () => {
	test("backs up file and preserves code fences", async () => {
		const dir = mkdtempSync(join(tmpdir(), "caveman-compress-"))
		const file = join(dir, "notes.md")
		const src = [
			"# Notes",
			"",
			"You should always make sure to run the test suite before pushing changes.",
			"",
			"```ts",
			"const value = 1",
			"```",
		].join("\n")
		await Bun.write(file, src)

		const result = await compressFile(file, dir)
		const next = await Bun.file(file).text()
		const bak = await Bun.file(result.backup).text()

		expect(bak).toBe(src)
		expect(next).toContain("# Notes")
		expect(next).toContain("```ts\nconst value = 1\n```")
		expect(result.chars_after).toBeLessThan(result.chars_before)
	})
})
