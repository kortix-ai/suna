export const MODES = ["lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"] as const

export type Mode = (typeof MODES)[number]

const state = new Map<string, Mode>()

export function isMode(value: string): value is Mode {
	return (MODES as readonly string[]).includes(value)
}

export function getMode(sessionID: string) {
	return state.get(sessionID) ?? null
}

export function setMode(sessionID: string, mode: Mode) {
	state.set(sessionID, mode)
	return mode
}

export function clearMode(sessionID: string) {
	state.delete(sessionID)
}

export function clearSession(sessionID: string) {
	state.delete(sessionID)
}
