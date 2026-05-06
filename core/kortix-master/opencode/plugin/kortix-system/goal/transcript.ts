import type { GoalState } from "./config"

export interface GoalToolCallSignal {
	messageIndex: number
	tool: string
	input: unknown
	output: unknown
}

export interface GoalAssistantMessageSignal {
	messageIndex: number
	text: string
	completedToolCalls: GoalToolCallSignal[]
	completedWorkToolCalls: GoalToolCallSignal[]
}

export interface GoalTranscriptSignals {
	assistantMessages: GoalAssistantMessageSignal[]
	latestAssistantMessage: GoalAssistantMessageSignal | null
	completedToolCalls: GoalToolCallSignal[]
	completedWorkToolCalls: GoalToolCallSignal[]
	completedBashToolCalls: GoalToolCallSignal[]
	lastMutatingToolCall: GoalToolCallSignal | null
	latestGoalCompletionCall: GoalToolCallSignal | null
	hasAnyWorkSignal: boolean
	tokensUsed: number
}

const MUTATING_TOOL_NAMES = new Set(["edit", "write", "morph_edit", "apply_patch"])
const GOAL_TOOL_NAMES = new Set(["get_goal", "create_goal", "update_goal"])

function toolName(part: any): string {
	return ((part?.tool ?? part?.toolName ?? part?.tool_name ?? part?.name ?? "") as string).trim()
}

function isQuestionTool(name: string): boolean {
	return name === "question" || name === "mcp_question"
}

function messageTokenUsage(message: any): number {
	const tokens = message?.info?.tokens ?? {}
	const input = Number(tokens.input ?? 0)
	const output = Number(tokens.output ?? 0)
	const reasoning = Number(tokens.reasoning ?? 0)
	const cacheRead = Number(tokens.cache?.read ?? 0)
	return Math.max(0, input - cacheRead) + Math.max(0, output) + Math.max(0, reasoning)
}

export function goalToolStatus(input: unknown): string | null {
	if (typeof input === "string") {
		try {
			const parsed = JSON.parse(input) as { status?: unknown }
			return typeof parsed.status === "string" ? parsed.status : null
		} catch {
			return null
		}
	}
	if (input && typeof input === "object" && typeof (input as { status?: unknown }).status === "string") {
		return (input as { status: string }).status
	}
	return null
}

export function collectGoalTranscriptSignals(
	messages: any[],
	state: GoalState,
	isInternalMessage: (text: string) => boolean,
): GoalTranscriptSignals {
	const assistantMessages: GoalAssistantMessageSignal[] = []
	const completedToolCalls: GoalToolCallSignal[] = []
	const completedWorkToolCalls: GoalToolCallSignal[] = []
	const completedBashToolCalls: GoalToolCallSignal[] = []
	let lastMutatingToolCall: GoalToolCallSignal | null = null
	let latestGoalCompletionCall: GoalToolCallSignal | null = null
	let tokensUsed = 0
	const startIndex = Math.max(0, state.messageCountAtStart)

	for (let i = startIndex; i < messages.length; i++) {
		const message = messages[i]
		tokensUsed += messageTokenUsage(message)
		if (message?.info?.role !== "assistant") continue

		let text = ""
		const messageToolCalls: GoalToolCallSignal[] = []
		const messageWorkToolCalls: GoalToolCallSignal[] = []

		for (const part of message.parts ?? []) {
			if (part?.type === "text" && !part.synthetic && !part.ignored) {
				text += `${part.text ?? ""}\n`
				continue
			}

			if (part?.type !== "tool") continue
			const name = toolName(part)
			const status = part?.state?.status ?? ""
			if (status !== "completed") continue

			const toolCall: GoalToolCallSignal = {
				messageIndex: i,
				tool: name || "unknown",
				input: part?.state?.input,
				output: part?.state?.output,
			}
			completedToolCalls.push(toolCall)
			messageToolCalls.push(toolCall)
			if (name === "bash") completedBashToolCalls.push(toolCall)
			if (MUTATING_TOOL_NAMES.has(name)) lastMutatingToolCall = toolCall
			if (name === "update_goal" && goalToolStatus(toolCall.input) === "complete") latestGoalCompletionCall = toolCall
			if (isQuestionTool(name) || GOAL_TOOL_NAMES.has(name)) continue

			completedWorkToolCalls.push(toolCall)
			messageWorkToolCalls.push(toolCall)
		}

		const trimmedText = text.trim()
		if (trimmedText && isInternalMessage(trimmedText)) continue
		if (!trimmedText && messageToolCalls.length === 0) continue

		assistantMessages.push({
			messageIndex: i,
			text: trimmedText,
			completedToolCalls: messageToolCalls,
			completedWorkToolCalls: messageWorkToolCalls,
		})
	}

	return {
		assistantMessages,
		latestAssistantMessage: assistantMessages.at(-1) ?? null,
		completedToolCalls,
		completedWorkToolCalls,
		completedBashToolCalls,
		lastMutatingToolCall,
		latestGoalCompletionCall,
		hasAnyWorkSignal: completedWorkToolCalls.length > 0,
		tokensUsed,
	}
}
