/**
 * Goal plugin — Codex-style persistent autonomous loop.
 *
 * `/goal <objective>` starts/replaces the active session goal. The runtime
 * keeps prompting while the goal is active and idle. The model may only request
 * completion through update_goal({ status: "complete" }); the runtime validates
 * that request against transcript evidence before marking the goal complete.
 *
 */

import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import { clearStartupAbortedSession, hasStartupAbortedSession } from "../lib/startup-aborted-sessions"
import { GOAL_SYSTEM_WRAPPER_TAG, GOAL_THRESHOLDS, createInitialGoalState, isGoalActive, parseGoalArgs, remainingTokens, type GoalOptions, type GoalState } from "./config"
import { checkGoalSafetyGates, evaluateGoal } from "./engine"
import {
	advanceGoal,
	appendGoalContext,
	loadAllGoalStates,
	loadGoalState,
	markBudgetLimitPrompted,
	noteGoalAssistantMessage,
	persistGoalState,
	recordGoalAbort,
	recordGoalFailure,
	removeGoalState,
	setGoalStatus,
	startGoal,
	updateGoalUsage,
} from "./state"
import { collectGoalTranscriptSignals } from "./transcript"

export const goalActiveSessions = new Set<string>()

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

function isInternalMessage(text: string): boolean {
	return text.includes(`<${GOAL_SYSTEM_WRAPPER_TAG}`)
}

function isSoftCooldownGate(gateResult: string): boolean {
	return gateResult.startsWith("backoff cooldown") || gateResult.startsWith("minimum cooldown")
}

function startsWithSlashCommand(text: string, command: string): boolean {
	return new RegExp(`^/${command}\\b`, "i").test(text.trim())
}

