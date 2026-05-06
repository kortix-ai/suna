export function assistantMessage(text: string, parts: any[] = []) {
	return {
		info: { role: "assistant" },
		parts: [{ type: "text", text }, ...parts],
	}
}

export function completedTool(tool: string, input: any = {}, output: any = "ok") {
	return { type: "tool", tool, state: { status: "completed", input, output } }
}

export async function createGoalHarness(sessionId: string, importSalt: string) {
	const prompts: Array<{ sessionId: string; text: string }> = []
	const messages = new Map<string, any[]>()

	void importSalt
	const goalMod = await import("../../../opencode/plugin/kortix-system/goal/goal.ts")
	const stateMod = await import("../../../opencode/plugin/kortix-system/goal/state.ts")
	goalMod.goalActiveSessions.clear()

	const client = {
		app: { log: async () => {} },
		session: {
			messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
			promptAsync: async ({ path, body }: any) => {
				prompts.push({ sessionId: path.id, text: body.parts[0].text })
			},
		},
	} as any

	const goal = await goalMod.default({ client })

	return {
		sessionId,
		prompts,
		messages,
		goalMod,
		stateMod,
		setMessages(nextMessages: any[]) {
			messages.set(sessionId, nextMessages)
		},
		async sendUser(text: string) {
			await goal["chat.message"](
				{ sessionID: sessionId },
				{ parts: [{ type: "text", text }] },
			)
		},
		async idle() {
			await goal.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
		},
		async idleAfterCooldown() {
			const state = stateMod.loadGoalState(sessionId)
			const realNow = Date.now
			const targetNow = Math.max(realNow(), (state?.lastInjectedAt ?? realNow()) + 4_000)
			Date.now = () => targetNow
			try {
				await goal.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
			} finally {
				Date.now = realNow
			}
		},
		async abort() {
			await goal.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })
		},
		isActive() {
			return goalMod.goalActiveSessions.has(sessionId)
		},
		loadState() {
			return stateMod.loadGoalState(sessionId)
		},
		resetCooldown() {
			const state = stateMod.loadGoalState(sessionId)
			if (!state) return
			state.lastInjectedAt = 0
			state.consecutiveFailures = 0
			state.lastFailureAt = 0
			stateMod.persistGoalState(state)
		},
	}
}
