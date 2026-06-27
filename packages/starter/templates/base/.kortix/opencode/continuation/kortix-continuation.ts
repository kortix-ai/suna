/**
 * Kortix Continuation — Todo Continuation Enforcer
 *
 * Always-on auto-continuation. When a root session goes idle with unfinished
 * tracked work (native opencode todos), the runtime re-prompts the agent to keep
 * going instead of letting it self-stop mid-task.
 *
 * Pipeline (no LLM calls), on `session.idle`:
 *   - skip subagents, pending questions, and empty/aborted turns
 *   - IntentGate   → stop on completion / blocked-on-user / answer-only
 *   - TodoEnforcer → continue while native todos remain unfinished
 *   - safety gates → per-request cap, cooldown, circuit breaker, in-flight guard
 *   - client.session.promptAsync(<continuation reminder>)
 *
 * This intentionally ships ONLY the passive enforcer — no /autowork loop, no
 * keyword activation, no algorithm variants. Set KORTIX_CONTINUATION_DISABLED=1
 * to turn it off.
 *
 * Hooks:
 *   event → session.idle (evaluate + inject), session.error/aborted (grace),
 *           session.deleted (cleanup)
 */

import { type Plugin } from "@opencode-ai/plugin"
import type { Todo } from "@opencode-ai/sdk"
import { type ContinuationState, createInitialState, DEFAULT_CONFIG, INTERNAL_MARKER } from "./config"
import { evaluate } from "./continuation-engine"

const DISABLED = process.env.KORTIX_CONTINUATION_DISABLED === "1" || process.env.KORTIX_CONTINUATION_DISABLED === "true"

// ─── Message helpers ───────────────────────────────────────────────────────────

/** Concatenate all text-part content of a message (used for internal-marker detection). */
function messageFullText(msg: any): string {
	let text = ""
	for (const part of msg?.parts ?? []) {
		if (part?.type === "text" && typeof part.text === "string") text += `${part.text}\n`
	}
	return text
}

/** True if a message was injected by the system (must never count as real user input). */
function isInternalMessage(text: string): boolean {
	if (text.includes(INTERNAL_MARKER)) return true
	if (text.includes("[SYSTEM REMINDER")) return true
	if (text.includes("<kortix_system")) return true
	return false
}

/** Last assistant message text + whether that turn made tool calls. */
function extractLastAssistantMessage(messages: any[]): { text: string; hadToolCalls: boolean } {
	let text = ""
	let hadToolCalls = false
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg?.info?.role === "assistant") {
			for (const part of msg.parts ?? []) {
				if (part?.type === "text" && !part.synthetic && !part.ignored) text += `${part.text}\n`
				if (part?.type === "tool") hadToolCalls = true
			}
			break
		}
	}
	return { text: text.trim(), hadToolCalls }
}

/** Most recent real (non-internal) user message — drives the per-request budget reset. */
function findLastRealUserMessage(messages: any[]): { id: string; createdAt: number } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg?.info?.role !== "user") continue
		if (isInternalMessage(messageFullText(msg))) continue
		return { id: String(msg?.info?.id ?? i), createdAt: Number(msg?.info?.time?.created ?? 0) || 0 }
	}
	return null
}

/**
 * Detect if the agent is waiting for a user answer to a `question` tool call.
 * Walks backwards — true if an assistant `question` tool call (running/pending)
 * is found before any subsequent user message.
 */
function hasPendingQuestion(messages: any[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		const role = msg?.info?.role
		if (role === "user") return false
		if (role !== "assistant") continue
		for (const part of msg.parts ?? []) {
			if (part?.type !== "tool") continue
			const toolName = (part.tool ?? part.toolName ?? part.tool_name ?? part.name ?? "") as string
			if (toolName === "question" || toolName === "mcp_question") {
				const status = part.state?.status ?? ""
				if (status === "running" || status === "pending") return true
			}
		}
	}
	return false
}

/** Wrap an injected prompt so the frontend renders it as a system block (not a user bubble). */
function wrapSystemPrompt(text: string, type: string): string {
	return `<kortix_system type="${type}" source="kortix-continuation">\n${text}\n</kortix_system>`
}

// ─── Plugin ────────────────────────────────────────────────────────────────────

