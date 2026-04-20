/**
 * Kortix System Plugin — THE single plugin for the entire Kortix environment.
 *
 * Projects, agents, tasks, sessions, connectors, autowork, todo-enforcer,
 * triggers, auth, PTY, worktree, and /btw.
 *
 * Native OpenCode task is disabled, but native todowrite/todoread can be used
 * alongside Kortix project tasks to support autowork-style persistent worker loops.
 * Kortix also provides its own project/task orchestration surface plus worker lifecycle tools.
 *
 * opencode.jsonc: "./plugin/kortix-system/kortix-system.ts"
 */

import * as path from "node:path"
import { Database } from "bun:sqlite"
import type { Plugin } from "@opencode-ai/plugin"

import { initProjectsDb, ProjectManager, projectTools, projectGateHook, projectStatusTransform } from "./projects"
import { agentTaskTools, handleAgentTaskSessionEvent } from "./agent-tasks"
import { ticketTools, ticketToolGateHook } from "./ticket-tools"
import { ensureTasksTable, reconcileAllRunningTasks } from "../../../src/services/task-service"
import { ensureTicketTables } from "../../../src/services/ticket-service"
import { resolveKortixWorkspaceRoot, ensureKortixDir } from "./lib/paths"
import { markStartupAbortedSession } from "./lib/startup-aborted-sessions"
import { getBusySessionIds } from "../../../src/services/runtime-reload"

const STARTUP_BUSY_SESSION_CLEANUP_DELAY_MS = 750
const STARTUP_BUSY_SESSION_CLEANUP_INTERVAL_MS = 3_000
const STARTUP_BUSY_SESSION_CLEANUP_PASSES = 20

type ListedSession = { id: string; time?: { updated?: number } }

function normalizeListedSessions(input: unknown): ListedSession[] {
	if (Array.isArray(input)) return input as ListedSession[]
	if (input && typeof input === "object" && Array.isArray((input as { sessions?: unknown }).sessions)) {
		return (input as { sessions: ListedSession[] }).sessions
	}
	return []
}

function normalizeBusySessionIds(input: unknown): string[] {
	if (!input || typeof input !== "object") return []
	return getBusySessionIds(input as Record<string, { type?: string }> | null | undefined)
}

export function selectLingeringBusySessionIds(options: {
	candidateBusySessionIds?: string[]
	sessions?: ListedSession[]
	activeTaskSessionIds: Set<string>
	cleanupStartedAt: number
}): string[] {
	const sessionsById = new Map((options.sessions ?? []).map((session) => [session.id, session]))
	return (options.candidateBusySessionIds ?? []).filter((sessionId) => {
		if (options.activeTaskSessionIds.has(sessionId)) return false
		const updatedAt = sessionsById.get(sessionId)?.time?.updated
		return typeof updatedAt !== "number" || updatedAt <= options.cleanupStartedAt
	})
}

