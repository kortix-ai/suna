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
import { seedV2Project, DEFAULT_PM_SLUG, resolveDefaultModel } from "../../../src/services/project-v2-seed"
import { wakeAgentForProject, type OpenCodeClientLike } from "../../../src/services/ticket-triggers"
import { getAgentBySlug } from "../../../src/services/ticket-service"

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
		{ name: "id",          type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: true },
		{ name: "name",        type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false },
		{ name: "path",        type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false, unique: true },
		{ name: "description", type: "TEXT",    notNull: true,  defaultValue: "''", primaryKey: false },
		{ name: "created_at",  type: "TEXT",    notNull: true,  defaultValue: null, primaryKey: false },
		{ name: "opencode_id", type: "TEXT",    notNull: false, defaultValue: null, primaryKey: false },
		{ name: "maintainer_session_id", type: "TEXT", notNull: false, defaultValue: null, primaryKey: false },
		{ name: "structure_version", type: "INTEGER", notNull: true, defaultValue: "2", primaryKey: false },
		{ name: "user_handle", type: "TEXT", notNull: false, defaultValue: null, primaryKey: false },
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

	// client is publicly accessible so tools can invoke session.* directly.
	constructor(public client: any, private workspaceRoot: string, public db: Database) {}

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
		// Guard: never register a project AT the workspace root — that's the
		// "workspace" meta-project's slot. Callers that pass path=workspace
		// usually mean "create a sub-project"; picking a subfolder is safer
		// than silently creating a duplicate meta-project there.
		if (path.resolve(pp) === path.resolve(this.workspaceRoot)) {
			throw new Error(
				`Refusing to create project at workspace root (${pp}). ` +
				`Pass a subfolder path, e.g. ${path.join(this.workspaceRoot, name)}.`,
			)
		}
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
		return this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as ProjectRow[]
	}

	getProject(q: string): ProjectRow | null {
		return (this.db.prepare("SELECT * FROM projects WHERE path=$v").get({ $v: q })
			|| this.db.prepare("SELECT * FROM projects WHERE LOWER(name)=LOWER($v)").get({ $v: q })
			|| this.db.prepare("SELECT * FROM projects WHERE LOWER(name) LIKE LOWER($v)").get({ $v: `%${q}%` })
		) as ProjectRow | null
	}
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function projectTools(mgr: ProjectManager, db: Database) {
	return {
		project_create: tool({
			description: [
				"Create a v2 project (folder + Project Manager agent + default columns + PM onboarding session).",
				"Always seeds a real `.opencode/agent/project-manager.md` so PM is a first-class opencode agent in that project.",
				"If user_handle is provided, a PM onboarding chat is kicked off in a fresh session and that session id is returned — direct the human there to continue setup.",
				"WHEN TO CALL: ONLY when the user explicitly mentions the word \"project\" (e.g. \"create a project for X\", \"spin up a project to Y\", \"I want a project that Z\"). For any other \"build me X\" / \"make me Y\" request, do NOT call this tool — handle it directly as a hands-on lead.",
				"WHAT HAPPENS AFTER: A project is its own workhouse — once created, the project's PM + team execute the work via tickets. The agent that calls this tool DOES NOT execute on the project itself (no scaffolding, no edits, no bash). Your job after this call ends with handing the user off to the PM session. Do not load skills, write files, or run commands toward the project's goal — the team does that.",
			].join(" "),
			args: {
				name: tool.schema.string().describe("Project name"),
				description: tool.schema.string().describe('Description. "" if none.'),
				path: tool.schema.string().describe('Absolute path. "" for default.'),
				user_handle: tool.schema.string().optional().describe('Human\'s handle for @-mentions (e.g. "vukasinkubet"). If omitted, PM onboarding is NOT auto-fired and the project just gets seeded silently.'),
				default_model: tool.schema.string().optional().describe('Optional model override in "providerID/modelID" form to seed the PM + team with (e.g. "kortix-yolo/think", "kortix/minimax-m27"). Leave empty to auto-pick based on what the sandbox has credentials for. Pass this when the user has explicitly chosen a model for the project.'),
			},
			async execute(args: { name: string; description: string; path: string; user_handle?: string; default_model?: string }, toolCtx: ToolContext): Promise<string> {
				try {
					const p = await mgr.createProject(args.name, args.description, args.path)
					// Force v2 + record user handle if given. createProject inserts
					// with default structure_version=1, so flip it here.
					db.prepare(
						"UPDATE projects SET structure_version=2, user_handle=COALESCE($h, user_handle) WHERE id=$id"
					).run({ $h: args.user_handle?.trim() || null, $id: p.id })
					// Model to seed the PM + team with, in priority order:
					//   1. explicit `default_model` arg
					//   2. whatever model the CALLER session is using — so the
					//      project inherits the human's current pick
					//   3. fallback → resolveDefaultModel() in seedV2Project
					let inheritedModel: string | null = null
					if (!args.default_model?.trim() && toolCtx?.sessionID) {
						try {
							const msgsRes: any = await (mgr.client as any).session.messages({ path: { id: toolCtx.sessionID } })
							const msgs = (msgsRes?.data ?? msgsRes ?? []) as Array<{ info?: { role?: string; providerID?: string; modelID?: string } }>
							for (let i = msgs.length - 1; i >= 0; i--) {
								const info = msgs[i]?.info
								if (info?.role === 'assistant' && info.modelID) {
									const provider = (info.providerID || '').trim()
									const model = info.modelID.trim()
									// kortix-yolo stores the full `provider/id` in
									// modelID — avoid double-prefixing.
									inheritedModel = model.includes('/') ? model : (provider ? `${provider}/${model}` : model)
									break
								}
							}
						} catch (err) {
							console.warn('[project_create] failed to read caller session model:', (err as Error).message)
						}
					}
					// Seed PM agent, default columns, CONTEXT.md team section.
					await seedV2Project(db, {
						id: p.id,
						name: p.name,
						path: p.path,
						description: p.description,
						user_handle: args.user_handle || null,
					}, { defaultModel: args.default_model?.trim() || inheritedModel || null })
					// Always spawn the PM onboarding session so the response can hand
					// the user a clickable link. user_handle is optional — if missing,
					// PM addresses the human generically ("hey").
					let sessionLine = ""
					{
						const pm = getAgentBySlug(db, p.id, DEFAULT_PM_SLUG)
						if (pm) {
							const handleStr = args.user_handle ? `@${args.user_handle}` : "the human"
							const introAddressee = args.user_handle ? `@${args.user_handle}` : "them"
							const prompt = [
								`Fresh project "${p.name}". Human: ${handleStr}.`,
								p.description ? `User's description: ${p.description}` : null,
								"",
								"Run the onboarding interview from your persona. ONE short question at a time — no batching, no answering for the user. STOP after each turn and wait for their reply.",
								"",
								"Cover (in order): project · stack · role + reach-back · autonomy · starting team · columns/templates. Apply each piece only after approval, using your `project_manage` tools. Keep CONTEXT.md tight.",
								"",
								`Pass \`default_model: "${resolveDefaultModel()}"\` on every agent (matches what this sandbox has credentials for) unless the human asked for a different one during onboarding — in which case use their pick. Copy the Communication discipline block from your persona into each agent body_md verbatim.`,
								"",
								"Your messages follow the same rules as the team: short, decisive, no tables, no verdict banners.",
								"",
								`First message: brief intro + question #1, addressed to ${introAddressee}. Then STOP.`,
							].filter(Boolean).join("\n")
							const sid = await wakeAgentForProject({
								db,
								client: mgr.client as unknown as OpenCodeClientLike,
								projectId: p.id,
								agent: pm,
								sessionTitle: `Onboarding · ${p.name}`,
								prompt,
								bindSessionToProject: (sessionId, pid) => mgr.setSessionProject(sessionId, pid),
							}).catch((err) => {
								console.warn("[project_create] PM onboarding wake failed:", err)
								return null
							})
							if (sid) sessionLine = `\n\n→ [Open PM onboarding chat](/sessions/${sid})`
						}
					}
					const handoff = [
						"",
						"<system-reminder>",
						"STOP. The project scaffold is created — PM agent, default columns, dashboard ticket are all in place.",
						"Your ONLY remaining action: in ONE short sentence, tell the user the project is created and link the PM onboarding chat (use the markdown link above verbatim if a session was spawned, otherwise tell them to open the project from the sidebar to chat with PM).",
						"DO NOT call any other tool. DO NOT load skills. DO NOT write/edit/scaffold files. DO NOT run bash. The PM and the team execute the project's work via tickets — that is not your role.",
						"A project is its own workhouse. You are the router; the team is the workforce.",
						"</system-reminder>",
					].join("\n")
					return `Project **${p.name}** scaffolded at \`${p.path}\` (${p.id}) — PM agent + default columns + dashboard ticket ready.${sessionLine}${handoff}`
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
			async execute(args: { project: string; name: string; description: string }): Promise<string> {
				const p = mgr.getProject(args.project)
				if (!p) return "Not found."
				const n = args.name || p.name, d = args.description || p.description
				db.prepare("UPDATE projects SET name=$n,description=$d WHERE id=$id").run({ $n: n, $d: d, $id: p.id })
				return `Updated: **${n}**`
			},
		}),

		project_delete: tool({
			description: "Delete a project from the registry. Does NOT delete files on disk.",
			args: { project: tool.schema.string().describe("Project name or path") },
			async execute(args: { project: string }): Promise<string> {
				const p = mgr.getProject(args.project)
				if (!p) return `Project not found: "${args.project}"`
				db.prepare("DELETE FROM session_projects WHERE project_id=$pid").run({ $pid: p.id })
				db.prepare("DELETE FROM projects WHERE id=$id").run({ $id: p.id })
				return `Project **${p.name}** deleted from registry.\nDirectory \`${p.path}\` untouched.`
			},
		}),

		project_select: tool({
			description: [
				"Set the active project for this session. Must be called before file/bash/edit tools.",
				"WHEN TO CALL: only when the user explicitly asks to switch into an existing project (e.g. \"open the X project\", \"switch to Y\"). Do NOT call this just because you want to do file work — if the user only said \"build me X\", handle it directly without selecting a project.",
				"v2 PROJECT BLOCK: v2 projects (PM + team + tickets) refuse selection from agents outside their team. The session will NOT be bound; you will get a refusal — your only follow-up is to tell the user to switch to the PM session.",
			].join(" "),
			args: { project: tool.schema.string().describe('Project name or path.') },
			async execute(args: { project: string }, toolCtx: ToolContext): Promise<string> {
				if (!toolCtx?.sessionID) return "Error: no session context."
				const p = mgr.getProject(args.project)
				if (!p) return `Project "${args.project}" not found. Use project_list or project_create.`
				const sv = (p as unknown as { structure_version?: number }).structure_version ?? 1
				if (sv === 2) {
					// v2 enforcement: only team members of this project may bind the
					// session. Everyone else (general, orchestrator, etc.) gets refused.
					// Session stays UNBOUND → gate continues blocking hands-on tools.
					const isTeamMember = !!mgr.db.prepare(
						"SELECT 1 FROM project_agents WHERE project_id=$pid AND slug=$slug"
					).get({ $pid: p.id, $slug: toolCtx.agent })
					if (!isTeamMember) {
						return [
							`REFUSED. Cannot select v2 project "${p.name}" — agent "${toolCtx.agent}" is not on this project's team.`,
							`The session has NOT been bound. All hands-on tools (bash, edit, write, skill, etc.) will continue to be blocked.`,
							``,
							`<system-reminder>`,
							`STOP. v2 projects are owned by their PM + team via tickets. You are NOT on this project's team.`,
							`Your only remaining action: tell the user in ONE short sentence to switch to the @project-manager session for "${p.name}". That session is where the work happens.`,
							`Do NOT call any other tool. The session is unbound by design — you cannot proceed.`,
							`</system-reminder>`,
						].join("\n")
					}
				}
				mgr.setSessionProject(toolCtx.sessionID, p.id)
				return `Project **${p.name}** selected for this session.\nPath: \`${p.path}\`\nYou can now use file, bash, and edit tools.`
			},
		}),
	}
}

// ── Gating Hook ──────────────────────────────────────────────────────────────

export function projectGateHook(_mgr: ProjectManager) {
	// Previously this hook blocked EVERY non-project tool (bash, read, edit,
	// skill, web_search, …) until a project was selected. That made the
	// default chat unusable for general requests: users had to create a
	// project before the agent could do anything at all.
	//
	// New policy: fail open. The default chat is for general work — trust
	// the agent's tool descriptions (e.g. `project_create`'s "ONLY when the
	// user explicitly mentions the word 'project'") to decide when to bind
	// to a project. If the user just asks "write me a script", the agent
	// can call `write` directly without a project-select dance.
	//
	// V2 projects still enforce role-based routing via
	// `projectStatusTransform` (non-team agents inside a bound v2 project
	// are told they can only route, not execute).
	return async (_input: { tool: string; sessionID: string; callID: string }, _output: { args: any }) => {
		return
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
					const sv = (project as unknown as { structure_version?: number }).structure_version ?? 1
					// What agent is the current session running as? Pull from the latest msg.
					let currentAgent: string | null = null
					for (let i = output.messages.length - 1; i >= 0; i--) {
						const a = output.messages[i]?.info?.agent
						if (a) { currentAgent = a; break }
					}
					// v2 projects have a PM + team that owns execution. Non-team agents
					// (general, orchestrator, etc.) must NOT do hands-on work here —
					// they route the user to the appropriate team session.
					const isTeamAgent = !!currentAgent && !!mgr.db.prepare(
						"SELECT 1 FROM project_agents WHERE project_id=$pid AND slug=$slug"
					).get({ $pid: project.id, $slug: currentAgent })
					if (sv === 2 && !isTeamAgent) {
						statusXml = [
							`<system-reminder>`,
							`STOP. Session is bound to v2 project "${project.name}" (${project.path}).`,
							`A v2 project owns its own execution: the Project Manager + the team it builds do the work via tickets. You (${currentAgent || "this agent"}) are NOT a team member of this project.`,
							``,
							`Your role here is ROUTING ONLY:`,
							`  - If the user wants the project's work done → tell them to switch to the @project-manager session for that project. ONE short sentence.`,
							`  - If the user wants something OUTSIDE this project → tell them you can't act here and to start a new general session (no project bound).`,
							``,
							`DO NOT call: bash, edit, write, skill, web_search, webfetch, scrape_webpage, read, grep, glob, pty_*, task_create, or any other hands-on tool. The team executes — not you.`,
							`Tools you MAY use: project_list, project_get, question, show.`,
							`</system-reminder>`,
						].join("\n")
					} else {
						statusXml = `<project_status selected="${project.name}" path="${project.path}" version="${sv}" />`
					}
				} else {
					// No project bound. That's fine for general chat — the default
					// agent should just do the work. Only surface a soft hint that
					// a project exists if the user asks for project-scoped things.
					let projectList = ""
					try {
						const projects = mgr.listProjects()
						if (projects.length > 0) {
							projectList = ` Existing projects: ${projects.map(p => `"${p.name}"`).join(", ")}.`
						}
					} catch {}
					statusXml = [
						`<project_status selected="none" />`,
						`<!-- No project is bound to this session. Act directly on the user's request.`,
						`     Only call project_create when the user explicitly says "project" — e.g.`,
						`     "create a project for X" / "spin up a project to Y".`,
						`     Call project_select only if the user references an existing one by name.${projectList} -->`,
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