const KortixContinuationPlugin: Plugin = async ({ client }) => {
	const config = DEFAULT_CONFIG
	const states = new Map<string, { state: ContinuationState; touched: number }>()
	const rootCache = new Map<string, boolean>()
	let lastGcAt = Date.now()
	const GC_INTERVAL_MS = 10 * 60_000
	const TTL_MS = 2 * 60 * 60_000

	const log = (level: "info" | "warn" | "error", message: string) => {
		try {
			client.app.log({ body: { service: "kortix-continuation", level, message } }).catch(() => {})
		} catch {
			// ignore logging failures
		}
	}

	const sid = (sessionId: string) => (sessionId.length > 16 ? sessionId.slice(-12) : sessionId)

	function getState(sessionId: string): ContinuationState {
		const now = Date.now()
		if (now - lastGcAt > GC_INTERVAL_MS) {
			lastGcAt = now
			for (const [key, entry] of states) {
				if (now - entry.touched > TTL_MS) {
					states.delete(key)
					rootCache.delete(key)
				}
			}
		}
		let entry = states.get(sessionId)
		if (!entry) {
			entry = { state: { ...createInitialState(), sessionId }, touched: now }
			states.set(sessionId, entry)
		}
		entry.touched = now
		return entry.state
	}

	/** Continuation applies to user-facing root sessions only — never subagents. */
	async function isRootSession(sessionId: string): Promise<boolean> {
		const cached = rootCache.get(sessionId)
		if (cached !== undefined) return cached
		try {
			const res = await client.session.get({ path: { id: sessionId } })
			const parentID = (res?.data as any)?.parentID
			const root = !parentID
			rootCache.set(sessionId, root)
			return root
		} catch {
			return true // fail open — treat unknown sessions as root
		}
	}

	return {
		event: async ({ event }: { event: any }) => {
			try {
				if (event.type === "session.deleted") {
					const id = event.properties?.info?.id ?? event.properties?.sessionID
					if (id) {
						states.delete(id)
						rootCache.delete(id)
					}
					return
				}

				if (event.type === "session.error" || event.type === "session.aborted") {
					const id = event.properties?.sessionID
					if (!id || !states.has(id)) return
					const state = getState(id)
					state.lastAbortAt = Date.now()
					state.consecutiveAborts++
					state.inflight = false
					return
				}

				if (event.type !== "session.idle") return
				if (DISABLED) return

				const sessionId = event.properties?.sessionID as string | undefined
				if (!sessionId) return
				if (!(await isRootSession(sessionId))) return

				const state = getState(sessionId)

				const [todoRes, messagesRes] = await Promise.all([
					client.session.todo({ path: { id: sessionId } }).catch(() => ({ data: [] as Todo[] })),
					client.session.messages({ path: { id: sessionId } }).catch(() => ({ data: [] as any[] })),
				])
				const todos = (todoRes.data ?? []) as Todo[]
				const messages = (messagesRes.data ?? []) as any[]

				// New real user message → fresh per-request budget.
				const lastUser = findLastRealUserMessage(messages)
				if (lastUser && lastUser.id !== state.lastUserMessageId) {
					state.lastUserMessageId = lastUser.id
					state.totalSessionContinuations = 0
					state.consecutiveAborts = 0
					state.lastContinuationAt = 0
					state.lastAbortAt = 0
					state.inflight = false
					state.workCycleStartedAt = lastUser.createdAt || Date.now()
				}

				if (hasPendingQuestion(messages)) {
					log("info", `[${sid(sessionId)}] skip: pending question`)
					return
				}

				const { text, hadToolCalls } = extractLastAssistantMessage(messages)
				if (!text.trim() && !hadToolCalls) state.consecutiveAborts++
				else state.consecutiveAborts = 0

				const decision = evaluate(config, state, text, hadToolCalls, todos)
				log("info", `[${sid(sessionId)}] ${decision.action} — ${decision.reason}`)

				if (decision.action === "continue" && decision.prompt) {
					state.inflight = true
					state.totalSessionContinuations++
					state.lastContinuationAt = Date.now()
					await client.session
						.promptAsync({
							path: { id: sessionId },
							body: { parts: [{ type: "text" as const, text: wrapSystemPrompt(decision.prompt, "passive-continuation") }] },
						})
						.catch((err: unknown) => {
							log("warn", `[${sid(sessionId)}] promptAsync failed: ${err}`)
						})
						.finally(() => {
							state.inflight = false
						})
				}
			} catch (err) {
				log("warn", `event hook error: ${err}`)
			}
		},
	}
}

export default KortixContinuationPlugin
