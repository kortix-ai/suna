import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

function normalizeAbsolutePath(input: string): string {
	return isAbsolute(input) ? input : resolve(input)
}

function findWorkspaceRoot(startDir: string): string | null {
	let current = normalizeAbsolutePath(startDir)
	while (true) {
		if (existsSync(join(current, ".git"))) return current
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

export function resolveKortixWorkspaceRoot(anchorDir?: string): string {
	const explicitWorkspace = process.env.KORTIX_WORKSPACE?.trim()
	if (explicitWorkspace) return normalizeAbsolutePath(explicitWorkspace)

	const explicitWorkspaceDir = process.env.WORKSPACE_DIR?.trim() || process.env.KORTIX_WORKSPACE_ROOT?.trim()
	if (explicitWorkspaceDir) return normalizeAbsolutePath(explicitWorkspaceDir)

	const storageBase = process.env.OPENCODE_STORAGE_BASE?.trim()
	if (storageBase) return resolve(normalizeAbsolutePath(storageBase), "..", "..", "..")

	const configDir = process.env.OPENCODE_CONFIG_DIR?.trim()
	if (configDir) {
		const normalizedConfigDir = normalizeAbsolutePath(configDir)
		if (normalizedConfigDir.endsWith(`${sep}.opencode`) || normalizedConfigDir.endsWith(`${sep}opencode`)) {
			return dirname(normalizedConfigDir)
		}
	}

	// Production Kortix instances are single-workspace sandboxes rooted at
	// /workspace. Prefer that over repo discovery whenever it exists so no
	// session accidentally becomes scoped to a source checkout or nested folder.
	if (existsSync("/workspace")) return "/workspace"

	const anchor = anchorDir?.trim() || process.cwd()
	const repoRoot = findWorkspaceRoot(anchor)
	if (repoRoot) return repoRoot

	const home = process.env.HOME?.trim() || homedir()
	return normalizeAbsolutePath(home)
}

export function resolveKortixDir(anchorDir?: string): string {
	const explicitDir = process.env.KORTIX_DIR?.trim()
	if (explicitDir) return normalizeAbsolutePath(explicitDir)
	return join(resolveKortixWorkspaceRoot(anchorDir), ".kortix")
}

export function ensureKortixDir(anchorDir?: string): string {
	const kortixDir = resolveKortixDir(anchorDir)
	mkdirSync(kortixDir, { recursive: true })
	return kortixDir
}

function ensureFile(filePath: string, content: string): string {
	if (!existsSync(filePath)) writeFileSync(filePath, content, "utf8")
	return filePath
}

/**
 * Ensure global USER.md + MEMORY.md exist at the workspace root .kortix/ directory.
 * Deeper notes can live in .kortix/memory/*.md and be referenced from MEMORY.md.
 */
export function ensureGlobalMemoryFiles(anchorDir?: string): { userPath: string; memoryPath: string; memoryDir: string } {
	const kortixDir = ensureKortixDir(anchorDir)
	const memoryDir = join(kortixDir, "memory")
	mkdirSync(memoryDir, { recursive: true })
	return {
		userPath: ensureFile(join(kortixDir, "USER.md"), [
			"# User Profile",
			"",
			"## Preferences",
			"",
			"## Communication Style",
			"",
			"## Workflow Habits",
			"",
		].join("\n")),
		memoryPath: ensureFile(join(kortixDir, "MEMORY.md"), [
			"# Global Memory",
			"",
			"Keep this file concise. Put deeper notes in `.kortix/memory/*.md` and reference them here.",
			"",
			"## Environment",
			"",
			"## Stack",
			"",
			"## Accounts",
			"",
			"## References",
			"",
		].join("\n")),
		memoryDir,
	}
}

function readIfExists(filePath: string): string {
	if (!existsSync(filePath)) return ""
	try {
		return readFileSync(filePath, "utf8").trim()
	} catch {
		return ""
	}
}

function normalizeMemoryBody(text: string): string[] {
	const lines = text.split(/\r?\n/).map(line => line.trimEnd())
	const out: string[] = []
	let sectionHeading: string | null = null
	let sectionContent: string[] = []

	const flush = () => {
		if (sectionHeading && sectionContent.length > 0) {
			out.push(sectionHeading)
			out.push(...sectionContent)
		}
		sectionHeading = null
		sectionContent = []
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!
		if (i === 0 && line.startsWith("# ")) continue
		if (line.startsWith("## ")) {
			flush()
			sectionHeading = line
			continue
		}
		if (!line.trim()) continue
		sectionContent.push(line)
	}
	flush()
	return out
}

/**
 * Render global memory context from USER.md + MEMORY.md.
 * Global workspace context is handled separately and injected for every session.
 */
export function renderMergedMemoryContext(anchorDir?: string): string {
	const globalFiles = ensureGlobalMemoryFiles(anchorDir)

	const blocks = [
		{ label: "User", lines: normalizeMemoryBody(readIfExists(globalFiles.userPath)) },
		{ label: "Memory", lines: normalizeMemoryBody(readIfExists(globalFiles.memoryPath)) },
	]

	const rendered: string[] = []
	for (const block of blocks) {
		const nonEmpty = block.lines.filter(line => line.trim())
		if (nonEmpty.length === 0) continue
		rendered.push(`## ${block.label}`)
		rendered.push(...nonEmpty)
		rendered.push("")
	}

	return rendered.join("\n").trim()
}

export function renderProjectContext(projectPath: string): string {
	const ctxPath = join(projectPath, ".kortix", "CONTEXT.md")
	const raw = readIfExists(ctxPath)
	if (!raw) return ""
	const lines = normalizeMemoryBody(raw)
	if (lines.length === 0) return ""
	return ["## Workspace", ...lines].join("\n")
}
