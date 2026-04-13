import { afterEach, describe, expect, test } from "bun:test"

const savedStorageBase = process.env.OPENCODE_STORAGE_BASE
const savedPersistentRoot = process.env.KORTIX_PERSISTENT_ROOT

afterEach(() => {
	if (savedStorageBase === undefined) delete process.env.OPENCODE_STORAGE_BASE
	else process.env.OPENCODE_STORAGE_BASE = savedStorageBase
	if (savedPersistentRoot === undefined) delete process.env.KORTIX_PERSISTENT_ROOT
	else process.env.KORTIX_PERSISTENT_ROOT = savedPersistentRoot
})

describe("opencode storage path helpers", () => {
	test("explicit OPENCODE_STORAGE_BASE wins", async () => {
		process.env.OPENCODE_STORAGE_BASE = "/tmp/opencode-explicit"
		delete process.env.KORTIX_PERSISTENT_ROOT
		const mod = await import(`./opencode-storage-paths.ts?explicit=${Date.now()}`)
		expect(mod.getOpencodeStorageBase()).toBe("/tmp/opencode-explicit")
		expect(mod.getOpencodeDbPath()).toBe("/tmp/opencode-explicit/opencode.db")
	})

	test("persistent root maps to /opencode storage dir", async () => {
		delete process.env.OPENCODE_STORAGE_BASE
		process.env.KORTIX_PERSISTENT_ROOT = "/tmp/kortix-persistent"
		const mod = await import(`./opencode-storage-paths.ts?persistent=${Date.now()}`)
		expect(mod.getOpencodeStorageBase()).toBe("/tmp/kortix-persistent/opencode")
		expect(mod.getOpencodeStoragePath("workspace", "abc")).toBe("/tmp/kortix-persistent/opencode/workspace/abc")
	})
})
