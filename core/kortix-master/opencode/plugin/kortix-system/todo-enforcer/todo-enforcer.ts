/**
 * Kortix Todo Enforcer — native todo continuation.
 *
 * When a session goes idle with pending/in-progress native OpenCode todos,
 * it re-prompts the same session to keep working until that tracked work is
 * completed or genuinely blocked.
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { Todo } from "@opencode-ai/sdk"
import { autoworkActiveSessions } from "../autowork/autowork"
import { wrapInKortixSystemTags } from "../lib/message-transform"
import { clearStartupAbortedSession, hasStartupAbortedSession } from "../lib/startup-aborted-sessions"
import { DEFAULT_CONFIG, TODO_ENFORCER_INTERNAL_MARKER, createInitialContinuationState, type ContinuationState } from "./config"
import { evaluate } from "./engine"

function wrapSystemPrompt(text: string): string {
	return wrapInKortixSystemTags(text, { type: "passive-continuation", source: "kortix-native-todo-enforcing" })
}

function extractMessageText(input: any): string {
	const parts = input?.parts ?? []
	let text = ""
	for (const part of parts) {
		if (typeof part === "string") text += part
		else if (part?.type === "text") text += part.text ?? ""
		else if (typeof part?.text === "string") text += part.text
	}
	return text
}

function isInternalMessage(text: string): boolean {
	if (text.includes(TODO_ENFORCER_INTERNAL_MARKER)) return true
	if (text.includes("[SYSTEM REMINDER")) return true
	if (text.includes("<kortix_system")) return true
	return false
}

function extractLastAssistantMessage(messages: any[]): { text: string; hadToolCalls: boolean } {
	let text = ""
	let hadToolCalls = false
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.info?.role !== "assistant") continue
		for (const part of message.parts ?? []) {
			if (part.type === "text" && !part.synthetic && !part.ignored) text += `${part.text ?? ""}\n`
			if (part.type === "tool") hadToolCalls = true
		}
		break
	}
	return { text: text.trim(), hadToolCalls }
}

function hasPendingQuestion(messages: any[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		const role = message?.info?.role
		if (role === "user") return false
		if (role !== "assistant") continue
		for (const part of message.parts ?? []) {
			if (part.type !== "tool") continue
			const toolName = (part.toolName ?? part.tool_name ?? part.name ?? "") as string
			const status = part.state?.status ?? ""
			if ((toolName === "question" || toolName === "mcp_question") && (status === "running" || status === "pending")) {
				return true
			}
		}
	}
	return false
}

class SessionStateMap<T> {
	private map = new Map<string, { state: T; lastAccessedAt: number }>()
	private lastGcAt = Date.now()
	private readonly gcIntervalMs = 10 * 60 * 1000
	private readonly ttlMs = 2 * 60 * 60 * 1000

	constructor(private readonly factory: (sessionId: string) => T) {}

	get(sessionId: string): T {
		this.maybeGc()
		const existing = this.map.get(sessionId)
		if (existing) {
			existing.lastAccessedAt = Date.now()
			return existing.state
		}
		const state = this.factory(sessionId)
		this.map.set(sessionId, { state, lastAccessedAt: Date.now() })
		return state
	}

	delete(sessionId: string): void {
		this.map.delete(sessionId)
	}

	private maybeGc(): void {
		const now = Date.now()
		if (now - this.lastGcAt < this.gcIntervalMs) return
		this.lastGcAt = now
		const cutoff = now - this.ttlMs
		for (const [key, entry] of this.map) {
			if (entry.lastAccessedAt < cutoff) this.map.delete(key)
		}
	}
}

const TodoEnforcerPlugin: Plugin = async ({ client }) => {
	const states = new SessionStateMap<ContinuationState>((sessionId) => {
		const state = createInitialContinuationState()
		state.sessionId = sessionId
		return state
	})
	const disabledSessions = new Set<string>()

	const log = (level: "info" | "warn" | "error", message: string) => {
		try {
			client.app.log({ body: { service: "kortix-todo-enforcing", level, message } }).catch(() => {})
		} catch {
			// ignore logging failures
		}
	}

	const sid = (sessionId: string) => (sessionId.length > 16 ? sessionId.slice(-12) : sessionId)

	return {
		"chat.message": async (input: any, output: any) => {
			try {
				const sessionId = input?.sessionID as string | undefined
				if (!sessionId) return

				const messageText = extractMessageText(output)
				if (!messageText || isInternalMessage(messageText)) return

				const state = states.get(sessionId)
				state.workCycleStartedAt = Date.now()
				state.consecutiveAborts = 0
				state.inflight = false

				if (messageText.includes("KORTIX_AUTOWORK")) autoworkActiveSessions.add(sessionId)
				if (messageText.includes("KORTIX_AUTOWORK_CANCEL")) {
					autoworkActiveSessions.delete(sessionId)
					disabledSessions.add(sessionId)
				}
			} catch {
				// ignore hook failures
			}
		},

		event: async ({ event }) => {
			try {
				if (event.type === "session.deleted") {
					const sessionId = (event as any).properties?.info?.id ?? (event as any).properties?.sessionID
					if (sessionId) {
						states.delete(sessionId)
						autoworkActiveSessions.delete(sessionId)
						disabledSessions.delete(sessionId)
						clearStartupAbortedSession(sessionId)
					}
					return
				}

				if (event.type === "session.error" || event.type === "session.aborted") {
					const sessionId = (event as any).properties?.sessionID
					if (!sessionId) return
					const state = states.get(sessionId)
					state.lastAbortAt = Date.now()
					state.consecutiveAborts += 1
					state.inflight = false
					disabledSessions.add(sessionId)
					return
				}

				if (event.type !== "session.idle") return

				const sessionId = (event as any).properties?.sessionID
				if (!sessionId || autoworkActiveSessions.has(sessionId) || disabledSessions.has(sessionId)) return
				if (hasStartupAbortedSession(sessionId)) {
					disabledSessions.add(sessionId)
					log("info", `[todo-enforcing][${sid(sessionId)}] skipped: session aborted during startup cleanup`)
					return
				}

				const state = states.get(sessionId)
				const [todoRes, messagesRes] = await Promise.all([
					client.session.todo({ path: { id: sessionId } }).catch(() => ({ data: [] as Todo[] })),
					client.session.messages({ path: { id: sessionId } }).catch(() => ({ data: [] as any[] })),
				])

				const todos = (todoRes.data ?? []) as Todo[]
				const messages = (messagesRes.data ?? []) as any[]

				if (hasPendingQuestion(messages)) {
					log("info", `[todo-enforcing][${sid(sessionId)}] skipped: pending question`)
					return
				}

				const { text, hadToolCalls } = extractLastAssistantMessage(messages)
				state.consecutiveAborts = !text.trim() && !hadToolCalls ? state.consecutiveAborts + 1 : 0

				const decision = evaluate(DEFAULT_CONFIG, state, text, hadToolCalls, todos)
				log("info", `[todo-enforcing][${sid(sessionId)}] ${decision.action} — ${decision.reason}`)

				if (decision.action !== "continue" || !decision.prompt) return

				state.inflight = true
				state.totalSessionContinuations += 1
				state.lastContinuationAt = Date.now()
				await client.session.promptAsync({
					path: { id: sessionId },
					body: { parts: [{ type: "text" as const, text: wrapSystemPrompt(decision.prompt) }] },
				}).catch((error: unknown) => {
					log("warn", `[todo-enforcing][${sid(sessionId)}] promptAsync failed: ${error}`)
				}).finally(() => {
					state.inflight = false
				})
			} catch (error) {
				log("warn", `[todo-enforcing] event hook error: ${error}`)
			}
		},
	}
}

export default TodoEnforcerPlugin
