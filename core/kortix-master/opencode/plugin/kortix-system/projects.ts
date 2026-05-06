/**
 * Kortix Workspace — legacy project storage + global context helpers.
 *
 * SQLite (kortix.db) remains the compatibility store, but runtime behavior is
 * one global workspace rooted at /workspace (or the configured workspace path).
 */

import { Database } from "bun:sqlite"
import * as fs from "node:fs/promises"
import { existsSync, mkdirSync, unlinkSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { ensureGlobalMemoryFiles } from "./lib/paths"
import { ensureSchema } from "./lib/schema"
import { listColumns, replaceColumns } from "../../../src/services/ticket-service"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProjectRow {
	id: string; name: string; path: string; description: string
	created_at: string; opencode_id: string | null
	/** Hidden maintainer session id. Auto-created on first task lifecycle event. */
	maintainer_session_id?: string | null
}

export const PROJECT_MAINTAINER_AGENT = "project-maintainer"

export const GLOBAL_PROJECT_ID = "proj-global"
export const GLOBAL_PROJECT_NAME = "Kortix"
export const GLOBAL_PROJECT_DESCRIPTION = "Global Kortix workspace. All tasks, tickets, credentials, agents, and durable context live here."

const TASK_SUMMARY_START = "<!-- KORTIX:TASK-SUMMARY:START -->"
const TASK_SUMMARY_END = "<!-- KORTIX:TASK-SUMMARY:END -->"

function projectContextPath(projectPath: string): string {
	return path.join(projectPath, ".kortix", "CONTEXT.md")
}

function defaultGlobalColumns() {
	return [
		{ key: "backlog", label: "Backlog", default_assignee_type: null, default_assignee_id: null, is_terminal: false },
		{ key: "in_progress", label: "In Progress", default_assignee_type: null, default_assignee_id: null, is_terminal: false },
		{ key: "review", label: "Review", default_assignee_type: null, default_assignee_id: null, is_terminal: false },
		{ key: "done", label: "Done", default_assignee_type: null, default_assignee_id: null, is_terminal: true },
	]
}

function ensureGlobalContextFile(workspaceRoot: string): void {
	const ctxPath = projectContextPath(workspaceRoot)
	mkdirSync(path.dirname(ctxPath), { recursive: true })
	if (!existsSync(ctxPath)) {
		writeFileSync(ctxPath, `# ${GLOBAL_PROJECT_NAME}\n\n${GLOBAL_PROJECT_DESCRIPTION}\n`, "utf8")
	}
}

function buildTaskSummary(db: Database, projectId: string): string {
	const tasks = db.prepare(`
		SELECT title, status, verification_summary, result, blocking_question
		FROM tasks WHERE project_id=$pid
		ORDER BY CASE status
			WHEN 'in_progress' THEN 0
			WHEN 'input_needed' THEN 1
			WHEN 'awaiting_review' THEN 2
			WHEN 'todo' THEN 3
			WHEN 'completed' THEN 4
			WHEN 'cancelled' THEN 5
			ELSE 99 END, updated_at DESC
		LIMIT 40
	`).all({ $pid: projectId }) as Array<{
		title: string
		status: string
		verification_summary: string | null
		result: string | null
		blocking_question: string | null
	}>

	const byStatus = (s: string) => tasks.filter((t) => t.status === s)
	const summarize = (text: string | null | undefined, max = 140) => {
		if (!text) return ""
		const clean = text.replace(/\s+/g, " ").trim()
		return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
	}

	const lines = [
		"## Task Snapshot",
		"",
		`- todo: ${byStatus("todo").length}`,
		`- in_progress: ${byStatus("in_progress").length}`,
		`- input_needed: ${byStatus("input_needed").length}`,
		`- awaiting_review: ${byStatus("awaiting_review").length}`,
		`- completed: ${byStatus("completed").length}`,
		`- cancelled: ${byStatus("cancelled").length}`,
	]

	const active = tasks.filter((t) => ["todo", "in_progress", "input_needed", "awaiting_review"].includes(t.status))
	if (active.length) {
		lines.push("", "### Active / Review")
		for (const task of active) {
			const extra = task.status === "input_needed"
				? summarize(task.blocking_question)
				: task.status === "awaiting_review"
					? summarize(task.verification_summary || task.result)
					: ""
			lines.push(`- [${task.status}] ${task.title}${extra ? ` — ${extra}` : ""}`)
		}
	}

	const completed = byStatus("completed").slice(0, 8)
	if (completed.length) {
		lines.push("", "### Recent Completed")
		for (const task of completed) {
			const extra = summarize(task.verification_summary || task.result)
			lines.push(`- ${task.title}${extra ? ` — ${extra}` : ""}`)
		}
	}

	return [TASK_SUMMARY_START, ...lines, TASK_SUMMARY_END].join("\n")
}

async function syncProjectContextFile(db: Database, project: ProjectRow): Promise<string> {
	const ctxPath = projectContextPath(project.path)
	await fs.mkdir(path.dirname(ctxPath), { recursive: true })
	let current = ""
	try { current = await fs.readFile(ctxPath, "utf8") } catch {}
	if (!current.trim()) current = `# ${project.name}\n\n${project.description || ""}\n`

	const block = buildTaskSummary(db, project.id)
	let next: string
	const start = current.indexOf(TASK_SUMMARY_START)
	const end = current.indexOf(TASK_SUMMARY_END)
	if (start !== -1 && end !== -1 && end > start) {
		next = `${current.slice(0, start).trimEnd()}\n\n${block}\n${current.slice(end + TASK_SUMMARY_END.length).trimStart()}`
	} else {
		next = `${current.trimEnd()}\n\n${block}\n`
	}
	await fs.writeFile(ctxPath, next, "utf8")
	return ctxPath
}

// ── Database ─────────────────────────────────────────────────────────────────

export function initProjectsDb(dbPath: string): Database {
	mkdirSync(path.dirname(dbPath), { recursive: true })
	try {
		const dbExists = existsSync(dbPath)
		const dbEmpty = dbExists && statSync(dbPath).size === 0
		if (!dbExists || dbEmpty) {
			for (const suffix of ["", "-wal", "-shm", "-journal"]) {
				try { unlinkSync(dbPath + suffix) } catch {}
			}
		}
	} catch {}

	let db: Database
	try { db = new Database(dbPath) } catch {
		for (const suffix of ["", "-wal", "-shm", "-journal"]) {
			try { unlinkSync(dbPath + suffix) } catch {}
		}
		db = new Database(dbPath)
	}
	db.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000")

	ensureSchema(db, "projects", [
		{ name: "id",          type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: true },
		{ name: "name",        type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false },
		{ name: "path",        type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false, unique: true },
		{ name: "description", type: "TEXT",    notNull: true,  defaultValue: "''", primaryKey: false },
		{ name: "created_at",  type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false },
		{ name: "opencode_id", type: "TEXT",    notNull: false, defaultValue: null, primaryKey: false },
		{ name: "maintainer_session_id", type: "TEXT", notNull: false, defaultValue: null, primaryKey: false },
		{ name: "structure_version", type: "INTEGER", notNull: true, defaultValue: "2", primaryKey: false },
		{ name: "user_handle", type: "TEXT", notNull: false, defaultValue: null, primaryKey: false },
		{ name: "kind", type: "TEXT", notNull: true, defaultValue: "'scoped'", primaryKey: false },
	])

	ensureSchema(db, "session_projects", [
		{ name: "session_id", type: "TEXT", notNull: true, defaultValue: null, primaryKey: true },
		{ name: "project_id", type: "TEXT", notNull: true, defaultValue: null, primaryKey: false },
		{ name: "set_at",     type: "TEXT", notNull: true, defaultValue: null, primaryKey: false },
	])

	ensureSchema(db, "connectors", [
		{ name: "id",             type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: true },
		{ name: "name",           type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false, unique: true },
		{ name: "description",    type: "TEXT",    notNull: false, defaultValue: null, primaryKey: false },
		{ name: "source",         type: "TEXT",    notNull: false, defaultValue: null, primaryKey: false },
		{ name: "pipedream_slug", type: "TEXT",    notNull: false, defaultValue: null, primaryKey: false },
		{ name: "env_keys",       type: "TEXT",    notNull: false, defaultValue: null, primaryKey: false },
		{ name: "notes",          type: "TEXT",    notNull: false, defaultValue: null, primaryKey: false },
		{ name: "auto_generated", type: "INTEGER", notNull: false, defaultValue: "0",  primaryKey: false },
		{ name: "created_at",     type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false },
		{ name: "updated_at",     type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false },
	])

	return db
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class ProjectManager {
	private sessionProjectCache = new Map<string, ProjectRow>()
	private globalProjectCache: ProjectRow | null = null

	// client is publicly accessible so tools can invoke session.* directly.
	constructor(public client: any, private workspaceRoot: string, public db: Database) {
		this.getGlobalProject()
	}

	getGlobalProject(): ProjectRow {
		if (this.globalProjectCache) return this.globalProjectCache
		ensureGlobalMemoryFiles(import.meta.dir)
		ensureGlobalContextFile(this.workspaceRoot)
		const now = new Date().toISOString()

		let row = this.db.prepare("SELECT * FROM projects WHERE path=$path").get({ $path: this.workspaceRoot }) as ProjectRow | null
		if (row) {
			this.db.prepare("UPDATE projects SET description=COALESCE(NULLIF(description,''), $description), kind='global', structure_version=1 WHERE id=$id")
				.run({ $description: GLOBAL_PROJECT_DESCRIPTION, $id: row.id })
			row = this.db.prepare("SELECT * FROM projects WHERE id=$id").get({ $id: row.id }) as ProjectRow
		} else {
			row = this.db.prepare("SELECT * FROM projects WHERE id=$id").get({ $id: GLOBAL_PROJECT_ID }) as ProjectRow | null
			if (row) {
				this.db.prepare("UPDATE projects SET path=$path, description=COALESCE(NULLIF(description,''), $description), kind='global', structure_version=1 WHERE id=$id")
					.run({ $path: this.workspaceRoot, $description: GLOBAL_PROJECT_DESCRIPTION, $id: row.id })
				row = this.db.prepare("SELECT * FROM projects WHERE id=$id").get({ $id: row.id }) as ProjectRow
			} else {
				this.db.prepare("INSERT INTO projects (id,name,path,description,created_at,opencode_id,structure_version,kind) VALUES ($id,$name,$path,$description,$now,NULL,1,'global')")
					.run({ $id: GLOBAL_PROJECT_ID, $name: GLOBAL_PROJECT_NAME, $path: this.workspaceRoot, $description: GLOBAL_PROJECT_DESCRIPTION, $now: now })
				row = this.db.prepare("SELECT * FROM projects WHERE id=$id").get({ $id: GLOBAL_PROJECT_ID }) as ProjectRow
			}
		}

		try {
			if (listColumns(this.db, row.id).length === 0) replaceColumns(this.db, row.id, defaultGlobalColumns())
		} catch {}

		this.globalProjectCache = row
		return row
	}

	refreshGlobalProject(): ProjectRow {
		this.globalProjectCache = null
		return this.getGlobalProject()
	}

	getSessionProject(sessionId: string): ProjectRow | null {
		const global = this.getGlobalProject()
		if (sessionId) this.setSessionProject(sessionId, global.id)
		return global
	}

	setSessionProject(sessionId: string, _projectId: string): void {
		const project = this.getGlobalProject()
		this.db.prepare("INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)")
			.run({ $sid: sessionId, $pid: project.id, $now: new Date().toISOString() })
		this.sessionProjectCache.set(sessionId, project)
	}

	getMaintainerSessionId(projectId: string): string | null {
		const row = this.db.prepare("SELECT maintainer_session_id FROM projects WHERE id = $id").get({ $id: projectId }) as { maintainer_session_id?: string | null } | null
		return row?.maintainer_session_id || null
	}

	/** Ensure the hidden maintainer session exists for the global workspace. */
	async ensureMaintainerSession(projectId: string): Promise<string | null> {
		const existing = this.getMaintainerSessionId(projectId)
		if (existing) return existing

		const project = this.db.prepare("SELECT * FROM projects WHERE id = $id").get({ $id: projectId }) as ProjectRow | null
		if (!project) return null

		try {
			const result = await this.client.session.create({
				body: { title: `${project.name} maintainer` },
				query: { directory: this.workspaceRoot },
			})
			const sessionId = result?.data?.id as string | undefined
			if (!sessionId) return null

			this.db.prepare("UPDATE projects SET maintainer_session_id=$sid WHERE id=$id")
				.run({ $sid: sessionId, $id: projectId })
			this.setSessionProject(sessionId, projectId)
			return sessionId
		} catch {
			return null
		}
	}

	async createProject(_name: string, desc: string, _customPath: string): Promise<ProjectRow> {
		const global = this.getGlobalProject()
		const description = desc?.trim()
		if (description) {
			this.db.prepare("UPDATE projects SET description=$description WHERE id=$id").run({ $description: description, $id: global.id })
			this.refreshGlobalProject()
		}
		return this.getGlobalProject()
	}

	listProjects(): ProjectRow[] {
		return [this.getGlobalProject()]
	}

	getProject(q: string): ProjectRow | null {
		void q
		return this.getGlobalProject()
	}
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function projectTools(mgr: ProjectManager, db: Database) {
	return {
		project_context_get: tool({
			description: "Get the global workspace CONTEXT.md path and confirm whether it exists.",
			args: { project: tool.schema.string().describe("Ignored; the global workspace is always used.") },
			async execute(): Promise<string> {
				const p = mgr.getGlobalProject()
				const ctx = projectContextPath(p.path)
				return `Global CONTEXT: \`${ctx}\` ${existsSync(ctx) ? "✓" : "(missing)"}`
			},
		}),

		project_context_sync: tool({
			description: "Refresh the generated task snapshot section inside the global CONTEXT.md while preserving manual content.",
			args: { project: tool.schema.string().describe("Ignored; the global workspace is always used.") },
			async execute(): Promise<string> {
				const p = mgr.getGlobalProject()
				const ctx = await syncProjectContextFile(db, p)
				return `Synced generated task snapshot in \`${ctx}\`.`
			},
		}),

	}
}

// ── Gating Hook ──────────────────────────────────────────────────────────────

export function projectGateHook(_mgr: ProjectManager) {
	// Single-global-workspace policy: no project gate. All sessions operate on
	// the same durable Kortix workspace, so hands-on tools should never be
	// blocked by project selection state.
	return async (_input: { tool: string; sessionID: string; callID: string }, _output: { args: any }) => {
		return
	}
}

// ── Status Injection ─────────────────────────────────────────────────────────

export function shouldInjectUnboundProjectStatus(_messageText: string): boolean {
	return false
}

export function projectStatusTransform(_mgr: ProjectManager, _getCurrentSessionId: () => string | null) {
	// Removed by design: project-status XML leaked into transcripts and the
	// runtime no longer has a separate project selection concept.
	return async (_input: any, _output: { messages: any[] }) => {
		return
	}
}
