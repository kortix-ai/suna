import type { Todo } from "@opencode-ai/sdk"
import { evaluateTodos, type TodoEnforcerResult } from "../lib/todo-enforcer"
import { parseCompletionTag, parsePlanTag, parseVerifiedTag, type AutoworkState, type ParsedCompletion, type ParsedPlan, type ParsedVerified } from "./config"

export interface AutoworkToolCallSignal {
	messageIndex: number
	tool: string
	input: unknown
	output: unknown
}

export interface AutoworkAssistantMessageSignal {
	messageIndex: number
	text: string
	completedNonQuestionToolCalls: AutoworkToolCallSignal[]
}

export interface AutoworkCompletionCandidate {
	messageIndex: number
	text: string
	parsed: ParsedCompletion
}

export interface AutoworkVerifiedCandidate {
	messageIndex: number
	text: string
	parsed: ParsedVerified
}

export interface AutoworkPlanCandidate {
	messageIndex: number
	text: string
	parsed: ParsedPlan
}

export interface AutoworkTranscriptSignals {
	assistantMessages: AutoworkAssistantMessageSignal[]
	latestAssistantMessage: AutoworkAssistantMessageSignal | null
	latestPlanCandidate: AutoworkPlanCandidate | null
	latestCompletionCandidate: AutoworkCompletionCandidate | null
	latestVerifiedCandidate: AutoworkVerifiedCandidate | null
	completedToolCalls: AutoworkToolCallSignal[]
	completedNonQuestionToolCalls: AutoworkToolCallSignal[]
	completedBashToolCalls: AutoworkToolCallSignal[]
	lastMutatingToolCall: AutoworkToolCallSignal | null
	hasAnyWorkSignal: boolean
	todoResult: TodoEnforcerResult
}

const MUTATING_TOOL_NAMES = new Set(["edit", "write", "morph_edit", "apply_patch"])

function toolName(part: any): string {
	return ((part?.tool ?? part?.toolName ?? part?.tool_name ?? part?.name ?? "") as string).trim()
}

function isQuestionTool(name: string): boolean {
	return name === "question" || name === "mcp_question"
}

export function collectAutoworkTranscriptSignals(
	messages: any[],
	todos: Todo[],
	state: AutoworkState,
	isInternalMessage: (text: string) => boolean,
): AutoworkTranscriptSignals {
	const assistantMessages: AutoworkAssistantMessageSignal[] = []
	const completedToolCalls: AutoworkToolCallSignal[] = []
	const completedNonQuestionToolCalls: AutoworkToolCallSignal[] = []
	const completedBashToolCalls: AutoworkToolCallSignal[] = []
	let lastMutatingToolCall: AutoworkToolCallSignal | null = null
	const startIndex = Math.max(0, state.messageCountAtStart)

	for (let i = startIndex; i < messages.length; i++) {
		const message = messages[i]
		if (message?.info?.role !== "assistant") continue

		let text = ""
		const messageToolCalls: AutoworkToolCallSignal[] = []

		for (const part of message.parts ?? []) {
			if (part?.type === "text" && !part.synthetic && !part.ignored) {
				text += `${part.text ?? ""}\n`
				continue
			}

			if (part?.type !== "tool") continue
			const name = toolName(part)
			const status = part?.state?.status ?? ""
			if (status !== "completed") continue

			const toolCall: AutoworkToolCallSignal = {
				messageIndex: i,
				tool: name || "unknown",
				input: part?.state?.input,
				output: part?.state?.output,
			}
			completedToolCalls.push(toolCall)
			if (name === "bash") completedBashToolCalls.push(toolCall)
			if (MUTATING_TOOL_NAMES.has(name)) lastMutatingToolCall = toolCall
			if (isQuestionTool(name)) continue

			messageToolCalls.push(toolCall)
		}

		const trimmedText = text.trim()
		if (trimmedText && isInternalMessage(trimmedText)) continue
		if (!trimmedText && messageToolCalls.length === 0) continue

		completedNonQuestionToolCalls.push(...messageToolCalls)
		assistantMessages.push({
			messageIndex: i,
			text: trimmedText,
			completedNonQuestionToolCalls: messageToolCalls,
		})
	}

	let latestPlanCandidate: AutoworkPlanCandidate | null = null
	let latestCompletionCandidate: AutoworkCompletionCandidate | null = null
	let latestVerifiedCandidate: AutoworkVerifiedCandidate | null = null
	for (const message of assistantMessages) {
		if (!message.text) continue
		const parsedPlan = parsePlanTag(message.text)
		if (parsedPlan) {
			latestPlanCandidate = {
				messageIndex: message.messageIndex,
				text: message.text,
				parsed: parsedPlan,
			}
		}
		const parsed = parseCompletionTag(message.text)
		if (parsed) {
			latestCompletionCandidate = {
				messageIndex: message.messageIndex,
				text: message.text,
				parsed,
			}
		}
		const parsedVerified = parseVerifiedTag(message.text)
		if (parsedVerified) {
			latestVerifiedCandidate = {
				messageIndex: message.messageIndex,
				text: message.text,
				parsed: parsedVerified,
			}
		}
	}

	return {
		assistantMessages,
		latestAssistantMessage: assistantMessages.at(-1) ?? null,
		latestPlanCandidate,
		latestCompletionCandidate,
		latestVerifiedCandidate,
		completedToolCalls,
		completedNonQuestionToolCalls,
		completedBashToolCalls,
		lastMutatingToolCall,
		hasAnyWorkSignal: completedNonQuestionToolCalls.length > 0,
		todoResult: evaluateTodos(todos),
	}
}
