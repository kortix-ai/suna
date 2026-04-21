import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compressFile } from "./compress"

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
