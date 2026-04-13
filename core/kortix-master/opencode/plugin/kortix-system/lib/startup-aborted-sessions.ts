const startupAbortedSessions = new Set<string>()

export function markStartupAbortedSession(sessionId: string): void {
	if (!sessionId) return
	startupAbortedSessions.add(sessionId)
}

export function hasStartupAbortedSession(sessionId: string): boolean {
	if (!sessionId) return false
	return startupAbortedSessions.has(sessionId)
}

export function clearStartupAbortedSession(sessionId: string): void {
	if (!sessionId) return
	startupAbortedSessions.delete(sessionId)
}

export function clearAllStartupAbortedSessions(): void {
	startupAbortedSessions.clear()
}
