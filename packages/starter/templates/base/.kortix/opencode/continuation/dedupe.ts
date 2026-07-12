import { INTERNAL_MARKER } from "./config"

const CONTINUATION_MESSAGE_PREFIX = "msg_kxcont_"

/** Concatenate all text-part content of a message. */
export function messageFullText(msg: any): string {
	let text = ""
	for (const part of msg?.parts ?? []) {
		if (part?.type === "text" && typeof part.text === "string") text += `${part.text}\n`
	}
	return text
}

/** True if a message was injected by the system and must never count as real user input. */
export function isInternalMessage(text: string): boolean {
	if (text.includes(INTERNAL_MARKER)) return true
	if (text.includes("[SYSTEM REMINDER")) return true
	if (text.includes("<kortix_system")) return true
	return false
}

export function isPassiveContinuationMessage(text: string): boolean {
	if (!isInternalMessage(text)) return false
	if (!text.includes('source="kortix-continuation"')) return false
	if (!text.includes('type="passive-continuation"')) return false
	return true
}

export function countPassiveContinuationsAfter(messages: any[], lastUserId: string | null): number {
	if (!lastUserId) return 0
	let seenLastUser = false
	let count = 0
	for (const msg of messages) {
		if (msg?.info?.role === "user" && String(msg?.info?.id ?? "") === lastUserId) {
			seenLastUser = true
			continue
		}
		if (!seenLastUser) continue
		if (msg?.info?.role !== "user") continue
		if (isPassiveContinuationMessage(messageFullText(msg))) count++
	}
	return count
}

function stableHash(input: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(36)
}

export function continuationMessageId(sessionId: string, lastUserId: string | null, continuationIndex: number): string {
	return `${CONTINUATION_MESSAGE_PREFIX}${stableHash(`${sessionId}:${lastUserId ?? "none"}:${continuationIndex}`)}`
}

export function hasContinuationMessageId(messages: any[], messageId: string): boolean {
	return messages.some((msg) => String(msg?.info?.id ?? "") === messageId)
}