async function cleanupLingeringBusySessions(client: any, db: Database, cleanupStartedAt: number): Promise<void> {
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			const [statusRes, sessionsRes] = await Promise.all([
				client.session.status(),
				client.session.list(),
			])
			const candidateBusySessionIds = normalizeBusySessionIds(statusRes.data)
			const activeTaskSessionIds = new Set(
				(candidateBusySessionIds
					.map((sessionId) => {
						const activeTaskRun = db.prepare("SELECT 1 FROM task_runs WHERE owner_session_id=$sid AND status='running' LIMIT 1").get({ $sid: sessionId })
						return activeTaskRun ? sessionId : null
					})
					.filter((sessionId): sessionId is string => Boolean(sessionId))),
			)
			const busySessionIds = selectLingeringBusySessionIds({
				candidateBusySessionIds,
				sessions: normalizeListedSessions(sessionsRes.data),
				activeTaskSessionIds,
				cleanupStartedAt,
			})
			if (busySessionIds.length === 0) {
				if (candidateBusySessionIds.length > 0) {
					console.log("[kortix-system] startup cleanup: only fresh busy sessions found, skipping cleanup")
				}
				return
			}

			console.log(`[kortix-system] startup cleanup: aborting ${busySessionIds.length} lingering busy session(s)`)
			const failures: string[] = []
			await Promise.all(
				busySessionIds.map(async (sessionId) => {
					try {
						markStartupAbortedSession(sessionId)
						await client.session.abort({ path: { id: sessionId } })
					} catch (err) {
						failures.push(`${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
					}
				}),
			)

			if (failures.length > 0) {
				console.warn(`[kortix-system] startup cleanup: failed to abort ${failures.length} session(s): ${failures.join("; ")}`)
			} else {
				console.log("[kortix-system] startup cleanup: lingering busy sessions aborted")
			}
			return
		} catch (err) {
			if (attempt === 5) {
				console.warn(`[kortix-system] startup cleanup failed after ${attempt} attempts: ${err instanceof Error ? err.message : String(err)}`)
				return
			}
			await Bun.sleep(attempt * 250)
		}
	}
}

function scheduleStartupBusySessionCleanup(client: any, db: Database, cleanupStartedAt: number): void {
	let passesRemaining = STARTUP_BUSY_SESSION_CLEANUP_PASSES

	const runPass = async () => {
		passesRemaining -= 1
		await cleanupLingeringBusySessions(client, db, cleanupStartedAt)
		if (passesRemaining <= 0) return
		setTimeout(() => {
			void runPass()
		}, STARTUP_BUSY_SESSION_CLEANUP_INTERVAL_MS)
	}

	setTimeout(() => {
		void runPass()
	}, STARTUP_BUSY_SESSION_CLEANUP_DELAY_MS)
}

const KortixSystemPlugin: Plugin = async (ctx) => {
	const { client } = ctx
	const startupCleanupStartedAt = Date.now()

	// ── Core infra ──
	const workspaceRoot = resolveKortixWorkspaceRoot(import.meta.dir)
	const kortixDir = ensureKortixDir(import.meta.dir)
	const db = initProjectsDb(path.join(kortixDir, "kortix.db"))
	ensureTasksTable(db)
	ensureTicketTables(db)
	const mgr = new ProjectManager(client, workspaceRoot, db)
	let currentSessionId: string | null = null

	// ── Load sub-modules ──
	// Load sub-modules — each wrapped in try/catch so one failure doesn't kill the whole plugin
	const load = async (name: string, fn: () => Promise<any>) => {
		try { return await fn() } catch (e) { console.warn(`[kortix-system] ${name} init failed:`, (e as Error).message); return null }
	}

	const sessions = await load("sessions", () => import("./sessions").then(m => m.default(ctx)))
	const connectors = await load("connectors", () => import("./connectors").then(m => m.default(ctx)))
	const auth = await load("auth", () => import("./auth").then(m => m.default(ctx)))
	const pty = await load("pty", () => import("./pty-tools").then(m => m.default(ctx)))
	const autowork = await load("autowork", () => import("./autowork/autowork").then(m => m.default(ctx)))
	const todoEnforcer = await load("todo-enforcer", () => import("./todo-enforcer/todo-enforcer").then(m => m.default(ctx)))
	const triggers = await load("triggers", () => import("./triggers").then(m => m.default(ctx)))
	const worktreeModule = await load("worktree", () => import("./worktree/worktree").then(m => m.default(ctx)))
	const btw = await load("btw", async () => {
		const btwRaw = (await import("./btw")).default
		return typeof btwRaw === "object" && "server" in btwRaw ? await btwRaw.server(ctx) : await btwRaw(ctx)
	})
	
	console.log("[kortix-system] Plugin initialized. Tools:", Object.keys(projectTools(mgr, db)).length, "project +", Object.keys(agentTaskTools(db, mgr, client)).length, "task")
	scheduleStartupBusySessionCleanup(client, db, startupCleanupStartedAt)
	setInterval(() => {
		void reconcileAllRunningTasks(db, client).catch(() => {})
	}, 5000)
 
	// ── Merge all tools ──
	const projectGate = projectGateHook(mgr)
	const ticketGate = ticketToolGateHook(db)
	const projectStatus = projectStatusTransform(mgr, () => currentSessionId)
	return {
		tool: {
			...projectTools(mgr, db),
			...agentTaskTools(db, mgr, client),
			...ticketTools(db, mgr, client),
			...(sessions?.tool || {}),
			...(connectors?.tool || {}),
			...(triggers?.tool || {}),
			...(pty?.tool || {}),
			...(worktreeModule?.tool || {}),
		},

		// Auth
		...(auth?.auth ? { auth: auth.auth } : {}),

		// Gates: project selection + ticket tool_group enforcement
		"tool.execute.before": async (input: any, output: any) => {
			await projectGate(input, output)
			await ticketGate(input, output)
		},

		// System prompt transform — forwards to auth (anthropic prefix).
		// Project-agent persona is injected by OpenCode itself from the
		// agent file's body (real first-class agents under `.opencode/agent/`),
		// not through this hook.
		"experimental.chat.system.transform": async (input: any, output: { system: string[] }) => {
			if (auth?.["experimental.chat.system.transform"]) {
				await auth["experimental.chat.system.transform"](input, output)
			}
		},

		// Inject the project status / no-project gate / v2-route-only reminder
		// into the last user message before each LLM call.
		"experimental.chat.messages.transform": async (input: any, output: { messages: any[] }) => {
			await projectStatus(input, output).catch(() => {})
		},

		// BTW command
		"command.execute.before": async (input: any, output: any) => {
			if (autowork?.["command.execute.before"]) {
				await autowork["command.execute.before"](input, output).catch(() => {})
			}
			if (btw?.["command.execute.before"]) {
				await btw["command.execute.before"](input, output).catch(() => {})
			}
		},

		"chat.message": async (input: any, output: any) => {
			if (autowork?.["chat.message"]) {
				await autowork["chat.message"](input, output).catch(() => {})
			}
			if (todoEnforcer?.["chat.message"]) {
				await todoEnforcer["chat.message"](input, output).catch(() => {})
			}
		},

		// Events
		event: async (payload: any) => {
			const sid = payload?.event?.properties?.sessionID
			if (sid && payload.event.type === "session.created") currentSessionId = sid
			if (pty?.event) await pty.event(payload).catch(() => {})
			if (autowork?.event) await autowork.event(payload).catch(() => {})
			if (todoEnforcer?.event) await todoEnforcer.event(payload).catch(() => {})
			if (worktreeModule?.event) await worktreeModule.event(payload).catch(() => {})

			// Agent async completion — runs last so autowork has already updated its active set
			if (sid && (
				payload.event.type === "session.idle" ||
				payload.event.type === "session.error" ||
				payload.event.type === "session.aborted"
			)) {
				handleAgentTaskSessionEvent(sid, payload.event.type, client, db, mgr).catch(() => {})
			}
		},

		// Compaction: inject active tasks
		"experimental.session.compacting": async (_input: any, output: { context: string[] }) => {
			try {
				if (!currentSessionId) return
				const project = mgr.getSessionProject(currentSessionId)
				if (!project) return
				const tasks = db.prepare("SELECT * FROM tasks WHERE project_id=$pid AND status IN ('todo','in_progress','input_needed','awaiting_review') ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'input_needed' THEN 1 WHEN 'awaiting_review' THEN 2 WHEN 'todo' THEN 3 ELSE 4 END, created_at")
					.all({ $pid: project.id }) as Array<{ id: string; title: string; status: string }>
				if (!tasks.length) return
				const icon = (s: string) => s === "in_progress" ? "→" : s === "input_needed" ? "◐" : s === "awaiting_review" ? "◌" : "○"
				output.context.push([
					`<kortix_system type="tasks" source="kortix-system">`,
					`Active tasks for project ${project.name}:`,
					...tasks.map(t => `${icon(t.status)} ${t.id}: ${t.title}`),
					`</kortix_system>`,
				].join("\n"))
			} catch {}
		},
	}
}

export default KortixSystemPlugin
