/**
 * Unified task orchestration system.
 *
 * Canonical task_* tools + compatibility agent_task* aliases + worker lifecycle tools + 1 event handler:
 *   task_create / agent_task        — create (+ optionally auto-run)
 *   task_update / agent_task_update — start / approve / cancel / message
 *   task_list   / agent_task_list   — list tasks
 *   task_get    / agent_task_get    — get task details
 *   task_status                     — get live task/run/session status
 *
 * Statuses: todo, in_progress, input_needed, awaiting_review, completed, cancelled
 *
 * Workers now use structured lifecycle tools:
 * task_progress / task_blocker / task_evidence / task_verification / task_deliver.
 * Legacy idle-based completion handling remains as fallback for unfinished runs.
 */

import { Database } from "bun:sqlite"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { PROJECT_MAINTAINER_AGENT, type ProjectManager } from "./projects"
import {
	addTaskEvidence,
	blockTask,
	cancelTask,
	createTask,
	deliverTask,
	getTaskByOwnerSession,
	getTaskByIdForProject,
	getTaskResolvedForProject,
	getTaskLiveStatus,
	listTasksResolved,
	progressTask,
	patchTask,
	recordTaskEvent,
	startTask,
	type OpenCodeClientLike,
	type TaskEventType,
	type TaskRow,
	type TaskStatus,
	nowIso,
} from "../../../src/services/task-service"

// ── Session tracking ─────────────────────────────────────────────────────────

let autoworkActiveSessions: Set<string>
try {
	const mod = require("./autowork/autowork")
	autoworkActiveSessions = mod.autoworkActiveSessions ?? new Set<string>()
} catch {
	autoworkActiveSessions = new Set<string>()
}

const activeTaskSessions = new Set<string>()

function isTerminal(status: TaskStatus): boolean {
	return status === "completed" || status === "cancelled"
}

async function notifyTaskLifecycle(
	client: any,
	db: Database,
	mgr: ProjectManager,
	task: TaskRow,
	type: TaskEventType,
	message: string,
	bodyLines: string[],
): Promise<void> {
	const eventText = bodyLines.join("\n")

	// 1. Notify the creator session (whoever ran task_create) if it exists.
	if (task.parent_session_id) {
		try {
			await client.session.promptAsync({
				path: { id: task.parent_session_id },
				body: { parts: [{ type: "text", text: eventText }] },
			})
		} catch {
			// non-fatal notification path
		}
	}

	// 2. Fan out to the hidden project-maintainer so it can keep CONTEXT.md current.
	try {
		const maintainerId = await mgr.ensureMaintainerSession(task.project_id)
		if (maintainerId && maintainerId !== task.parent_session_id) {
			const maintainerBody = [
				"<project_maintainer_event>",
				`Project: ${task.project_id}`,
				`Task: ${task.id}`,
				`Title: ${task.title}`,
				`Status: ${task.status}`,
				`Event: ${type}`,
				message ? `Message: ${message}` : null,
				"",
				eventText,
				"</project_maintainer_event>",
				"",
				"Update .kortix/CONTEXT.md to reflect this event, then call project_context_sync and stop.",
			].filter((line): line is string => line !== null).join("\n")
			await client.session.promptAsync({
				path: { id: maintainerId },
				body: { agent: PROJECT_MAINTAINER_AGENT, parts: [{ type: "text", text: maintainerBody }] },
			})
		}
	} catch {
		// non-fatal — maintainer fanout never blocks task lifecycle
	}
}

