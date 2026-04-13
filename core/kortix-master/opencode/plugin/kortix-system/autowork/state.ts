import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureKortixDir } from "../lib/paths"
import { AUTOWORK_DEFAULTS, createInitialAutoworkState, type AutoworkState } from "./config"
import type { AutoworkStopReason } from "./engine"

function stateDir(): string {
	return `${ensureKortixDir(import.meta.dir)}/autowork-states`
}

function statePath(sessionId: string): string {
	return join(stateDir(), `${sessionId}.json`)
}

export function persistAutoworkState(state: AutoworkState): void {
	try {
		if (!state.sessionId) return
		const dir = stateDir()
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
		writeFileSync(statePath(state.sessionId), JSON.stringify(state, null, 2), "utf-8")
	} catch {
		// non-fatal
	}
}

export function loadAutoworkState(sessionId: string): AutoworkState | null {
	try {
		const path = statePath(sessionId)
		if (!existsSync(path)) return null
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AutoworkState>
		if (typeof parsed.active !== "boolean") return null
		// Merge with defaults so old-schema state files still load cleanly.
		return { ...createInitialAutoworkState(), ...parsed } as AutoworkState
	} catch {
		return null
	}
}

export function loadAllAutoworkStates(): Map<string, AutoworkState> {
	const states = new Map<string, AutoworkState>()
	try {
		const dir = stateDir()
		if (!existsSync(dir)) return states
		for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
			try {
				const parsed = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Partial<AutoworkState>
				if (parsed.sessionId && typeof parsed.active === "boolean") {
					states.set(parsed.sessionId, { ...createInitialAutoworkState(), ...parsed } as AutoworkState)
				}
			} catch {
				// ignore broken state file
			}
		}
	} catch {
		// ignore
	}
	return states
}

export function removeAutoworkState(sessionId: string): void {
	try {
		const path = statePath(sessionId)
		if (existsSync(path)) unlinkSync(path)
	} catch {
		// ignore
	}
}

export function startAutowork(
	taskPrompt: string,
	sessionId: string,
	messageCountAtStart = 0,
	maxIterations: number = AUTOWORK_DEFAULTS.maxIterations,
): AutoworkState {
	const state: AutoworkState = {
		...createInitialAutoworkState(),
		active: true,
		sessionId,
		taskPrompt,
		messageCountAtStart,
		maxIterations,
		startedAt: Date.now(),
		stopped: false,
	}
	persistAutoworkState(state)
	return state
}

export function stopAutowork(state: AutoworkState, stopReason: AutoworkStopReason): AutoworkState {
	const updated: AutoworkState = {
		...state,
		active: false,
		stopped: true,
		stopReason,
		completedAt: Date.now(),
	}
	persistAutoworkState(updated)
	return updated
}

export function appendTaskContext(state: AutoworkState, text: string): AutoworkState {
	const updated: AutoworkState = {
		...state,
		taskPrompt: state.taskPrompt ? `${state.taskPrompt}\n\n${text}` : text,
	}
	persistAutoworkState(updated)
	return updated
}

export function advanceAutowork(state: AutoworkState): AutoworkState {
	const updated: AutoworkState = {
		...state,
		iteration: state.iteration + 1,
		lastInjectedAt: Date.now(),
		consecutiveFailures: 0,
	}
	persistAutoworkState(updated)
	return updated
}

export function recordAutoworkFailure(state: AutoworkState): AutoworkState {
	const updated: AutoworkState = {
		...state,
		consecutiveFailures: state.consecutiveFailures + 1,
		lastFailureAt: Date.now(),
	}
	persistAutoworkState(updated)
	return updated
}

export function recordAutoworkAbort(state: AutoworkState): AutoworkState {
	const updated: AutoworkState = {
		...state,
		lastAbortAt: Date.now(),
	}
	persistAutoworkState(updated)
	return updated
}
