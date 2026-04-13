import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function getOpencodeStorageBase(): string {
	const explicit = process.env.OPENCODE_STORAGE_BASE?.trim()
	if (explicit) return explicit

	const persistentRoot = process.env.KORTIX_PERSISTENT_ROOT?.trim()
	if (persistentRoot) return join(persistentRoot, "opencode")

	if (existsSync("/persistent/opencode")) return "/persistent/opencode"
	if (existsSync("/workspace/.local/share/opencode")) return "/workspace/.local/share/opencode"
	return join(homedir(), ".local", "share", "opencode")
}

export function getOpencodeDbPath(): string {
	return join(getOpencodeStorageBase(), "opencode.db")
}

export function getOpencodeStoragePath(...parts: string[]): string {
	return join(getOpencodeStorageBase(), ...parts)
}
