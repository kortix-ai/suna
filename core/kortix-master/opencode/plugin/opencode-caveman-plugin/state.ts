export const MODES = ["lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"] as const

export type Mode = (typeof MODES)[number]

export type SessionState = {
	mode: Mode | null
	disabled: boolean
	agent: string | null
}

const state = new Map<string, SessionState>()

function current(sessionID: string): SessionState {
	return state.get(sessionID) ?? { mode: null, disabled: false, agent: null }
}

export function isMode(value: string): value is Mode {
	return (MODES as readonly string[]).includes(value)
}

export function getMode(sessionID: string) {
	return current(sessionID).mode
}

export function setMode(sessionID: string, mode: Mode) {
	state.set(sessionID, { ...current(sessionID), mode, disabled: false })
	return mode
}

export function clearMode(sessionID: string) {
	state.set(sessionID, { ...current(sessionID), mode: null, disabled: true })
}

export function getSessionState(sessionID: string) {
	return current(sessionID)
}

export function rememberAgent(sessionID: string, agent?: string | null) {
	if (!agent) return current(sessionID)
	const next = { ...current(sessionID), agent }
	state.set(sessionID, next)
	return next
}

export function clearSession(sessionID: string) {
	state.delete(sessionID)
}
