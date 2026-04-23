/**
 * Autowork plugin — single-owner persistent execution loop enforcer.
 *
 * `/autowork [--max-iterations N] <task>` activates the loop on a session.
 * Every `session.idle` the plugin first enforces a planning phase, then an
 * execution phase. The session must produce an approved
 * `<kortix_autowork_plan>` before execution begins. Later, completion is only
 * accepted when the latest `<kortix_autowork_complete>` is backed by real,
 * transcript-visible verification after the last code change.
 *
 * The continuation prompt re-anchors the original user request via
 * `<kortix_autowork_request>` so the worker cannot drift across long loops.
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { Todo } from "@opencode-ai/sdk"
import { clearStartupAbortedSession, hasStartupAbortedSession } from "../lib/startup-aborted-sessions"
import {
	AUTOWORK_THRESHOLDS,
	COMPLETION_TAG,
	PLAN_TAG,
	SYSTEM_WRAPPER_TAG,
	VERIFIED_TAG,
	createInitialAutoworkState,
	parseAutoworkArgs,
} from "./config"
import {
	approveAutoworkPlan,
	advanceAutowork,
	appendTaskContext,
	loadAllAutoworkStates,
	loadAutoworkState,
	noteAutoworkAssistantMessage,
	persistAutoworkState,
	recordAutoworkAbort,
	recordAutoworkFailure,
	removeAutoworkState,
	startAutoworkVerification,
	startAutowork,
	stopAutowork,
} from "./state"
import { checkAutoworkSafetyGates, evaluateAutowork } from "./engine"
import { collectAutoworkTranscriptSignals } from "./transcript"

export const autoworkActiveSessions = new Set<string>()

const PENDING_COMMAND_TTL_MS = 15_000

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

/**
 * Detect plugin-injected messages so they never re-trigger the loop.
 * The wrapper tag `<kortix_autowork_system>` surrounds every injected prompt,
 * and `<kortix_autowork_complete>` is the worker's completion signal — both
 * are internal and should not be interpreted as user input.
 */
function isInternalMessage(text: string): boolean {
	return text.includes(`<${SYSTEM_WRAPPER_TAG}`) || text.includes(`<${COMPLETION_TAG}`) || text.includes(`<${PLAN_TAG}`) || text.includes(`<${VERIFIED_TAG}`)
}

function isSoftCooldownGate(gateResult: string): boolean {
	return gateResult.startsWith("backoff cooldown") || gateResult.startsWith("minimum cooldown")
}

function startsWithSlashCommand(text: string, command: "autowork" | "autowork-cancel"): boolean {
	return new RegExp(`^/${command}\\b`, "i").test(text.trim())
}