function stripSlashCommand(text: string, command: string): string {
	return text.trim().replace(new RegExp(`^/${command}\\s*`, "i"), "").trim()
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

function renderGoal(state: GoalState | null): string {
	if (!state?.goalId) return "No goal is currently set for this session. Use `/goal <objective>` to start one."
	return [
		"## Active Goal",
		`- Status: ${state.status}`,
		`- Goal ID: ${state.goalId}`,
		`- Iteration: ${state.iteration}/${state.maxIterations}`,
		`- Tokens: ${state.tokensUsed}${state.tokenBudget === null ? "" : ` / ${state.tokenBudget}`}`,
		`- Tokens remaining: ${remainingTokens(state) ?? "unbounded"}`,
		`- Time: ${state.timeUsedSeconds}s`,
		"",
		"Objective:",
		state.objective || "(none)",
	].join("\n")
}

async function messageCount(client: any, sessionId: string): Promise<number> {
	try {
		const result = await client.session.messages({ path: { id: sessionId } }).catch(() => ({ data: [] as any[] }))
		return (result.data ?? []).length
	} catch {
		return 0
	}
}

async function loadMessages(client: any, sessionId: string): Promise<any[]> {
	const messagesRes = await client.session.messages({ path: { id: sessionId } }).catch(() => ({ data: [] as any[] }))
	return (messagesRes.data ?? []) as any[]
}

function commandKind(command: string): "goal" | "cancel" | null {
	if (command === "goal") return "goal"
	if (command === "goal-cancel") return "cancel"
	return null
}

const GoalPlugin: Plugin = async ({ client }) => {
	const states = new SessionStateMap<GoalState>((sessionId) => ({ ...createInitialGoalState(), sessionId }))
	const pendingCommand = new Map<string, { command: string; args: string; createdAt: number }>()

	try {
		const persisted = loadAllGoalStates()
		for (const [sid, state] of persisted) {
			if (hasStartupAbortedSession(sid)) {
				removeGoalState(sid)
				continue
			}
			states.set(sid, state)
			if (isGoalActive(state)) goalActiveSessions.add(sid)
		}
	} catch {
		// ignore recovery failures
	}

	const log = (level: "info" | "warn" | "error", message: string) => {
		try {
			client.app.log({ body: { service: "kortix-goal", level, message } }).catch(() => {})
		} catch {
			// ignore
		}
	}

	const sid = (sessionId: string) => sessionId.length > 16 ? sessionId.slice(-12) : sessionId

	const setState = (sessionId: string, state: GoalState) => {
		states.set(sessionId, state)
		if (isGoalActive(state)) goalActiveSessions.add(sessionId)
		else goalActiveSessions.delete(sessionId)
	}

	const startOrReplace = async (sessionId: string, objective: string, options: Partial<GoalOptions>) => {
		const count = await messageCount(client, sessionId)
		const state = startGoal(objective, sessionId, Math.max(0, count - 1), options)
		setState(sessionId, state)
		log("info", `[goal][${sid(sessionId)}] Set active goal: "${objective.slice(0, 80)}"`)
		return state
	}

	return {
		tool: {
			get_goal: tool({
				description: "Get the current goal for this session, including status, budget, token usage, elapsed time, and remaining token budget.",
				args: {},
				async execute(_args: {}, toolCtx: ToolContext): Promise<string> {
					const sessionId = toolCtx?.sessionID
					if (!sessionId) return "Error: no session ID available."
					const state = loadGoalState(sessionId) ?? (states.has(sessionId) ? states.get(sessionId) : null)
					return renderGoal(state)
				},
			}),

			create_goal: tool({
				description: "Create a goal only when explicitly requested by the user or system/developer instructions. Fails if an active/paused/budget-limited goal already exists.",
				args: {
					objective: tool.schema.string().describe("Required. The concrete objective to start pursuing."),
					token_budget: tool.schema.number().optional().describe("Optional positive token budget for the new goal."),
					max_iterations: tool.schema.number().optional().describe("Optional positive maximum continuation count."),
				},
				async execute(args: { objective: string; token_budget?: number; max_iterations?: number }, toolCtx: ToolContext): Promise<string> {
					const sessionId = toolCtx?.sessionID
					if (!sessionId) return "Error: no session ID available."
					const existing = loadGoalState(sessionId)
					if (existing && existing.status !== "complete") {
						return "Error: this session already has a goal. Use update_goal only when it is complete, or use /goal clear from the user side."
					}
					const state = await startOrReplace(sessionId, args.objective, {
						tokenBudget: typeof args.token_budget === "number" && args.token_budget > 0 ? Math.floor(args.token_budget) : null,
						maxIterations: typeof args.max_iterations === "number" && args.max_iterations > 0 ? Math.floor(args.max_iterations) : undefined,
					})
					return renderGoal(state)
				},
			}),

			update_goal: tool({
				description: [
					"Update the existing goal. Use this tool only to mark the goal achieved.",
					"The only supported status is complete.",
					"Do not call it until the objective has actually been achieved and no required work remains.",
					"If files/state changed, rerun deterministic final verification after the last mutation before calling this tool.",
				].join(" "),
				args: {
					status: tool.schema.string().describe('Required. Must be exactly "complete".'),
				},
				async execute(args: { status: string }, toolCtx: ToolContext): Promise<string> {
					const sessionId = toolCtx?.sessionID
					if (!sessionId) return "Error: no session ID available."
					if (args.status !== "complete") return 'Error: update_goal only supports status "complete".'
					const state = loadGoalState(sessionId) ?? (states.has(sessionId) ? states.get(sessionId) : null)
					if (!state?.goalId) return "Error: no goal is set for this session."
					if (state.status !== "active") return `Error: goal is ${state.status}; only an active goal can be completed.`
					return "Completion requested. The runtime will audit transcript evidence on session idle; if the final verification gate fails, it will continue the goal instead of marking it complete."
				},
			}),
		},

		"command.execute.before": async (input: any) => {
			const command = input?.command as string | undefined
			const sessionId = input?.sessionID as string | undefined
			const args = (input?.arguments as string | undefined) || ""
			if (!command || !sessionId || !commandKind(command)) return
			pendingCommand.set(sessionId, { command, args, createdAt: Date.now() })
			log("info", `[goal][${sid(sessionId)}] command.execute.before: ${command} "${args.slice(0, 80)}"`)
		},

		"chat.message": async (input: any, output: any) => {
			try {
				const sessionId = input?.sessionID as string | undefined
				if (!sessionId) return

				const messageText = extractMessageText(output)
				if (!messageText || isInternalMessage(messageText)) return

				let state = states.has(sessionId) ? states.get(sessionId) : (loadGoalState(sessionId) ?? states.get(sessionId))
				const clean = messageText.trim()
				const pending = pendingCommand.get(sessionId)
				const livePending = pending && Date.now() - pending.createdAt <= PENDING_COMMAND_TTL_MS ? pending : null
				if (pending && !livePending) pendingCommand.delete(sessionId)

				const cancelMatch = livePending?.command && commandKind(livePending.command) === "cancel"
					|| startsWithSlashCommand(clean, "goal-cancel")
				if (cancelMatch) {
					pendingCommand.delete(sessionId)
					removeGoalState(sessionId)
					goalActiveSessions.delete(sessionId)
					states.delete(sessionId)
					log("info", `[goal][${sid(sessionId)}] Cleared on cancel`)
					return
				}

				const explicitGoal = startsWithSlashCommand(clean, "goal")
				const goalMatch = livePending?.command && commandKind(livePending.command) === "goal" || explicitGoal
				if (goalMatch) {
					const pendingArgs = livePending?.args?.trim()
					const rawArgs = pendingArgs || (explicitGoal ? stripSlashCommand(clean, "goal") : "")
					pendingCommand.delete(sessionId)

					if (!pendingArgs && !explicitGoal) {
						log("warn", `[goal][${sid(sessionId)}] Ignored activation without explicit slash command or args`)
						return
					}

					const normalized = rawArgs.trim().toLowerCase()
					if (!rawArgs.trim()) {
						await client.session.promptAsync({ path: { id: sessionId }, body: { parts: [{ type: "text" as const, text: renderGoal(loadGoalState(sessionId) ?? null) }] } }).catch(() => {})
						return
					}
					if (["pause", "paused"].includes(normalized)) {
						if (state.goalId) setState(sessionId, setGoalStatus(state, "paused", "cancelled"))
						return
					}
					if (["resume", "active"].includes(normalized)) {
						if (state.goalId) setState(sessionId, setGoalStatus(state, "active"))
						return
					}
					if (["clear", "delete", "cancel"].includes(normalized)) {
						removeGoalState(sessionId)
						goalActiveSessions.delete(sessionId)
						states.delete(sessionId)
						return
					}

					const { objective, options } = parseGoalArgs(rawArgs)
					await startOrReplace(sessionId, objective, options)
					log("info", `[goal][${sid(sessionId)}] goal activated`)
					return
				}

				if (isGoalActive(state)) {
					state = appendGoalContext(state, `[User message at iteration ${state.iteration}]: ${messageText.slice(0, 2000)}`)
					setState(sessionId, state)
					log("info", `[goal][${sid(sessionId)}] User message absorbed`)
				}
			} catch (error) {
				log("warn", `[goal] chat.message error: ${error}`)
			}
		},

		event: async ({ event }) => {
			try {
				if (event.type === "session.deleted") {
					const sessionId = (event as any).properties?.info?.id ?? (event as any).properties?.sessionID
					if (sessionId) {
						states.delete(sessionId)
						goalActiveSessions.delete(sessionId)
						removeGoalState(sessionId)
						clearStartupAbortedSession(sessionId)
					}
					return
				}

				if ((event.type as string) === "session.aborted" || event.type === "session.error") {
					const sessionId = (event as any).properties?.sessionID as string | undefined
					if (!sessionId) return
					let state = states.has(sessionId) ? states.get(sessionId) : loadGoalState(sessionId)
					if (!state?.goalId) return
					if (hasStartupAbortedSession(sessionId)) {
						states.delete(sessionId)
						goalActiveSessions.delete(sessionId)
						removeGoalState(sessionId)
						log("info", `[goal][${sid(sessionId)}] Removed after startup cleanup abort`)
						return
					}
					state = recordGoalAbort(state)
					state = setGoalStatus(state, "paused", "cancelled")
					setState(sessionId, state)
					log("info", `[goal][${sid(sessionId)}] Paused after ${event.type}`)
					return
				}

				if (event.type !== "session.idle") return
				const sessionId = (event as any).properties?.sessionID as string | undefined
				if (!sessionId) return
				if (hasStartupAbortedSession(sessionId)) {
					states.delete(sessionId)
					goalActiveSessions.delete(sessionId)
					removeGoalState(sessionId)
					log("info", `[goal][${sid(sessionId)}] Skipped: session aborted during startup cleanup`)
					return
				}

				let state = states.has(sessionId) ? states.get(sessionId) : (loadGoalState(sessionId) ?? null)
				if (!isGoalActive(state)) return
				states.set(sessionId, state)
				goalActiveSessions.add(sessionId)

				const messages = await loadMessages(client, sessionId)
				if (hasPendingQuestion(messages)) {
					log("info", `[goal][${sid(sessionId)}] Skipped: pending question`)
					return
				}

				let signals = collectGoalTranscriptSignals(messages, state, isInternalMessage)
				state = updateGoalUsage(state, signals.tokensUsed)
				states.set(sessionId, state)
				signals = collectGoalTranscriptSignals(messages, state, isInternalMessage)

				const latestAssistantMessageIndex = signals.latestAssistantMessage?.messageIndex ?? -1
				const hasFreshAssistantMessage = latestAssistantMessageIndex > state.lastObservedAssistantMessageIndex

				const gateResult = checkGoalSafetyGates(
					state,
					GOAL_THRESHOLDS.abortGracePeriodMs,
					GOAL_THRESHOLDS.maxConsecutiveFailures,
					GOAL_THRESHOLDS.failureResetWindowMs,
					GOAL_THRESHOLDS.baseCooldownMs,
				)

				if (gateResult === "__reset_failures__") {
					state = { ...state, consecutiveFailures: 0 }
					persistGoalState(state)
					states.set(sessionId, state)
				} else if (gateResult && !(hasFreshAssistantMessage && isSoftCooldownGate(gateResult))) {
					log("info", `[goal][${sid(sessionId)}] Gate: ${gateResult}`)
					return
				}

				if (hasFreshAssistantMessage) {
					state = noteGoalAssistantMessage(state, latestAssistantMessageIndex)
					states.set(sessionId, state)
				}

				const decision = evaluateGoal(state, signals)
				log("info", `[goal][${sid(sessionId)}] ${decision.action} — ${decision.reason}`)

				if (decision.action === "stop") {
					state = setGoalStatus(state, decision.stopReason === "complete" ? "complete" : "paused", decision.stopReason ?? "complete")
					setState(sessionId, state)
					return
				}

				if (decision.action === "budget_limit") {
					state = setGoalStatus(state, "budget_limited", "budget_limited")
					if (decision.prompt) {
						state = markBudgetLimitPrompted(state)
						setState(sessionId, state)
						await client.session.promptAsync({ path: { id: sessionId }, body: { parts: [{ type: "text" as const, text: decision.prompt }] } }).catch(() => {})
					} else {
						setState(sessionId, state)
					}
					return
				}

				if (decision.prompt) {
					state = advanceGoal(state)
					setState(sessionId, state)
					await client.session.promptAsync({
						path: { id: sessionId },
						body: { parts: [{ type: "text" as const, text: decision.prompt }] },
					}).catch((error: unknown) => {
						log("warn", `[goal][${sid(sessionId)}] promptAsync failed: ${error}`)
						state = recordGoalFailure(state)
						setState(sessionId, state)
					})
				}
			} catch (error) {
				log("warn", `[goal] event error: ${error}`)
			}
		},
	}
}

export default GoalPlugin
