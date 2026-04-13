/**
 * OCX Worktree Plugin
 *
 * Creates isolated git worktrees for AI development sessions with
 * seamless terminal spawning across macOS, Windows, and Linux.
 *
 * Inspired by opencode-worktree-session by Felix Anhalt
 * https://github.com/felixAnhalt/opencode-worktree-session
 * License: MIT
 *
 * Rewritten for OCX with production-proven patterns.
 */

import type { Database } from "bun:sqlite"
import { access, copyFile, cp, mkdir, rm, stat, symlink } from "node:fs/promises"
import * as path from "node:path"
import { type Plugin, tool } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import type { OpencodeClient } from "../lib/types"

/** Logger interface for structured logging */
interface Logger {
	debug: (msg: string) => void
	info: (msg: string) => void
	warn: (msg: string) => void
	error: (msg: string) => void
}

import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"

import { getProjectId } from "../lib/get-project-id"
import {
	addSession,
	clearPendingDelete,
	getPendingDelete,
	getSession,
	getWorktreePath,
	initStateDb,
	removeSession,
	setPendingDelete,
} from "./state"
import { openTerminal } from "./terminal"
import { getOpencodeStoragePath } from "../lib/opencode-storage-paths"

/** Maximum retries for database initialization */
const DB_MAX_RETRIES = 3

/** Delay between retry attempts in milliseconds */
const DB_RETRY_DELAY_MS = 100

/** Maximum depth to traverse session parent chain */
const MAX_SESSION_CHAIN_DEPTH = 10

// =============================================================================
// TYPES & SCHEMAS
// =============================================================================

/** Result type for fallible operations */
interface OkResult<T> {
	readonly ok: true
	readonly value: T
}
interface ErrResult<E> {
	readonly ok: false
	readonly error: E
}
type Result<T, E> = OkResult<T> | ErrResult<E>

const Result = {
	ok: <T>(value: T): OkResult<T> => ({ ok: true, value }),
	err: <E>(error: E): ErrResult<E> => ({ ok: false, error }),
}

/**
 * Git branch name validation - blocks invalid refs and shell metacharacters
 * Characters blocked: control chars (0x00-0x1f, 0x7f), ~^:?*[]\\, and shell metacharacters
 */
