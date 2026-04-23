/**
 * Kortix Projects — project CRUD + session-project linking + file gating.
 *
 * SQLite (kortix.db) is the single source of truth.
 * No filesystem scanning, no markers.
 */

import { Database } from "bun:sqlite"
import * as fs from "node:fs/promises"
import { existsSync, mkdirSync, unlinkSync, statSync } from "node:fs"
import * as path from "node:path"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { ensureGlobalMemoryFiles } from "./lib/paths"
import { ensureSchema } from "./lib/schema"
import { canForSession, denyMessage } from "./lib/scope-check"
import {
	deleteProjectWorkspace,
	ensureProjectWorkspace,
} from "../../../src/services/project-access-client"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProjectRow {
	id: string; name: string; path: string; description: string
	created_at: string; opencode_id: string | null
	/** Hidden project-maintainer session id. Auto-created on first task lifecycle event. */
	maintainer_session_id?: string | null
}

export const PROJECT_MAINTAINER_AGENT = "project-maintainer"

const TASK_SUMMARY_START = "<!-- KORTIX:TASK-SUMMARY:START -->"
const TASK_SUMMARY_END = "<!-- KORTIX:TASK-SUMMARY:END -->"

function projectContextPath(projectPath: string): string {
	return path.join(projectPath, ".kortix", "CONTEXT.md")
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
		{ name: "id",          type: "TEXT", notNull: true,  defaultValue: null,      primaryKey: true },
		{ name: "name",        type: "TEXT", notNull: true,  defaultValue: null,      primaryKey: false },
		{ name: "path",        type: "TEXT", notNull: true,  defaultValue: null,      primaryKey: false, unique: true },
		{ name: "description", type: "TEXT", notNull: true,  defaultValue: "''",      primaryKey: false },
		{ name: "created_at",  type: "TEXT", notNull: true,  defaultValue: null,      primaryKey: false },
		{ name: "opencode_id", type: "TEXT", notNull: false, defaultValue: null,      primaryKey: false },
		{ name: "maintainer_session_id", type: "TEXT", notNull: false, defaultValue: null, primaryKey: false },
		{ name: "kind",        type: "TEXT", notNull: true,  defaultValue: "'scoped'", primaryKey: false },
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

function projectId(name: string): string {
	return `proj-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`
}

export class ProjectManager {
	private sessionProjectCache = new Map<string, ProjectRow>()

	constructor(private client: any, private workspaceRoot: string, public db: Database) {}

	getSessionProject(sessionId: string): ProjectRow | null {
		const cached = this.sessionProjectCache.get(sessionId)
		if (cached) return cached
		const row = this.db.prepare("SELECT p.* FROM session_projects sp JOIN projects p ON sp.project_id = p.id WHERE sp.session_id = $sid")
			.get({ $sid: sessionId }) as ProjectRow | null
		if (row) this.sessionProjectCache.set(sessionId, row)
		return row
	}

	setSessionProject(sessionId: string, projectId: string): void {
		this.db.prepare("INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)")
			.run({ $sid: sessionId, $pid: projectId, $now: new Date().toISOString() })
		const project = this.db.prepare("SELECT * FROM projects WHERE id = $id").get({ $id: projectId }) as ProjectRow | null
		if (project) this.sessionProjectCache.set(sessionId, project)
	}

	getMaintainerSessionId(projectId: string): string | null {
		const row = this.db.prepare("SELECT maintainer_session_id FROM projects WHERE id = $id").get({ $id: projectId }) as { maintainer_session_id?: string | null } | null
		return row?.maintainer_session_id || null
	}

	/**
	 * Ensure a hidden project-maintainer session exists for this project, creating
	 * one lazily on first invocation. Stored in the `maintainer_session_id` column.
	 * Returns the session id on success, or null if creation failed.
	 */
	async ensureMaintainerSession(projectId: string): Promise<string | null> {
		const existing = this.getMaintainerSessionId(projectId)
		if (existing) return existing

		const project = this.db.prepare("SELECT * FROM projects WHERE id = $id").get({ $id: projectId }) as ProjectRow | null
		if (!project) return null

		try {
			const result = await this.client.session.create({
				body: { title: `${project.name} maintainer` },
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

	async createProject(name: string, desc: string, customPath: string): Promise<ProjectRow> {
		const pp = customPath || path.join(this.workspaceRoot, "projects", name)
		const existing = this.db.prepare("SELECT * FROM projects WHERE path=$p").get({ $p: pp }) as ProjectRow | null
		if (existing) {
			if (desc) { this.db.prepare("UPDATE projects SET description=$d WHERE id=$id").run({ $d: desc, $id: existing.id }); existing.description = desc }
			return existing
		}
		const wm = async (f: string, c: string) => { if (!existsSync(f)) await fs.writeFile(f, c, "utf8") }
		await fs.mkdir(path.join(pp, ".kortix"), { recursive: true })
		ensureGlobalMemoryFiles(import.meta.dir)
		await wm(path.join(pp, ".kortix", "CONTEXT.md"), `# ${name}\n\n${desc || "No description."}\n`)
		const id = projectId(name), now = new Date().toISOString()
		let opencodeId: string | null = null
		try {
			const ocResult = await this.client.project.current({ directory: pp })
			const ocProject = ocResult.data as any
			if (ocProject?.id && ocProject.id !== "global") opencodeId = ocProject.id
		} catch {}
		this.db.prepare("INSERT INTO projects (id,name,path,description,created_at,opencode_id) VALUES ($id,$n,$p,$d,$c,$oid)")
			.run({ $id: id, $n: name, $p: pp, $d: desc || "", $c: now, $oid: opencodeId })
		return { id, name, path: pp, description: desc || "", created_at: now, opencode_id: opencodeId }
	}

	listProjects(): ProjectRow[] {
		const all = this.db
			.prepare("SELECT * FROM projects ORDER BY created_at DESC")
			.all() as ProjectRow[]
		return this.filterForCurrentMember(all)
	}

	getProject(q: string): ProjectRow | null {
		const hit = (this.db.prepare("SELECT * FROM projects WHERE path=$v").get({ $v: q })
			|| this.db.prepare("SELECT * FROM projects WHERE LOWER(name)=LOWER($v)").get({ $v: q })
			|| this.db.prepare("SELECT * FROM projects WHERE LOWER(name) LIKE LOWER($v)").get({ $v: `%${q}%` })
		) as ProjectRow | null
		if (!hit) return null
		return this.filterForCurrentMember([hit]).at(0) ?? null
	}

	private filterForCurrentMember(rows: ProjectRow[]): ProjectRow[] {
		const userId = process.env.KORTIX_USER_ID?.trim()
		const role = process.env.KORTIX_USER_ROLE?.trim()
		const isManager = role === "owner" || role === "admin" || role === "platform_admin"
		if (!userId || isManager) return rows
		const grantRows = this.db
			.prepare("SELECT project_id FROM project_members WHERE user_id=$uid")
			.all({ $uid: userId }) as Array<{ project_id: string }>
		const allowed = new Set(grantRows.map((r) => r.project_id))
		return rows.filter((p) => allowed.has(p.id))
	}
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function projectTools(mgr: ProjectManager, db: Database) {
	return {
		project_create: tool({
			description: "Register a directory as a project (new or existing). Never overwrites existing files.",
			args: {
				name: tool.schema.string().describe("Project name"),
				description: tool.schema.string().describe('Description. "" if none.'),
				path: tool.schema.string().describe('Absolute path. "" for default.'),
			},
			async execute(args: { name: string; description: string; path: string }, toolCtx: ToolContext): Promise<string> {
				if (!(await canForSession(toolCtx?.sessionID, "projects:create"))) {
					return denyMessage("projects:create")
				}
				const rawPath = (args.path || "").trim().replace(/\/+$/, "")
				const reserved = new Set(["/", "/workspace", "/tmp", "/opt", "/srv", "/srv/kortix", "/home", "/etc", "/var"])
				if (!rawPath) return "Failed: path is required."
				if (!rawPath.startsWith("/")) return "Failed: path must be absolute."
				if (reserved.has(rawPath)) return `Failed: "${rawPath}" is reserved. Pick a subdirectory.`
				if (rawPath.includes("..")) return `Failed: invalid path.`

				try {
					const p = await mgr.createProject(args.name, args.description, rawPath)
					try {
						await ensureProjectWorkspace({ projectId: p.id, kind: "scoped", members: [], migrateFrom: rawPath })
					} catch (err) {
						console.warn(`[project_create] supervisor ensure failed for ${p.id}:`, err)
					}
					return `Project **${p.name}** at \`${p.path}\` (${p.id})`
				} catch (e) { return `Failed: ${e instanceof Error ? e.message : "unknown"}` }
			},
		}),

		project_list: tool({
			description: "List all projects from Kortix SQLite.",
			args: {},
			async execute(): Promise<string> {
				const ps = mgr.listProjects()
				if (!ps.length) return "No projects yet. Use `project_create` to create one."
				const lines = ps.map(p => `| **${p.name}** | \`${p.path}\` | ${p.description || "—"} |`)
				return `| Project | Path | Description |\n|---|---|---|\n${lines.join("\n")}\n\n${ps.length} project${ps.length !== 1 ? "s" : ""}.`
			},
		}),

		project_get: tool({
			description: "Get project details and session info.",
			args: { name: tool.schema.string().describe("Name or path") },
			async execute(args: { name: string }): Promise<string> {
				const p = mgr.getProject(args.name)
				if (!p) return `Project not found: "${args.name}"`
				const contextPath = path.join(p.path, ".kortix", "CONTEXT.md")
				return [
					`## ${p.name}`, ``, `**Path:** \`${p.path}\``,
					p.description ? `**Description:** ${p.description}` : null,
					`**ID:** \`${p.id}\``, ``,
					`**Context:** \`${contextPath}\` ${existsSync(contextPath) ? "✓" : "(not created)"}`,
				].filter(Boolean).join("\n")
			},
		}),

		project_context_get: tool({
			description: "Get the current project's CONTEXT.md path and confirm whether it exists.",
			args: { project: tool.schema.string().describe("Project name or path") },
			async execute(args: { project: string }): Promise<string> {
				const p = mgr.getProject(args.project)
				if (!p) return `Project not found: "${args.project}"`
				const ctx = projectContextPath(p.path)
				return `Project CONTEXT: \`${ctx}\` ${existsSync(ctx) ? "✓" : "(missing)"}`
			},
		}),

		project_context_sync: tool({
			description: "Refresh the generated task snapshot section inside the project's CONTEXT.md while preserving manual content.",
			args: { project: tool.schema.string().describe("Project name or path") },
			async execute(args: { project: string }): Promise<string> {
				const p = mgr.getProject(args.project)
				if (!p) return `Project not found: "${args.project}"`
				const ctx = await syncProjectContextFile(db, p)
				return `Synced generated task snapshot in \`${ctx}\`.`
			},
		}),

		project_update: tool({
			description: "Update project name/description.",
			args: {
				project: tool.schema.string().describe("Name or path"),
				name: tool.schema.string().describe('"" to keep current'),
				description: tool.schema.string().describe('"" to keep current'),
			},
			async execute(args: { project: string; name: string; description: string }, toolCtx: ToolContext): Promise<string> {
				if (!(await canForSession(toolCtx?.sessionID, "projects:rename"))) {
					return denyMessage("projects:rename")
				}
				const p = mgr.getProject(args.project)
				if (!p) return "Not found."
				const n = args.name || p.name
				const d = args.description || p.description
				db.prepare("UPDATE projects SET name=$n,description=$d WHERE id=$id").run({ $n: n, $d: d, $id: p.id })

				const ctxPath = path.join(p.path, ".kortix", "CONTEXT.md")
				try {
					await fs.mkdir(path.dirname(ctxPath), { recursive: true })
					let content: string
					try {
						content = await fs.readFile(ctxPath, "utf8")
					} catch {
						content = ""
					}
					const trimmed = content.trimStart()
					if (/^#\s+/.test(trimmed)) {
						content = content.replace(/^(\s*)#\s+[^\n]*/, `$1# ${n}`)
					} else {
						const body = content ? `\n\n${content}` : ""
						content = `# ${n}${d ? `\n\n${d}` : ""}${body || "\n"}`
					}
					await fs.writeFile(ctxPath, content, "utf8")
				} catch (err) {
					console.warn(`[project_update] CONTEXT.md sync failed for ${p.id}:`, err)
				}

				return `Updated: **${n}**`
			},
		}),

		project_delete: tool({
			description: "Delete a project from the registry. Does NOT delete files on disk.",
			args: { project: tool.schema.string().describe("Project name or path") },
			async execute(args: { project: string }, toolCtx: ToolContext): Promise<string> {
				if (!(await canForSession(toolCtx?.sessionID, "projects:delete"))) {
					return denyMessage("projects:delete")
				}
				const p = mgr.getProject(args.project)
				if (!p) return `Project not found: "${args.project}"`
				db.prepare("DELETE FROM session_projects WHERE project_id=$pid").run({ $pid: p.id })
				db.prepare("DELETE FROM project_members WHERE project_id=$pid").run({ $pid: p.id })
				db.prepare("DELETE FROM projects WHERE id=$id").run({ $id: p.id })
				try {
					await deleteProjectWorkspace({ projectId: p.id })
				} catch (err) {
					console.warn(`[project_delete] supervisor delete failed for ${p.id}:`, err)
				}
				return `Project **${p.name}** deleted from registry.\nLegacy dir \`${p.path}\` untouched; isolated dir archived.`
			},
		}),

		project_select: tool({
			description: "Set the active project for this session. Must be called before file/bash/edit tools.",
			args: { project: tool.schema.string().describe('Project name or path.') },
			async execute(args: { project: string }, toolCtx: ToolContext): Promise<string> {
				if (!toolCtx?.sessionID) return "Error: no session context."
				const p = mgr.getProject(args.project)
				if (!p) return `Project "${args.project}" not found. Use project_list or project_create.`
				mgr.setSessionProject(toolCtx.sessionID, p.id)
				return `Project **${p.name}** selected for this session.\nPath: \`${p.path}\`\nYou can now use file, bash, and edit tools.`
			},
		}),
	}
}

// ── Gating Hook ──────────────────────────────────────────────────────────────

export function projectGateHook(mgr: ProjectManager) {
	// Tools that are ALWAYS allowed without a project
	// ONLY project tools and question are allowed without a project.
	// Everything else — including web search, read, skill — is blocked.
	const UNGATED = new Set([
		"project_create", "project_list", "project_get", "project_update",
		"project_context_get", "project_context_sync",
		"project_delete", "project_select",
		"question",
		"show",
	])

	return async (input: { tool: string; sessionID: string; callID: string }, _output: { args: any }) => {
		const n = input.tool.replace(/-/g, "_")
		if (UNGATED.has(n)) return
		if (!input.sessionID) return
		try {
			if (mgr.getSessionProject(input.sessionID)) return
		} catch { return } // DB error — fail open
		throw new Error(
			`No project selected for this session. You must select or create a project first.\n` +
			`Use project_list to see existing projects, then project_select to choose one.\n` +
			`Or use project_create to register a new project directory.`
		)
	}
}

// ── Status Injection ─────────────────────────────────────────────────────────

export function projectStatusTransform(mgr: ProjectManager, getCurrentSessionId: () => string | null) {
	return async (_input: any, output: { messages: any[] }) => {
		try {
			let sid = getCurrentSessionId()
			if (!sid) {
				for (const m of output.messages) {
					const msgSid = m?.info?.sessionID || m?.sessionID
					if (msgSid) { sid = msgSid; break }
				}
			}
			if (!sid) return
			let statusXml: string
			try {
				const project = mgr.getSessionProject(sid)
				if (project) {
					statusXml = `<project_status selected="${project.name}" path="${project.path}" />`
				} else {
					let projectList = ""
					try {
						const projects = mgr.listProjects()
						if (projects.length > 0) {
							projectList = `\nExisting projects: ${projects.map(p => `"${p.name}" (${p.path})`).join(", ")}`
						}
					} catch {}
					statusXml = [
						`<system-reminder>`,
						`STOP. DO NOT CALL ANY TOOL EXCEPT project_list, project_create, project_select, OR question.`,
						``,
						`No project is selected for this session. You MUST select one before doing ANY work.`,
						`Your very next tool call must be one of: project_list, project_create, project_select, or question.`,
						`If you call bash, read, write, edit, skill, web_search, or any other tool, you are violating your instructions.`,
						`${projectList}`,
						``,
						`Step 1: Call project_list to see existing projects.`,
						`Step 2: Either project_select an existing one, or project_create + project_select a new one.`,
						`Step 3: ONLY THEN address the user's request.`,
						`</system-reminder>`,
					].join("\n")
				}
			} catch { return }
			const messages = output.messages
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i]?.info?.role === "user") {
					if (!Array.isArray(messages[i].parts)) messages[i].parts = []
					messages[i].parts.push({ type: "text", text: `<kortix_system type="project-status" source="kortix-system">${statusXml}</kortix_system>` })
					break
				}
			}
		} catch {}
	}
}