function hasPendingQuestion(messages: any[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		const role = message?.info?.role
		if (role === "user") return false
		if (role !== "assistant") continue
		for (const part of message.parts ?? []) {
			if (part.type !== "tool") continue
			const toolName = (part.tool ?? part.toolName ?? part.tool_name ?? part.name ?? "") as string
			const status = part.state?.status ?? ""
			if ((toolName === "question" || toolName === "mcp_question") && (status === "running" || status === "pending")) return true
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

	set(sessionId: string, state: T): void {
		this.map.set(sessionId, { state, lastAccessedAt: Date.now() })
	}

	has(sessionId: string): boolean {
		return this.map.has(sessionId)
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

const AutoworkPlugin: Plugin = async ({ client }) => {
	const states = new SessionStateMap((_sid) => createInitialAutoworkState())
	const pendingCommand = new Map<string, { command: string; args: string; createdAt: number }>()

	try {
		const persisted = loadAllAutoworkStates()
		for (const [sid, state] of persisted) {
			if (hasStartupAbortedSession(sid)) {
				removeAutoworkState(sid)
				continue
			}
			if (state.active && !state.stopped) {
				states.set(sid, state)
				autoworkActiveSessions.add(sid)
			}
		}
	} catch {
		// ignore recovery failures
	}

	const log = (level: "info" | "warn" | "error", message: string) => {
		try {
			client.app.log({ body: { service: "kortix-autowork", level, message } }).catch(() => {})
		} catch {
			// ignore
		}
	}

	const sid = (sessionId: string) => sessionId.length > 16 ? sessionId.slice(-12) : sessionId

	return {
		"command.execute.before": async (input: any) => {
			const command = input?.command as string | undefined
			const sessionId = input?.sessionID as string | undefined
			const args = (input?.arguments as string | undefined) || ""
			if (!command || !sessionId) return
			if (["autowork", "autowork-cancel"].includes(command)) {
				pendingCommand.set(sessionId, { command, args, createdAt: Date.now() })
				log("info", `[autowork][${sid(sessionId)}] command.execute.before: ${command} "${args.slice(0, 80)}"`)
			}
		},

		"chat.message": async (input: any, output: any) => {
			try {
				const sessionId = input?.sessionID as string | undefined
				if (!sessionId) return

				const messageText = extractMessageText(output)
				if (!messageText || isInternalMessage(messageText)) return

				let state = states.get(sessionId)
				const clean = messageText.trim()
				const pending = pendingCommand.get(sessionId)
				const livePending = pending && Date.now() - pending.createdAt <= PENDING_COMMAND_TTL_MS ? pending : null
				if (pending && !livePending) pendingCommand.delete(sessionId)

				const cancelMatch = livePending?.command === "autowork-cancel"
					|| startsWithSlashCommand(clean, "autowork-cancel")

				if (cancelMatch) {
					pendingCommand.delete(sessionId)
					removeAutoworkState(sessionId)
					autoworkActiveSessions.delete(sessionId)
					if (state.active) {
						state = stopAutowork(state, "cancelled")
						states.set(sessionId, state)
						log("info", `[autowork][${sid(sessionId)}] Cancelled`)
					} else {
						log("info", `[autowork][${sid(sessionId)}] Cleared persisted state on cancel`)
					}
					return
				}

				const explicitSlashAutowork = startsWithSlashCommand(clean, "autowork")
				const autoworkMatch = livePending?.command === "autowork"
					|| explicitSlashAutowork

				if (autoworkMatch) {
					const pendingArgs = livePending?.args?.trim()
					const rawArgs = pendingArgs
						|| (explicitSlashAutowork ? clean.replace(/^\/autowork\s*/i, "").trim() : "")
					const { task, options } = parseAutoworkArgs(rawArgs)
					pendingCommand.delete(sessionId)

					if (!pendingArgs && !explicitSlashAutowork) {
						log("warn", `[autowork][${sid(sessionId)}] Ignored autowork activation without explicit slash command or args`)
						return
					}

					if (state.active) {
						state = appendTaskContext(state, `[User added context at iteration ${state.iteration}]: ${task}`)
						states.set(sessionId, state)
						log("info", `[autowork][${sid(sessionId)}] Context appended mid-loop`)
					} else {
						let msgCount = 0
						try {
							const result = await client.session.messages({ path: { id: sessionId } }).catch(() => ({ data: [] as any[] }))
							msgCount = (result.data ?? []).length
						} catch {
							// ignore
						}
						state = startAutowork(task, sessionId, Math.max(0, msgCount - 1), options.maxIterations)
						states.set(sessionId, state)
						autoworkActiveSessions.add(sessionId)
						log("info", `[autowork][${sid(sessionId)}] Activated: "${task.slice(0, 80)}"`)
					}
					return
				}

				if (state.active) {
					state = appendTaskContext(state, `[User message at iteration ${state.iteration}]: ${messageText.slice(0, 2000)}`)
					states.set(sessionId, state)
					log("info", `[autowork][${sid(sessionId)}] User message absorbed`)
				}
			} catch (error) {
				log("warn", `[autowork] chat.message error: ${error}`)
			}
		},

		event: async ({ event }) => {
			try {
				if (event.type === "session.deleted") {
					const sessionId = (event as any).properties?.info?.id ?? (event as any).properties?.sessionID
					if (sessionId) {
						states.delete(sessionId)
						autoworkActiveSessions.delete(sessionId)
						removeAutoworkState(sessionId)
						clearStartupAbortedSession(sessionId)
					}
					return
				}

				if ((event.type as string) === "session.aborted") {
					const sessionId = (event as any).properties?.sessionID as string | undefined
					if (!sessionId) return
					const state = states.get(sessionId)
					if (state.active) {
						states.set(sessionId, stopAutowork(state, "cancelled"))
					}
					autoworkActiveSessions.delete(sessionId)
					removeAutoworkState(sessionId)
					log("info", `[autowork][${sid(sessionId)}] Cancelled after session abort`)
					return
				}

				if (event.type === "session.error") {
					const sessionId = (event as any).properties?.sessionID as string | undefined
					if (!sessionId || !states.has(sessionId)) return
					const state = states.get(sessionId)
					if (!state.active) return
					if (hasStartupAbortedSession(sessionId)) {
						states.set(sessionId, stopAutowork(state, "cancelled"))
						autoworkActiveSessions.delete(sessionId)
						removeAutoworkState(sessionId)
						log("info", `[autowork][${sid(sessionId)}] Disabled after startup cleanup abort`)
						return
					}
					states.set(sessionId, recordAutoworkAbort(state))
					log("info", `[autowork][${sid(sessionId)}] Abort recorded`)
					return
				}

				if (event.type !== "session.idle") return
				const sessionId = (event as any).properties?.sessionID as string | undefined
				if (!sessionId) return
				if (hasStartupAbortedSession(sessionId)) {
					const existing = states.get(sessionId)
					if (existing.active) states.set(sessionId, stopAutowork(existing, "cancelled"))
					autoworkActiveSessions.delete(sessionId)
					removeAutoworkState(sessionId)
					log("info", `[autowork][${sid(sessionId)}] Skipped: session aborted during startup cleanup`)
					return
				}

				let state = states.get(sessionId)
				if (!state.active) {
					const persisted = loadAutoworkState(sessionId)
					if (persisted?.active && !persisted.stopped) {
						state = persisted
						states.set(sessionId, state)
						autoworkActiveSessions.add(sessionId)
						log("info", `[autowork][${sid(sessionId)}] Recovered persisted state`)
					}
				}
				if (!state.active) return

				const [messagesRes, todoRes] = await Promise.all([
					client.session.messages({ path: { id: sessionId } }).catch(() => ({ data: [] as any[] })),
					typeof client.session.todo === "function"
						? client.session.todo({ path: { id: sessionId } }).catch(() => ({ data: [] as Todo[] }))
						: Promise.resolve({ data: [] as Todo[] }),
				])
				const messages = (messagesRes.data ?? []) as any[]
				const todos = (todoRes.data ?? []) as Todo[]

				if (hasPendingQuestion(messages)) {
					log("info", `[autowork][${sid(sessionId)}] Skipped: pending question`)
					return
				}

				const signals = collectAutoworkTranscriptSignals(
					messages,
					todos,
					state,
					(text) => text.includes(`<${SYSTEM_WRAPPER_TAG}`),
				)
				const latestAssistantMessageIndex = signals.latestAssistantMessage?.messageIndex ?? -1
				const hasFreshAssistantMessage = latestAssistantMessageIndex > state.lastObservedAssistantMessageIndex

				const gateResult = checkAutoworkSafetyGates(
					state,
					AUTOWORK_THRESHOLDS.abortGracePeriodMs,
					AUTOWORK_THRESHOLDS.maxConsecutiveFailures,
					AUTOWORK_THRESHOLDS.failureResetWindowMs,
					AUTOWORK_THRESHOLDS.baseCooldownMs,
				)

				if (gateResult === "__reset_failures__") {
					state = { ...state, consecutiveFailures: 0 }
					persistAutoworkState(state)
					states.set(sessionId, state)
				} else if (gateResult && !(hasFreshAssistantMessage && isSoftCooldownGate(gateResult))) {
					log("info", `[autowork][${sid(sessionId)}] Gate: ${gateResult}`)
					return
				}

				if (hasFreshAssistantMessage) {
					state = noteAutoworkAssistantMessage(state, latestAssistantMessageIndex)
					states.set(sessionId, state)
				}
				const decision = evaluateAutowork(state, signals)
				log("info", `[autowork][${sid(sessionId)}] ${decision.action} — ${decision.reason}`)

				if (decision.action === "stop") {
					state = stopAutowork(state, decision.stopReason ?? "complete")
					states.set(sessionId, state)
					autoworkActiveSessions.delete(sessionId)
					return
				}

				if (decision.prompt) {
					if (decision.nextPhase === "execution" && decision.approvedPlan) {
						state = approveAutoworkPlan(state, decision.approvedPlan)
						states.set(sessionId, state)
					} else if (decision.nextPhase === "verifying" && decision.approvedCompletion) {
						state = startAutoworkVerification(state, decision.approvedCompletion)
						states.set(sessionId, state)
					}
					state = advanceAutowork(state)
					states.set(sessionId, state)
					await client.session.promptAsync({
						path: { id: sessionId },
						body: { parts: [{ type: "text", text: decision.prompt }] },
					}).catch((error: unknown) => {
						log("warn", `[autowork][${sid(sessionId)}] promptAsync failed: ${error}`)
						state = recordAutoworkFailure(state)
						states.set(sessionId, state)
					})
				}
			} catch (error) {
				log("warn", `[autowork] event error: ${error}`)
			}
		},
	}
}

export default AutoworkPlugin