function isValidBranchName(name: string): boolean {
	// Check for control characters
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i)
		if (code <= 0x1f || code === 0x7f) return false
	}
	// Check for invalid git ref characters and shell metacharacters
	if (/[~^:?*[\]\\;&|`$()]/.test(name)) return false
	return true
}

const branchNameSchema = z
	.string()
	.min(1, "Branch name cannot be empty")
	.max(255, "Branch name too long")
	.refine((name) => !name.startsWith("-"), {
		message: "Branch name cannot start with '-' (prevents option injection)",
	})
	.refine((name) => !name.startsWith("/") && !name.endsWith("/"), {
		message: "Branch name cannot start or end with '/'",
	})
	.refine((name) => !name.includes("//"), {
		message: "Branch name cannot contain '//'",
	})
	.refine((name) => !name.includes("@{"), {
		message: "Branch name cannot contain '@{' (git reflog syntax)",
	})
	.refine((name) => !name.includes(".."), {
		message: "Branch name cannot contain '..'",
	})
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Control character detection is intentional for security
	.refine((name) => !/[\x00-\x1f\x7f ~^:?*[\]\\]/.test(name), {
		message: "Branch name contains invalid characters",
	})
	.refine((name) => isValidBranchName(name), "Contains invalid git ref characters")
	.refine((name) => !name.startsWith(".") && !name.endsWith("."), "Cannot start or end with dot")
	.refine((name) => !name.endsWith(".lock"), "Cannot end with .lock")

/**
 * Worktree plugin configuration schema.
 * Config file: .opencode/worktree.jsonc
 */
const worktreeConfigSchema = z.object({
	sync: z
		.object({
			/** Files to copy from main worktree (relative paths only) */
			copyFiles: z.array(z.string()).default([]),
			/** Directories to symlink from main worktree (saves disk space) */
			symlinkDirs: z.array(z.string()).default([]),
			/** Patterns to exclude from copying (reserved for future use) */
			exclude: z.array(z.string()).default([]),
		})
		.default(() => ({ copyFiles: [], symlinkDirs: [], exclude: [] })),
	hooks: z
		.object({
			/** Commands to run after worktree creation */
			postCreate: z.array(z.string()).default([]),
			/** Commands to run before worktree deletion */
			preDelete: z.array(z.string()).default([]),
		})
		.default(() => ({ postCreate: [], preDelete: [] })),
})

type WorktreeConfig = z.infer<typeof worktreeConfigSchema>

// =============================================================================
// ERROR TYPES
// =============================================================================

class WorktreeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public override readonly cause?: unknown,
	) {
		super(`${operation}: ${message}`)
		this.name = "WorktreeError"
	}
}

// =============================================================================
// SESSION FORKING HELPERS
// =============================================================================

/**
 * Check if a path exists, distinguishing ENOENT from other errors (Law 4)
 */
async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch (e: unknown) {
		if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
			return false
		}
		throw e // Re-throw permission errors, etc.
	}
}

/**
 * Copy file if source exists. Returns true if copied, false if source doesn't exist.
 * Throws on copy failure (Law 4: Fail Loud)
 */
async function copyIfExists(src: string, dest: string): Promise<boolean> {
	if (!(await pathExists(src))) return false
	await copyFile(src, dest)
	return true
}

/**
 * Copy directory contents if source exists.
 * @param src - Source directory path
 * @param dest - Destination directory path
 * @returns true if copy was performed, false if source doesn't exist
 */
async function copyDirIfExists(src: string, dest: string): Promise<boolean> {
	if (!(await pathExists(src))) return false
	await cp(src, dest, { recursive: true })
	return true
}

interface ForkResult {
	forkedSession: { id: string }
	rootSessionId: string
	planCopied: boolean
	delegationsCopied: boolean
}

/**
 * Fork a session and copy associated plans/delegations.
 * Cleans up forked session on failure (atomic operation).
 */
async function forkWithContext(
	client: OpencodeClient,
	sessionId: string,
	projectId: string,
	getRootSessionIdFn: (sessionId: string) => Promise<string>,
): Promise<ForkResult> {
	// Guard clauses (Law 1)
	if (!client) throw new WorktreeError("client is required", "forkWithContext")
	if (!sessionId) throw new WorktreeError("sessionId is required", "forkWithContext")
	if (!projectId) throw new WorktreeError("projectId is required", "forkWithContext")

	// Get root session ID with error wrapping
	let rootSessionId: string
	try {
		rootSessionId = await getRootSessionIdFn(sessionId)
	} catch (e) {
		throw new WorktreeError("Failed to get root session ID", "forkWithContext", e)
	}

	// Fork session
	const forkedSessionResponse = await client.session.fork({
		path: { id: sessionId },
		body: {},
	})
	const forkedSession = forkedSessionResponse.data
	if (!forkedSession?.id) {
		throw new WorktreeError("Failed to fork session: no session data returned", "forkWithContext")
	}

	// Copy data with cleanup on failure
	let planCopied = false
	let delegationsCopied = false

	try {
		const workspaceBase = getOpencodeStoragePath("workspace")
		const delegationsBase = getOpencodeStoragePath("delegations")

		const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
		const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)

		await mkdir(destWorkspaceDir, { recursive: true })
		await mkdir(destDelegationsDir, { recursive: true })

		// Copy plan
		const srcPlan = path.join(workspaceBase, projectId, rootSessionId, "plan.md")
		const destPlan = path.join(destWorkspaceDir, "plan.md")
		planCopied = await copyIfExists(srcPlan, destPlan)

		// Copy delegations
		const srcDelegations = path.join(delegationsBase, projectId, rootSessionId)
		delegationsCopied = await copyDirIfExists(srcDelegations, destDelegationsDir)
	} catch (error) {
		client.app
			.log({
				body: {
					service: "worktree",
					level: "error",
					message: `forkWithContext: Copy failed, cleaning up forked session: ${error}`,
				},
			})
			.catch(() => {})
		// Clean up orphaned directories
		const workspaceBase = getOpencodeStoragePath("workspace")
		const delegationsBase = getOpencodeStoragePath("delegations")
		const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
		const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)
		await rm(destWorkspaceDir, { recursive: true, force: true }).catch((e) => {
			client.app
				.log({
					body: {
						service: "worktree",
						level: "error",
						message: `forkWithContext: Failed to clean up workspace dir ${destWorkspaceDir}: ${e}`,
					},
				})
				.catch(() => {})
		})
		await rm(destDelegationsDir, { recursive: true, force: true }).catch((e) => {
			client.app
				.log({
					body: {
						service: "worktree",
						level: "error",
						message: `forkWithContext: Failed to clean up delegations dir ${destDelegationsDir}: ${e}`,
					},
				})
				.catch(() => {})
		})
		await client.session.delete({ path: { id: forkedSession.id } }).catch((e) => {
			client.app
				.log({
					body: {
						service: "worktree",
						level: "error",
						message: `forkWithContext: Failed to clean up forked session ${forkedSession.id}: ${e}`,
					},
				})
				.catch(() => {})
		})
		throw new WorktreeError(
			`Failed to copy session data: ${error instanceof Error ? error.message : String(error)}`,
			"forkWithContext",
			error,
		)
	}

	return { forkedSession, rootSessionId, planCopied, delegationsCopied }
}

// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================

/** Database instance - initialized once per plugin lifecycle */
let db: Database | null = null

/** Project root path - stored on first initialization */
let projectRoot: string | null = null

/** Flag to prevent duplicate cleanup handler registration */
let cleanupRegistered = false

/**
 * Register process cleanup handlers for graceful database shutdown.
 * Ensures WAL checkpoint and proper close on process termination.
 *
 * NOTE: process.once() is an EventEmitter method that never throws.
 * The boolean guard is defense-in-depth for idempotency, not error recovery.
 *
 * @param database - The database instance to clean up
 */
function registerCleanupHandlers(database: Database): void {
	if (cleanupRegistered) return // Early exit guard
	cleanupRegistered = true

	const cleanup = () => {
		try {
			database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
			database.close()
		} catch {
			// Best effort cleanup - process is exiting anyway
		}
	}

	process.once("SIGTERM", cleanup)
	process.once("SIGINT", cleanup)
	process.once("beforeExit", cleanup)
}

/**
 * Get the database instance, initializing if needed.
 * Includes retry logic for transient initialization failures.
 *
 * @returns Database instance
 * @throws {Error} if initialization fails after all retries
 */
async function getDb(log: Logger): Promise<Database> {
	if (db) return db

	if (!projectRoot) {
		throw new Error("Database not initialized: projectRoot not set. Call initDb() first.")
	}

	let lastError: Error | null = null

	for (let attempt = 1; attempt <= DB_MAX_RETRIES; attempt++) {
		try {
			db = await initStateDb(projectRoot)
			registerCleanupHandlers(db)
			return db
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error))
			log.warn(`Database init attempt ${attempt}/${DB_MAX_RETRIES} failed: ${lastError.message}`)

			if (attempt < DB_MAX_RETRIES) {
				Bun.sleepSync(DB_RETRY_DELAY_MS)
			}
		}
	}

	throw new Error(
		`Failed to initialize database after ${DB_MAX_RETRIES} attempts: ${lastError?.message}`,
	)
}

/**
 * Initialize the database with the project root path.
 * Must be called once before any getDb() calls.
 */
async function initDb(root: string, log: Logger): Promise<Database> {
	projectRoot = root
	return getDb(log)
}

// =============================================================================
// GIT MODULE
// =============================================================================

/**
 * Execute a git command safely using Bun.spawn with explicit array.
 * Avoids shell interpolation entirely by passing args as array.
 */
async function git(args: string[], cwd: string): Promise<Result<string, string>> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		})
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		if (exitCode !== 0) {
			return Result.err(stderr.trim() || `git ${args[0]} failed`)
		}
		return Result.ok(stdout.trim())
	} catch (error) {
		return Result.err(error instanceof Error ? error.message : String(error))
	}
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const result = await git(["rev-parse", "--verify", branch], cwd)
	return result.ok
}

async function createWorktree(
	repoRoot: string,
	branch: string,
	baseBranch?: string,
): Promise<Result<string, string>> {
	const worktreePath = await getWorktreePath(repoRoot, branch)

	// Ensure parent directory exists
	await mkdir(path.dirname(worktreePath), { recursive: true })

	const exists = await branchExists(repoRoot, branch)

	if (exists) {
		// Checkout existing branch into worktree
		const result = await git(["worktree", "add", worktreePath, branch], repoRoot)
		return result.ok ? Result.ok(worktreePath) : result
	} else {
		// Create new branch from base
		const base = baseBranch ?? "HEAD"
		const result = await git(["worktree", "add", "-b", branch, worktreePath, base], repoRoot)
		return result.ok ? Result.ok(worktreePath) : result
	}
}

async function removeWorktree(
	repoRoot: string,
	worktreePath: string,
): Promise<Result<void, string>> {
	const result = await git(["worktree", "remove", "--force", worktreePath], repoRoot)
	return result.ok ? Result.ok(undefined) : Result.err(result.error)
}

// =============================================================================
// FILE SYNC MODULE
// =============================================================================

/**
 * Validate that a path is safe (no escape from base directory)
 */
function isPathSafe(filePath: string, baseDir: string, log: Logger): boolean {
	// Reject absolute paths
	if (path.isAbsolute(filePath)) {
		log.warn(`[worktree] Rejected absolute path: ${filePath}`)
		return false
	}
	// Reject obvious path traversal
	if (filePath.includes("..")) {
		log.warn(`[worktree] Rejected path traversal: ${filePath}`)
		return false
	}
	// Verify resolved path stays within base directory
	const resolved = path.resolve(baseDir, filePath)
	if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
		log.warn(`[worktree] Path escapes base directory: ${filePath}`)
		return false
	}
	return true
}

/**
 * Copy files from source directory to target directory.
 * Skips missing files silently (production pattern).
 */
async function copyFiles(
	sourceDir: string,
	targetDir: string,
	files: string[],
	log: Logger,
): Promise<void> {
	for (const file of files) {
		if (!isPathSafe(file, sourceDir, log)) continue

		const sourcePath = path.join(sourceDir, file)
		const targetPath = path.join(targetDir, file)

		try {
			const sourceFile = Bun.file(sourcePath)
			if (!(await sourceFile.exists())) {
				log.debug(`[worktree] Skipping missing file: ${file}`)
				continue
			}

			// Ensure target directory exists
			const targetFileDir = path.dirname(targetPath)
			await mkdir(targetFileDir, { recursive: true })

			// Copy file
			await Bun.write(targetPath, sourceFile)
			log.info(`[worktree] Copied: ${file}`)
		} catch (error) {
			const isNotFound =
				error instanceof Error &&
				(error.message.includes("ENOENT") || error.message.includes("no such file"))
			if (isNotFound) {
				log.debug(`[worktree] Skipping missing: ${file}`)
			} else {
				log.warn(`[worktree] Failed to copy ${file}: ${error}`)
			}
		}
	}
}

/**
 * Create symlinks for directories from source to target.
 * Uses absolute paths for symlink targets.
 */
async function symlinkDirs(
	sourceDir: string,
	targetDir: string,
	dirs: string[],
	log: Logger,
): Promise<void> {
	for (const dir of dirs) {
		if (!isPathSafe(dir, sourceDir, log)) continue

		const sourcePath = path.join(sourceDir, dir)
		const targetPath = path.join(targetDir, dir)

		try {
			// Check if source directory exists
			const fileStat = await stat(sourcePath).catch(() => null)
			if (!fileStat || !fileStat.isDirectory()) {
				log.debug(`[worktree] Skipping missing directory: ${dir}`)
				continue
			}

			// Ensure parent directory exists
			const targetParentDir = path.dirname(targetPath)
			await mkdir(targetParentDir, { recursive: true })

			// Remove existing target if it exists (might be empty dir from git)
			await rm(targetPath, { recursive: true, force: true })

			// Create symlink (use absolute path for source)
			await symlink(sourcePath, targetPath, "dir")
			log.info(`[worktree] Symlinked: ${dir}`)
		} catch (error) {
			log.warn(`[worktree] Failed to symlink ${dir}: ${error}`)
		}
	}
}

/**
 * Run hook commands in the worktree directory.
 */
async function runHooks(cwd: string, commands: string[], log: Logger): Promise<void> {
	for (const command of commands) {
		log.info(`[worktree] Running hook: ${command}`)
		try {
			// Use shell to properly handle quoted arguments and complex commands
			const result = Bun.spawnSync(["bash", "-c", command], {
				cwd,
				stdout: "inherit",
				stderr: "pipe",
			})
			if (result.exitCode !== 0) {
				const stderr = result.stderr?.toString() || ""
				log.warn(
					`[worktree] Hook failed (exit ${result.exitCode}): ${command}${stderr ? `\n${stderr}` : ""}`,
				)
			}
		} catch (error) {
			log.warn(`[worktree] Hook error: ${error}`)
		}
	}
}

/**
 * Load worktree-specific configuration from .opencode/worktree.jsonc
 * Auto-creates config file with helpful defaults if it doesn't exist.
 */
async function loadWorktreeConfig(directory: string, log: Logger): Promise<WorktreeConfig> {
	const configPath = path.join(directory, ".opencode", "worktree.jsonc")

	try {
		const file = Bun.file(configPath)
		if (!(await file.exists())) {
			// Auto-create config with helpful defaults and comments
			const defaultConfig = `{
  "$schema": "https://registry.kdco.dev/schemas/worktree.json",

  // Worktree plugin configuration
  // Documentation: https://github.com/kdcokenny/ocx

  "sync": {
    // Files to copy from main worktree to new worktrees
    // Example: [".env", ".env.local", "dev.sqlite"]
    "copyFiles": [],

    // Directories to symlink (saves disk space)
    // Example: ["node_modules"]
    "symlinkDirs": [],

    // Patterns to exclude from copying
    "exclude": []
  },

  "hooks": {
    // Commands to run after worktree creation
    // Example: ["pnpm install", "docker compose up -d"]
    "postCreate": [],

    // Commands to run before worktree deletion
    // Example: ["docker compose down"]
    "preDelete": []
  }
}
`
			// Ensure .opencode directory exists
			await mkdir(path.join(directory, ".opencode"), { recursive: true })
			await Bun.write(configPath, defaultConfig)
			log.info(`[worktree] Created default config: ${configPath}`)
			return worktreeConfigSchema.parse({})
		}

		const content = await file.text()
		// Use proper JSONC parser (handles comments in strings correctly)
		const parsed = parseJsonc(content)
		if (parsed === undefined) {
			log.error(`[worktree] Invalid worktree.jsonc syntax`)
			return worktreeConfigSchema.parse({})
		}
		return worktreeConfigSchema.parse(parsed)
	} catch (error) {
		log.warn(`[worktree] Failed to load config: ${error}`)
		return worktreeConfigSchema.parse({})
	}
}

// =============================================================================
// PLUGIN ENTRY
// =============================================================================

export const WorktreePlugin: Plugin = async (ctx) => {
	const { directory, client } = ctx

	const log = {
		debug: (msg: string) =>
			client.app
				.log({ body: { service: "worktree", level: "debug", message: msg } })
				.catch(() => {}),
		info: (msg: string) =>
			client.app
				.log({ body: { service: "worktree", level: "info", message: msg } })
				.catch(() => {}),
		warn: (msg: string) =>
			client.app
				.log({ body: { service: "worktree", level: "warn", message: msg } })
				.catch(() => {}),
		error: (msg: string) =>
			client.app
				.log({ body: { service: "worktree", level: "error", message: msg } })
				.catch(() => {}),
	}

	// Initialize SQLite database
	const database = await initDb(directory, log)

	return {
		tool: {
			worktree_create: tool({
				description:
					"Create a new git worktree for isolated development. A new terminal will open with OpenCode in the worktree.",
				args: {
					branch: tool.schema
						.string()
						.describe("Branch name for the worktree (e.g., 'feature/dark-mode')"),
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Base branch to create from (defaults to HEAD)"),
				},
				async execute(args, toolCtx) {
					// Validate branch name at boundary
					const branchResult = branchNameSchema.safeParse(args.branch)
					if (!branchResult.success) {
						return `❌ Invalid branch name: ${branchResult.error.issues[0]?.message}`
					}

					// Validate base branch name at boundary
					if (args.baseBranch) {
						const baseResult = branchNameSchema.safeParse(args.baseBranch)
						if (!baseResult.success) {
							return `❌ Invalid base branch name: ${baseResult.error.issues[0]?.message}`
						}
					}

					// Create worktree
					const result = await createWorktree(directory, args.branch, args.baseBranch)
					if (!result.ok) {
						return `Failed to create worktree: ${result.error}`
					}

					const worktreePath = result.value

					// Sync files from main worktree
					const worktreeConfig = await loadWorktreeConfig(directory, log)
					const mainWorktreePath = directory // The repo root is the main worktree

					// Copy files
					if (worktreeConfig.sync.copyFiles.length > 0) {
						await copyFiles(mainWorktreePath, worktreePath, worktreeConfig.sync.copyFiles, log)
					}

					// Symlink directories
					if (worktreeConfig.sync.symlinkDirs.length > 0) {
						await symlinkDirs(mainWorktreePath, worktreePath, worktreeConfig.sync.symlinkDirs, log)
					}

					// Run postCreate hooks
					if (worktreeConfig.hooks.postCreate.length > 0) {
						await runHooks(worktreePath, worktreeConfig.hooks.postCreate, log)
					}

					// Fork session with context (replaces --session resume)
					const projectId = await getProjectId(worktreePath, client as any)
				const { forkedSession, planCopied, delegationsCopied } = await forkWithContext(
					client as any,
						toolCtx.sessionID,
						projectId,
						async (sid) => {
							// Walk up parentID chain to find root session
							let currentId = sid
							for (let depth = 0; depth < MAX_SESSION_CHAIN_DEPTH; depth++) {
								const session = await client.session.get({ path: { id: currentId } })
								if (!session.data?.parentID) return currentId
								currentId = session.data.parentID
							}
							return currentId
						},
					)

					log.debug(
						`Forked session ${forkedSession.id}, plan: ${planCopied}, delegations: ${delegationsCopied}`,
					)

					// Spawn worktree with forked session
					const terminalResult = await openTerminal(
						worktreePath,
						`opencode --session ${forkedSession.id}`,
						args.branch,
					)

					if (!terminalResult.success) {
						log.warn(`[worktree] Failed to open terminal: ${terminalResult.error}`)
					}

					// Record session for tracking (used by delete flow)
					addSession(database, {
						id: forkedSession.id,
						branch: args.branch,
						path: worktreePath,
						createdAt: new Date().toISOString(),
					})

					return `Worktree created at ${worktreePath}\n\nA new terminal has been opened with OpenCode.`
				},
			}),

			worktree_delete: tool({
				description:
					"Delete the current worktree and clean up. Changes will be committed before removal.",
				args: {
					reason: tool.schema
						.string()
						.describe("Brief explanation of why you are calling this tool"),
				},
				async execute(_args, toolCtx) {
					// Find current session's worktree
					const session = getSession(database, toolCtx?.sessionID ?? "")
					if (!session) {
						return `No worktree associated with this session`
					}

					// Set pending delete for session.idle (atomic operation)
					setPendingDelete(database, { branch: session.branch, path: session.path }, client as any)

					return `Worktree marked for cleanup. It will be removed when this session ends.`
				},
			}),
		},

		event: async ({ event }: { event: Event }): Promise<void> => {
			if (event.type !== "session.idle") return

			// Handle pending delete
			const pendingDelete = getPendingDelete(database)
			if (pendingDelete) {
				const { path: worktreePath, branch } = pendingDelete

				// Run preDelete hooks before cleanup
				const config = await loadWorktreeConfig(directory, log)
				if (config.hooks.preDelete.length > 0) {
					await runHooks(worktreePath, config.hooks.preDelete, log)
				}

				// Commit any uncommitted changes
				const addResult = await git(["add", "-A"], worktreePath)
				if (!addResult.ok) log.warn(`[worktree] git add failed: ${addResult.error}`)

				const commitResult = await git(
					["commit", "-m", "chore(worktree): session snapshot", "--allow-empty"],
					worktreePath,
				)
				if (!commitResult.ok) log.warn(`[worktree] git commit failed: ${commitResult.error}`)

				// Remove worktree
				const removeResult = await removeWorktree(directory, worktreePath)
				if (!removeResult.ok) {
					log.warn(`[worktree] Failed to remove worktree: ${removeResult.error}`)
				}

				// Clear pending delete atomically
				clearPendingDelete(database)

				// Remove session from database
				removeSession(database, branch)
			}
		},
	}
}

export default WorktreePlugin
