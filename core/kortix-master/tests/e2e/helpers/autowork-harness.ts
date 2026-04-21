export function assistantMessage(text: string, parts: any[] = []) {
	return {
		info: { role: "assistant" },
		parts: [{ type: "text", text }, ...parts],
	}
}

export function completedTool(tool: string, input: any = {}, output: any = "ok") {
	return { type: "tool", tool, state: { status: "completed", input, output } }
}

export function validPlan() {
	return [
		"<kortix_autowork_plan>",
		"  <status_quo>",
		"    The current flow exists but the exact done-state is not yet locked down.",
		"  </status_quo>",
		"  <target_end_state>",
		"    The requested work is implemented and can be proven with deterministic verification.",
		"  </target_end_state>",
		"  <end_state_checklist>",
		'    - [x] "the flow returns the expected response" — required end state',
		'    - [x] "the behavior is deterministic for the requested scenario" — required end state',
		"  </end_state_checklist>",
		"  <ambiguity_check>",
		'    - [x] "no blocking ambiguity remains" — the request and success criteria are explicit enough to execute',
		"  </ambiguity_check>",
		"  <work_plan>",
		"    - [ ] inspect the relevant code",
		"    - [ ] implement the change",
		"    - [ ] rerun the final verification commands",
		"  </work_plan>",
		"  <verification_gates>",
		"    - command: bun test tests/auth.test.ts",
		"    - observe: the flow behaves exactly as requested",
		"  </verification_gates>",
		"</kortix_autowork_plan>",
	].join("\n")
}

export function validCompletion(requirement = "fix the bug") {
	return [
		"All done. Here is the completion contract:",
		"",
		"<kortix_autowork_complete>",
		"  <verification>",
		"    $ bun test tests/auth.test.ts",
		"    [exit 0] 12 passed",
		"  </verification>",
		"  <requirements_check>",
		'    - [x] "the flow returns the expected response" — patched src/auth.ts:47, regression test added',
		'    - [x] "the behavior is deterministic for the requested scenario" — the flow now behaves consistently',
		"  </requirements_check>",
		"</kortix_autowork_complete>",
	].join("\n")
}

export function validVerified() {
	return [
		"<kortix_autowork_verified>",
		"  <verification_rerun>",
		"    $ bun test tests/auth.test.ts",
		"    [exit 0] 12 passed",
		"  </verification_rerun>",
		"  <final_check>",
		'    - [x] "the flow returns the expected response" — re-audited in verifier phase',
		'    - [x] "the behavior is deterministic for the requested scenario" — re-audited in verifier phase',
		'    - [x] "the flow behaves exactly as requested" — planned observe gate rechecked',
		"  </final_check>",
		"</kortix_autowork_verified>",
	].join("\n")
}

export async function createAutoworkHarness(sessionId: string, importSalt: string) {
	const prompts: Array<{ sessionId: string; text: string }> = []
	const messages = new Map<string, any[]>()
	const todos = new Map<string, any[]>()

	void importSalt
	const autoworkMod = await import("../../../opencode/plugin/kortix-system/autowork/autowork.ts")
	const stateMod = await import("../../../opencode/plugin/kortix-system/autowork/state.ts")
	const todoMod = await import("../../../opencode/plugin/kortix-system/todo-enforcer/todo-enforcer.ts")
	autoworkMod.autoworkActiveSessions.clear()

	const client = {
		app: { log: async () => {} },
		session: {
			messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
			todo: async ({ path }: any) => ({ data: todos.get(path.id) ?? [] }),
			promptAsync: async ({ path, body }: any) => {
				prompts.push({ sessionId: path.id, text: body.parts[0].text })
			},
		},
	} as any

	const autowork = await autoworkMod.default({ client })
	const todoEnforcer = await todoMod.default({ client })

	return {
		sessionId,
		prompts,
		messages,
		todos,
		autoworkMod,
		stateMod,
		setMessages(nextMessages: any[]) {
			messages.set(sessionId, nextMessages)
		},
		setTodos(nextTodos: any[]) {
			todos.set(sessionId, nextTodos)
		},
		async sendUser(text: string) {
			await autowork["chat.message"](
				{ sessionID: sessionId },
				{ parts: [{ type: "text", text }] },
			)
		},
		async idle() {
			await autowork.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
			await todoEnforcer.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
		},
		async idleAfterCooldown() {
			const state = stateMod.loadAutoworkState(sessionId)
			const realNow = Date.now
			const targetNow = Math.max(realNow(), (state?.lastInjectedAt ?? realNow()) + 4_000)
			Date.now = () => targetNow
			try {
				await autowork.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
				await todoEnforcer.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
			} finally {
				Date.now = realNow
			}
		},
		async abort() {
			await autowork.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })
			await todoEnforcer.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })
		},
		isActive() {
			return autoworkMod.autoworkActiveSessions.has(sessionId)
		},
		loadState() {
			return stateMod.loadAutoworkState(sessionId)
		},
		resetCooldown() {
			const state = stateMod.loadAutoworkState(sessionId)
			if (!state) return
			state.lastInjectedAt = 0
			state.consecutiveFailures = 0
			state.lastFailureAt = 0
			stateMod.persistAutoworkState(state)
		},
	}
}
