import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { clearAllStartupAbortedSessions, markStartupAbortedSession } from "../lib/startup-aborted-sessions"
import { COMPLETION_TAG, PLAN_TAG, VERIFIED_TAG } from "./config"

const tempRoots: string[] = []
const originalStorageBase = process.env.OPENCODE_STORAGE_BASE

afterEach(() => {
	if (originalStorageBase === undefined) delete process.env.OPENCODE_STORAGE_BASE
	else process.env.OPENCODE_STORAGE_BASE = originalStorageBase
	clearAllStartupAbortedSessions()
	for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStorage(): string {
	const root = mkdtempSync(path.join(tmpdir(), "kortix-autowork-test-"))
	tempRoots.push(root)
	const storageBase = path.join(root, ".local", "share", "opencode")
	mkdirSync(storageBase, { recursive: true })
	return storageBase
}

function assistant(text: string) {
	return { info: { role: "assistant" }, parts: [{ type: "text", text }] }
}

function assistantWithParts(text: string, parts: any[] = []) {
	return { info: { role: "assistant" }, parts: [{ type: "text", text }, ...parts] }
}

function completedTool(tool: string, input: any = {}, output: any = "ok") {
	return { type: "tool", tool, state: { status: "completed", input, output } }
}

function makeClient(
	messages: Map<string, any[]>,
	prompts: Array<{ sessionId: string; text: string }>,
	todos = new Map<string, any[]>(),
) {
	return {
		app: { log: async () => {} },
		session: {
			messages: async ({ path }: any) => ({ data: messages.get(path.id) ?? [] }),
			todo: async ({ path }: any) => ({ data: todos.get(path.id) ?? [] }),
			promptAsync: async ({ path, body }: any) => {
				prompts.push({ sessionId: path.id, text: body.parts[0].text })
			},
		},
	} as any
}

function completedTodo(content = "ship the approved plan") {
	return { id: `todo-${content}`, content, status: "completed", priority: "high" }
}

function validPlan(): string {
	return [
		`<${PLAN_TAG}>`,
		"  <status_quo>",
		"    The auth flow exists but the final verified behavior is not yet established.",
		"  </status_quo>",
		"  <target_end_state>",
		"    The auth flow behaves exactly as requested and has explicit proof of correctness.",
		"  </target_end_state>",
		"  <end_state_checklist>",
		'    - [x] "auth flow returns the expected response" — required end state',
		'    - [x] "expired tokens return 401 when requested" — required end state when in scope',
		"  </end_state_checklist>",
		"  <ambiguity_check>",
		'    - [x] "no blocking ambiguity remains" — the task and expected outcome are specific enough to execute',
		"  </ambiguity_check>",
		"  <work_plan>",
		"    - [ ] inspect the relevant code path",
		"    - [ ] implement the change",
		"    - [ ] rerun the final verification gates",
		"  </work_plan>",
		"  <verification_gates>",
		"    - command: bun test tests/auth.test.ts",
		"    - observe: the auth flow returns the expected response",
		"  </verification_gates>",
		`</${PLAN_TAG}>`,
	].join("\n")
}

function validCompletion(): string {
	return [
		"All done. Here is the completion contract:",
		"",
		`<${COMPLETION_TAG}>`,
		"  <verification>",
		"    $ bun test tests/auth.test.ts",
		"    [exit 0] 12 passed",
		"  </verification>",
		"  <requirements_check>",
		'    - [x] "auth flow returns the expected response" — patched src/auth.ts:47, regression test added',
		'    - [x] "expired tokens return 401 when requested" — auth middleware now returns 401 for expired tokens',
		"  </requirements_check>",
		`</${COMPLETION_TAG}>`,
	].join("\n")
}

function validVerified(): string {
	return [
		`<${VERIFIED_TAG}>`,
		"  <verification_rerun>",
		"    $ bun test tests/auth.test.ts",
		"    [exit 0] 12 passed",
		"  </verification_rerun>",
		"  <final_check>",
		'    - [x] "auth flow returns the expected response" — re-audited in verifier phase',
		'    - [x] "expired tokens return 401 when requested" — re-audited in verifier phase',
		'    - [x] "the auth flow returns the expected response" — planned observe gate rechecked',
		"  </final_check>",
		`</${VERIFIED_TAG}>`,
	].join("\n")
}

async function activateAutowork(plugin: any, sessionId: string) {
	await plugin["chat.message"](
		{ sessionID: sessionId },
		{ parts: [{ type: "text", text: "/autowork fix the bug" }] },
	)
}

async function approvePlan(plugin: any, sessionId: string, messages: Map<string, any[]>) {
	messages.set(sessionId, [assistant(validPlan())])
	await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
}

async function idleWithCooldown(plugin: any, stateMod: any, sessionId: string) {
	const state = stateMod.loadAutoworkState(sessionId)
	const realNow = Date.now
	const targetNow = Math.max(realNow(), (state?.lastInjectedAt ?? realNow()) + 4_000)
	Date.now = () => targetNow
	try {
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
	} finally {
		Date.now = realNow
	}
}

describe("Autowork plugin integration", () => {
	test("starts in planning phase and asks for a plan before execution", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-planning-start=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-planning-start=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_autowork_plan_first"

		messages.set(sessionId, [])
		await activateAutowork(plugin, sessionId)
		messages.set(sessionId, [assistant("Still thinking about it.")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.text).toContain(`<${PLAN_TAG}>`)
		expect(stateMod.loadAutoworkState(sessionId)?.phase).toBe("planning")
	})

	test("valid plan transitions the loop into execution phase", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-plan-approve=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-plan-approve=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_autowork_plan_approve"

		messages.set(sessionId, [])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)

		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.text).toContain("Planning is complete")
		expect(prompts[0]?.text).toContain(`<${PLAN_TAG}>`)
		expect(stateMod.loadAutoworkState(sessionId)?.phase).toBe("execution")
		expect(stateMod.loadAutoworkState(sessionId)?.approvedPlan).toContain(`<${PLAN_TAG}>`)
	})

	test("uses the activation turn assistant output as the first planning candidate", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-activation-turn-plan=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-activation-turn-plan=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_autowork_activation_turn_plan"

		messages.set(sessionId, [assistant(validPlan())])
		await activateAutowork(plugin, sessionId)
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.text).toContain("Planning is complete")
		expect(stateMod.loadAutoworkState(sessionId)?.phase).toBe("execution")
	})

	test("enters verifier phase after a valid completion candidate", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
 		const todos = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-complete=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-complete=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts, todos) })
		const sessionId = "ses_autowork_complete"

		messages.set(sessionId, [])
		todos.set(sessionId, [completedTodo()])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)

		messages.set(sessionId, [
			assistant(validPlan()),
			assistantWithParts(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.text).toContain(`<${VERIFIED_TAG}>`)
		expect(stateMod.loadAutoworkState(sessionId)?.phase).toBe("verifying")
		expect(stateMod.loadAutoworkState(sessionId)?.approvedCompletion).toContain(`<${COMPLETION_TAG}>`)
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(true)
	})

	test("does not stall on cooldown when a fresh assistant completion arrives", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const todos = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-fresh-message-bypass=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-fresh-message-bypass=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts, todos) })
		const sessionId = "ses_autowork_fresh_message_bypass"

		messages.set(sessionId, [])
		todos.set(sessionId, [completedTodo()])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)

		messages.set(sessionId, [
			assistant(validPlan()),
			assistantWithParts(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.text).toContain(`<${VERIFIED_TAG}>`)
		expect(stateMod.loadAutoworkState(sessionId)?.phase).toBe("verifying")
	})

	test("stops only after the mandatory verifier pass succeeds", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
 		const todos = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-verified-complete=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-verified-complete=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts, todos) })
		const sessionId = "ses_autowork_verified_complete"

		messages.set(sessionId, [])
		todos.set(sessionId, [completedTodo()])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)

		messages.set(sessionId, [
			assistant(validPlan()),
			assistantWithParts(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(stateMod.loadAutoworkState(sessionId)?.phase).toBe("verifying")

		messages.set(sessionId, [
			assistant(validPlan()),
			assistantWithParts(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
			assistantWithParts(validVerified(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)?.active).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)?.stopReason).toBe("complete")
	})

	test("rejects verifier tags that do not rerun verification commands in the verifier message", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
 		const todos = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-verifier-reject=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-verifier-reject=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts, todos) })
		const sessionId = "ses_autowork_verifier_reject"

		messages.set(sessionId, [])
		todos.set(sessionId, [completedTodo()])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)

		messages.set(sessionId, [
			assistant(validPlan()),
			assistantWithParts(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
		])
		await idleWithCooldown(plugin, stateMod, sessionId)

		messages.set(sessionId, [
			assistant(validPlan()),
			assistantWithParts(validCompletion(), [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
			assistant(validVerified()),
		])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(prompts).toHaveLength(3)
		expect(prompts[2]?.text).toContain("verification commands not backed by completed bash runs")
		expect(stateMod.loadAutoworkState(sessionId)?.phase).toBe("verifying")
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(true)
	})

	test("rejects completion when verification commands were not actually run via bash", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
 		const todos = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-missing-bash-proof=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-missing-bash-proof=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts, todos) })
		const sessionId = "ses_autowork_missing_bash_proof"

		messages.set(sessionId, [])
		todos.set(sessionId, [completedTodo()])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)


		messages.set(sessionId, [
			assistant(validPlan()),
			assistantWithParts(validCompletion(), [completedTool("read", { path: "src/auth.ts" }, "done")]),
		])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.text).toContain("verification commands not backed by completed bash runs")
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(true)
	})

	test("rejects completion when verification went stale after a later edit", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
 		const todos = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-stale-verification=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-stale-verification=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts, todos) })
		const sessionId = "ses_autowork_stale_verification"

		messages.set(sessionId, [])
		todos.set(sessionId, [completedTodo()])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)

		messages.set(sessionId, [
			assistant(validPlan()),
			assistantWithParts("Ran tests once.", [completedTool("bash", { command: "bun test tests/auth.test.ts" }, "[exit 0] 12 passed")]),
			assistantWithParts("Made one more code tweak.", [completedTool("edit", { filePath: "src/auth.ts" }, "patched")]),
			assistant(validCompletion()),
		])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.text).toContain("verification stale after newer code changes")
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(true)
	})

	test("re-anchors user follow-up messages in the next execution continuation", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
 		const todos = new Map<string, any[]>()

		const plugin = await (await import(`./autowork.ts?autowork-followup=${Date.now()}`)).default({ client: makeClient(messages, prompts, todos) })
		const stateMod = await import(`./state.ts?autowork-followup=${Date.now()}`)
		const sessionId = "ses_autowork_followup"

		messages.set(sessionId, [])
		todos.set(sessionId, [completedTodo()])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)
		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "Also make sure it handles expired tokens with a 401." }] },
		)


		messages.set(sessionId, [assistant(validPlan()), assistant("Working on it.")])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.text).toContain("expired tokens with a 401")
	})

	test("requires native todo tracking during execution", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-require-todos=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-require-todos=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_autowork_require_todos"

		messages.set(sessionId, [])
		await activateAutowork(plugin, sessionId)
		await approvePlan(plugin, sessionId, messages)

		messages.set(sessionId, [assistant(validPlan()), assistant("Starting implementation.")])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.text).toContain("Native todo tracking is required")
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(true)
	})

	test("max iterations stops the loop with failed reason", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-maxiter=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-maxiter=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_autowork_maxiter"

		messages.set(sessionId, [])
		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork --max-iterations 1 fix it" }] },
		)

		messages.set(sessionId, [assistant("still planning")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
		expect(prompts).toHaveLength(1)

		messages.set(sessionId, [assistant("still planning"), assistant("still planning 2")])
		await idleWithCooldown(plugin, stateMod, sessionId)

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)?.stopReason).toBe("failed")
	})

	test("startup-aborted sessions do not resume persisted autowork", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()
		const sessionId = "ses_autowork_startup_abort"

		const stateMod = await import(`./state.ts?autowork-startup-state=${Date.now()}`)
		stateMod.startAutowork("fix the zombie session", sessionId, 0, 50)
		markStartupAbortedSession(sessionId)

		const pluginMod = await import(`./autowork.ts?autowork-startup-abort=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		messages.set(sessionId, [assistant("Still working")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)).toBeNull()
	})

	test("does not activate autowork when a message merely mentions /autowork", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-mention=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_autowork_mention"

		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "If you need to restart it later, use /autowork with a fresh task." }] },
		)

		messages.set(sessionId, [assistant("Still idle")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
	})

	test("ignores stale pending autowork commands instead of deriving garbage task text", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const prompts: Array<{ sessionId: string; text: string }> = []
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-stale-pending=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, prompts) })
		const sessionId = "ses_autowork_stale_pending"

		await plugin["command.execute.before"]({ command: "autowork", sessionID: sessionId, arguments: "" })
		const realNow = Date.now
		Date.now = () => realNow() + 16_000
		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: '<todo status="in_progress" priority="high">Inspect bug</todo>' }] },
		)
		Date.now = realNow

		messages.set(sessionId, [assistant("Still idle")])
		await plugin.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		expect(prompts).toHaveLength(0)
		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
	})

	test("session.aborted cancels autowork and removes persisted state", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const messages = new Map<string, any[]>()

		const pluginMod = await import(`./autowork.ts?autowork-abort-cancel=${Date.now()}`)
		const stateMod = await import(`./state.ts?autowork-abort-cancel=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, []) })
		const sessionId = "ses_autowork_abort_cancel"

		messages.set(sessionId, [])
		await activateAutowork(plugin, sessionId)

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(true)
		expect(stateMod.loadAutoworkState(sessionId)?.active).toBe(true)

		await plugin.event({ event: { type: "session.aborted", properties: { sessionID: sessionId } } })

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)).toBeNull()
	})

	test("autowork-cancel clears persisted state even when in-memory state is inactive", async () => {
		process.env.OPENCODE_STORAGE_BASE = makeStorage()
		const messages = new Map<string, any[]>()

		const stateMod = await import(`./state.ts?autowork-cancel-persisted=${Date.now()}`)
		stateMod.startAutowork("fix the bug", "ses_autowork_cancel_persisted", 0, 50)

		const pluginMod = await import(`./autowork.ts?autowork-cancel-persisted=${Date.now()}`)
		const plugin = await pluginMod.default({ client: makeClient(messages, []) })
		const sessionId = "ses_autowork_cancel_persisted"

		await plugin.event({ event: { type: "session.deleted", properties: { sessionID: sessionId } } })
		stateMod.startAutowork("fix the bug", sessionId, 0, 50)

		await plugin["chat.message"](
			{ sessionID: sessionId },
			{ parts: [{ type: "text", text: "/autowork-cancel" }] },
		)

		expect(pluginMod.autoworkActiveSessions.has(sessionId)).toBe(false)
		expect(stateMod.loadAutoworkState(sessionId)).toBeNull()
	})
})