function getCurrentTaskForWorker(db: Database, ctx: ToolContext): TaskRow | null {
	if (!ctx?.sessionID) return null
	return getTaskByOwnerSession(db, ctx.sessionID)
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function agentTaskTools(db: Database, mgr: ProjectManager, client: any) {
	function getProjectId(ctx: ToolContext): string | null {
		if (!ctx?.sessionID) return null
		return mgr.getSessionProject(ctx.sessionID)?.id || null
	}

	async function createTaskExecute(args: { title: string; description?: string; verification_condition?: string; autostart?: boolean; status?: string }, ctx: ToolContext): Promise<string> {
		const pid = getProjectId(ctx)
		if (!pid) return "Error: no project selected."

		const shouldStart = args.autostart !== false
		const created = createTask(db, {
			project_id: pid,
			title: args.title,
			description: args.description,
			verification_condition: args.verification_condition,
			status: args.status,
		})

		if (!shouldStart) {
			return `Task **${created.id}** created: ${created.title} [${created.status}]`
		}

		try {
			const started = await startTask({
				db,
				client: client as OpenCodeClientLike,
				taskId: created.id,
				parentSessionId: ctx.sessionID,
				bindSessionProject: (sessionId, projectId) => mgr.setSessionProject(sessionId, projectId),
				onWorkerSessionCreated: (sessionId) => activeTaskSessions.add(sessionId),
			})
			return `Task **${created.id}** created and started. Worker session: ${started.owner_session_id}`
		} catch (err) {
			return `Task **${created.id}** created but failed to start worker: ${err}`
		}
	}

	async function taskUpdateExecute(args: { id: string; action: string; message?: string }, ctx: ToolContext): Promise<string> {
		const pid = getProjectId(ctx)
		if (!pid) return "Error: no project selected."
		const task = getTaskByIdForProject(db, args.id, pid)
		if (!task) return `Task not found: ${args.id}`

			switch (args.action) {
				case "start": {
				if (task.status === "in_progress") return "Task is already running."
				if (isTerminal(task.status)) return `Cannot start a ${task.status} task.`
				try {
					const started = await startTask({
						db,
						client: client as OpenCodeClientLike,
						taskId: task.id,
						parentSessionId: ctx.sessionID,
						bindSessionProject: (sessionId, projectId) => mgr.setSessionProject(sessionId, projectId),
						onWorkerSessionCreated: (sessionId) => activeTaskSessions.add(sessionId),
					})
					return `Task **${task.id}** started. Worker session: ${started.owner_session_id}`
				} catch (err) {
					return `Task **${task.id}** failed to start: ${err}`
				}
				}

				case "approve": {
					return `Human review required. Task **${task.id}** is in [1mawaiting_review[0m and must be completed through the human review UI/HTTP approval path, not by the orchestrator.`
				}

			case "cancel": {
				const cancelled = await cancelTask(db, client as OpenCodeClientLike, task.id)
				if (cancelled.owner_session_id) activeTaskSessions.delete(cancelled.owner_session_id)
				return `Task **${task.id}** cancelled.`
			}

			case "message": {
				if (!args.message) return "Error: message is required for action=message."
				if (!task.owner_session_id) return "Task has no active session."
				activeTaskSessions.add(task.owner_session_id)
				if (task.status !== "in_progress") {
					patchTask(db, task.id, { status: "todo" as any })
					await startTask({
						db,
						client: client as OpenCodeClientLike,
						taskId: task.id,
						parentSessionId: ctx.sessionID,
						bindSessionProject: (sessionId, projectId) => mgr.setSessionProject(sessionId, projectId),
						onWorkerSessionCreated: (sessionId) => activeTaskSessions.add(sessionId),
					})
				}
				client.session.promptAsync({
					path: { id: task.owner_session_id },
					body: { parts: [{ type: "text", text: args.message }] },
				}).catch(() => {})
				return `Message sent to task **${task.id}** worker.`
			}

			default:
				return `Unknown action: ${args.action}. Use "start", "approve", "cancel", or "message".`
		}
	}

	async function taskListExecute(args: { status?: string }, ctx: ToolContext): Promise<string> {
		const pid = getProjectId(ctx)
		if (!pid) return "Error: no project selected."
		const tasks = await listTasksResolved(db, client as OpenCodeClientLike, { projectId: pid, status: args.status })
		if (!tasks.length) return args.status ? `No ${args.status} tasks.` : "No tasks in this project."
		const icon = (s: string) => s === "in_progress" ? "→" : s === "input_needed" ? "◐" : s === "awaiting_review" ? "◌" : s === "completed" ? "✓" : s === "cancelled" ? "✗" : "○"
		return tasks.map((t) => `${icon(t.status)} **${t.id}** ${t.title} — ${t.status}${t.owner_session_id ? ` [session: ${t.owner_session_id}]` : ""}`).join("\n")
	}

	async function taskGetExecute(args: { id: string }, ctx: ToolContext): Promise<string> {
		const pid = getProjectId(ctx)
		if (!pid) return "Error: no project selected."
		const task = await getTaskResolvedForProject(db, client as OpenCodeClientLike, args.id, pid)
		if (!task) return `Task not found: ${args.id}`
		const lines = [
			`## ${task.title}`,
			"",
			`**ID:** ${task.id}`,
			`**Status:** ${task.status}`,
			`**Session:** ${task.owner_session_id || "—"}`,
			`**Description:** ${task.description || "—"}`,
			`**Verification:** ${task.verification_condition || "—"}`,
		]
		if (task.result) lines.push(`**Result:** ${task.result}`)
		if (task.verification_summary) lines.push(`**Verification Summary:** ${task.verification_summary}`)
		if (task.blocking_question) lines.push(`**Blocking Question:** ${task.blocking_question}`)
		return lines.join("\n")
	}

	async function taskStatusExecute(args: { id: string }, ctx: ToolContext): Promise<string> {
		const pid = getProjectId(ctx)
		if (!pid) return "Error: no project selected."
		const task = getTaskByIdForProject(db, args.id, pid)
		if (!task) return `Task not found: ${args.id}`
		const live = await getTaskLiveStatus(db, client as OpenCodeClientLike, task.id)
		return [
			`## Task Status`,
			``,
			`**Task:** ${task.title}`,
			`**ID:** ${live.task_id}`,
			`**Status:** ${live.status}`,
			`**Run ID:** ${live.latest_run_id || "—"}`,
			`**Run Status:** ${live.run_status || "—"}`,
			`**Worker Session:** ${live.owner_session_id || "—"}`,
			`**Detail:** ${live.detail}`,
		].join("\n")
	}

	return {
		// ── agent_task: create (+ optionally auto-run) ───────────
		agent_task: tool({
			description: [
				"Create a task. By default, immediately spawns a worker to execute it.",
				"Set autostart=false to create without running (stays in todo for later).",
				"Worker runs autonomously in an autowork loop and should report structured delivery/blockers back to the orchestrator.",
			].join(" "),
			args: {
				title: tool.schema.string().describe("What needs to be done"),
				description: tool.schema.string().optional().describe("Detailed scope and instructions for the worker"),
				verification_condition: tool.schema.string().optional().describe("How to verify the task is done"),
				autostart: tool.schema.boolean().optional().describe("Auto-spawn worker (default: true). Set false to plan without running."),
				status: tool.schema.string().optional().describe('Only used with autostart=false. Default: "todo".'),
			},
			async execute(args: { title: string; description?: string; verification_condition?: string; autostart?: boolean; status?: string }, ctx: ToolContext): Promise<string> {
				return createTaskExecute(args, ctx)
			},
		}),

		task_create: tool({
			description: "Canonical task creation tool. Creates a task and optionally starts a worker immediately.",
			args: {
				title: tool.schema.string().describe("What needs to be done"),
				description: tool.schema.string().optional().describe("Detailed scope and instructions for the worker"),
				verification_condition: tool.schema.string().optional().describe("How to verify the task is done"),
				autostart: tool.schema.boolean().optional().describe("Auto-spawn worker (default: true). Set false to leave it in todo."),
				status: tool.schema.string().optional().describe('Only used with autostart=false. Default: "todo".'),
			},
			async execute(args: { title: string; description?: string; verification_condition?: string; autostart?: boolean; status?: string }, ctx: ToolContext): Promise<string> {
				return createTaskExecute(args, ctx)
			},
		}),

		// ── agent_task_update: start / approve / cancel / message ─
			agent_task_update: tool({
				description: [
					"Update a task. Actions:",
					'  "start" — spawn a worker for a todo task',
					'  "approve" — reserved for human review flow (tool will refuse)',
					'  "cancel" — cancel task + abort worker session if running',
					'  "message" — send a follow-up message to the running worker',
				].join("\n"),
			args: {
				id: tool.schema.string().describe("Task ID"),
				action: tool.schema.string().describe('"start", "approve", "cancel", or "message"'),
				message: tool.schema.string().optional().describe("Message to send (required for action=message)"),
			},
			async execute(args: { id: string; action: string; message?: string }, ctx: ToolContext): Promise<string> {
				return taskUpdateExecute(args, ctx)
			},
		}),

			task_update: tool({
				description: "Canonical task lifecycle tool. Actions: start, cancel, or message. Human approval remains outside the orchestrator tool flow.",
			args: {
				id: tool.schema.string().describe("Task ID"),
				action: tool.schema.string().describe('"start", "approve", "cancel", or "message"'),
				message: tool.schema.string().optional().describe("Message to send (required for action=message)"),
			},
			async execute(args: { id: string; action: string; message?: string }, ctx: ToolContext): Promise<string> {
				return taskUpdateExecute(args, ctx)
			},
		}),

		task_progress: tool({
			description: "Record structured progress for the current worker-owned task.",
			args: {
				message: tool.schema.string().describe("Progress update"),
			},
			async execute(args: { message: string }, ctx: ToolContext): Promise<string> {
				const task = getCurrentTaskForWorker(db, ctx)
				if (!task) return "Error: no active worker-owned task for this session."
				progressTask(db, { taskId: task.id, sessionId: ctx.sessionID, message: args.message })
				return `Progress recorded for task **${task.id}**.`
			},
		}),

		task_blocker: tool({
			description: "Record a blocker for the current task and notify the parent orchestrator first, with manager mirroring if configured.",
			args: {
				question: tool.schema.string().describe("What input or decision is needed"),
			},
			async execute(args: { question: string }, ctx: ToolContext): Promise<string> {
				const task = getCurrentTaskForWorker(db, ctx)
				if (!task) return "Error: no active worker-owned task for this session."
				const blocked = blockTask(db, { taskId: task.id, sessionId: ctx.sessionID, message: args.question })
				await notifyTaskLifecycle(client, db, mgr, blocked, "blocker", args.question, [
					"<task_blocker>",
					`Task: ${blocked.id}`,
					`Title: ${blocked.title}`,
					`Status: ${blocked.status}`,
					"",
					args.question,
					"</task_blocker>",
				])
				return `Blocker recorded for task **${blocked.id}**.`
			},
		}),

		task_evidence: tool({
			description: "Attach structured evidence metadata to the current task.",
			args: {
				path: tool.schema.string().optional().describe("Filesystem path to evidence"),
				kind: tool.schema.string().optional().describe("Evidence type, e.g. test-report, screenshot, diff"),
				summary: tool.schema.string().optional().describe("Short evidence summary"),
			},
			async execute(args: { path?: string; kind?: string; summary?: string }, ctx: ToolContext): Promise<string> {
				const task = getCurrentTaskForWorker(db, ctx)
				if (!task) return "Error: no active worker-owned task for this session."
				addTaskEvidence(db, {
					taskId: task.id,
					sessionId: ctx.sessionID,
					message: args.summary || args.path || args.kind || "Evidence attached",
					payload: { path: args.path || null, kind: args.kind || null },
				})
				return `Evidence recorded for task **${task.id}**.`
			},
		}),

		task_verification: tool({
			description: "Record a structured verification stage for the current task.",
			args: {
				stage: tool.schema.string().describe('One of: "started", "passed", "failed"'),
				summary: tool.schema.string().optional().describe("Verification details"),
			},
			async execute(args: { stage: string; summary?: string }, ctx: ToolContext): Promise<string> {
				const task = getCurrentTaskForWorker(db, ctx)
				if (!task) return "Error: no active worker-owned task for this session."
				const type = args.stage === "started"
					? "verification_started"
					: args.stage === "passed"
						? "verification_passed"
						: args.stage === "failed"
							? "verification_failed"
							: null
				if (!type) return 'Error: stage must be "started", "passed", or "failed".'
				recordTaskEvent(db, { taskId: task.id, sessionId: ctx.sessionID, type: type as TaskEventType, message: args.summary || null })
				return `Verification event (${args.stage}) recorded for task **${task.id}**.`
			},
		}),

		task_deliver: tool({
			description: "Submit structured delivery for the current task. Notifies the parent orchestrator first and mirrors to the project manager thread if configured.",
			args: {
				result: tool.schema.string().describe("Final result / delivery summary"),
				verification_summary: tool.schema.string().optional().describe("Verification outcome summary"),
				summary: tool.schema.string().optional().describe("Short notification summary"),
			},
			async execute(args: { result: string; verification_summary?: string; summary?: string }, ctx: ToolContext): Promise<string> {
				const task = getCurrentTaskForWorker(db, ctx)
				if (!task) return "Error: no active worker-owned task for this session."
				const delivered = deliverTask(db, {
					taskId: task.id,
					sessionId: ctx.sessionID,
					result: args.result,
					verificationSummary: args.verification_summary,
					message: args.summary,
				})
				await notifyTaskLifecycle(client, db, mgr, delivered, "delivered", args.summary || "Task delivered for review", [
					"<task_delivered>",
					`Task: ${delivered.id}`,
					`Title: ${delivered.title}`,
					`Status: ${delivered.status}`,
					`Worker session: ${delivered.owner_session_id || "—"}`,
					args.verification_summary ? `Verification: ${args.verification_summary}` : null,
					"",
					args.result,
					"</task_delivered>",
				].filter(Boolean) as string[])
				return `Task **${delivered.id}** delivered for review.`
			},
		}),

		// ── agent_task_list ──────────────────────────────────────
		agent_task_list: tool({
			description: "List all tasks in the current project.",
			args: {
				status: tool.schema.string().optional().describe("Filter by status"),
			},
			async execute(args: { status?: string }, ctx: ToolContext): Promise<string> {
				return taskListExecute(args, ctx)
			},
		}),

		task_list: tool({
			description: "Canonical task list tool. Lists tasks in the current project.",
			args: {
				status: tool.schema.string().optional().describe("Filter by status"),
			},
			async execute(args: { status?: string }, ctx: ToolContext): Promise<string> {
				return taskListExecute(args, ctx)
			},
		}),

		// ── agent_task_get ───────────────────────────────────────
		agent_task_get: tool({
			description: "Get full details of a task including result.",
			args: {
				id: tool.schema.string().describe("Task ID"),
			},
			async execute(args: { id: string }, ctx: ToolContext): Promise<string> {
				return taskGetExecute(args, ctx)
			},
		}),

		task_get: tool({
			description: "Canonical task detail tool. Gets full details for a task including result.",
			args: {
				id: tool.schema.string().describe("Task ID"),
			},
			async execute(args: { id: string }, ctx: ToolContext): Promise<string> {
				return taskGetExecute(args, ctx)
			},
		}),

		task_status: tool({
			description: "Get the live status of a task, including whether its worker session is actually still running.",
			args: {
				id: tool.schema.string().describe("Task ID"),
			},
			async execute(args: { id: string }, ctx: ToolContext): Promise<string> {
				return taskStatusExecute(args, ctx)
			},
		}),
	}
}

// ── Session event handler ────────────────────────────────────────────────────

export async function handleAgentTaskSessionEvent(
	sessionId: string,
	eventType: string,
	client: any,
	db: Database,
	mgr: ProjectManager,
): Promise<void> {
	if (!activeTaskSessions.has(sessionId)) return

	const task = getTaskByOwnerSession(db, sessionId)
	if (!task) return

	if (eventType === "session.idle") {
		if (autoworkActiveSessions.has(sessionId)) return

		if (task.status === "awaiting_review" || task.status === "input_needed") {
			activeTaskSessions.delete(sessionId)
			return
		}

		if (task.status !== "in_progress") {
			activeTaskSessions.delete(sessionId)
			return
		}

		let result = "(no output)"
		try {
			const msgs = await client.session.messages({ path: { id: sessionId } })
			result = (msgs.data ?? [])
				.filter((m: any) => m.info?.role === "assistant")
				.flatMap((m: any) => m.parts ?? [])
				.filter((p: any) => p.type === "text")
				.pop()?.text || result
		} catch {}

		const now = nowIso()
		recordTaskEvent(db, {
			taskId: task.id,
			sessionId,
			type: "verification_failed",
			message: "Worker session went idle without structured task_deliver; treating run as failed.",
		})
		db.prepare("UPDATE tasks SET status='cancelled', result=$r, completed_at=COALESCE(completed_at, $now), updated_at=$now WHERE id=$id")
			.run({ $r: `Worker session ended without task_deliver. Last output:\n\n${result.slice(0, 8000)}`, $now: now, $id: task.id })

		await notifyTaskLifecycle(client, db, mgr, {
			...task,
			status: "cancelled",
			result: `Worker session ended without task_deliver. Last output:\n\n${result.slice(0, 8000)}`,
			completed_at: now,
			updated_at: now,
		}, "verification_failed", "Worker ended without structured delivery", [
			"<task_run_failed>",
			`Task: ${task.id}`,
			`Title: ${task.title}`,
			`Reason: Worker session went idle without task_deliver`,
			`Session: ${task.owner_session_id || sessionId}`,
			"",
			result.slice(0, 8000),
			"</task_run_failed>",
		])

		activeTaskSessions.delete(sessionId)
		return
	}

	if (eventType === "session.error" || eventType === "session.aborted") {
		if (task.status !== "in_progress") {
			activeTaskSessions.delete(sessionId)
			return
		}

		let errorMsg = `Worker ${eventType === "session.aborted" ? "aborted" : "errored"}`
		try {
			const msgs = await client.session.messages({ path: { id: sessionId } })
			errorMsg = (msgs.data ?? [])
				.filter((m: any) => m.info?.role === "assistant")
				.flatMap((m: any) => m.parts ?? [])
				.filter((p: any) => p.type === "text")
				.pop()?.text || errorMsg
		} catch {}

		const now = nowIso()
		recordTaskEvent(db, { taskId: task.id, sessionId, type: "verification_failed", message: errorMsg.slice(0, 2000) })
		db.prepare("UPDATE tasks SET status='cancelled', result=$r, completed_at=COALESCE(completed_at, $now), updated_at=$now WHERE id=$id")
			.run({ $r: errorMsg.slice(0, 8000), $now: now, $id: task.id })

		await notifyTaskLifecycle(client, db, mgr, {
			...task,
			status: "cancelled",
			result: errorMsg.slice(0, 8000),
			completed_at: now,
			updated_at: now,
		}, "verification_failed", errorMsg.slice(0, 2000), [
			"<task_run_failed>",
			`Task: ${task.id}`,
			`Title: ${task.title}`,
			`Error: ${errorMsg.slice(0, 2000)}`,
			"</task_run_failed>",
		])

		activeTaskSessions.delete(sessionId)
	}
}
