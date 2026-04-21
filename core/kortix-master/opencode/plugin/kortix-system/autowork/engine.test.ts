import { describe, expect, test } from "bun:test"
import {
	COMPLETION_TAG,
	PLAN_TAG,
	SYSTEM_WRAPPER_TAG,
	VERIFIED_TAG,
	createInitialAutoworkState,
	parseCompletionTag,
	parsePlanTag,
	parseVerifiedTag,
	renderApprovedPlan,
} from "./config"
import { evaluateAutowork } from "./engine"

function makeState(overrides: Record<string, unknown> = {}) {
	return {
		...createInitialAutoworkState(),
		active: true,
		phase: "execution",
		sessionId: "ses-test",
		taskPrompt: "build the signup flow",
		...overrides,
	}
}

function toolCall(tool: string, messageIndex: number, input: any = {}, output: any = "ok") {
	return { messageIndex, tool, input, output }
}

function makeSignals(overrides: Record<string, unknown> = {}) {
	const latestAssistantMessage = {
		messageIndex: 0,
		text: "Still working on the signup flow.",
		completedNonQuestionToolCalls: [],
	}
	return {
		assistantMessages: [latestAssistantMessage],
		latestAssistantMessage,
		latestPlanCandidate: null,
		latestCompletionCandidate: null,
		latestVerifiedCandidate: null,
		completedToolCalls: [],
		completedNonQuestionToolCalls: [],
		completedBashToolCalls: [],
		lastMutatingToolCall: null,
		hasAnyWorkSignal: false,
		todoResult: {
			verdict: "done",
			reason: "all 1 items completed",
			remainingItems: [],
			totalItems: 1,
			completedItems: 1,
		},
		...overrides,
	}
}

function planCandidate(text: string, messageIndex = 0) {
	const parsed = parsePlanTag(text)
	if (!parsed) throw new Error("expected plan tag in test fixture")
	return { text, messageIndex, parsed }
}

function completionCandidate(text: string, messageIndex = 0) {
	const parsed = parseCompletionTag(text)
	if (!parsed) throw new Error("expected completion tag in test fixture")
	return { text, messageIndex, parsed }
}

function verifiedCandidate(text: string, messageIndex = 0) {
	const parsed = parseVerifiedTag(text)
	if (!parsed) throw new Error("expected verified tag in test fixture")
	return { text, messageIndex, parsed }
}

function validPlanBlock(): string {
	return `
<${PLAN_TAG}>
  <status_quo>
    The signup flow exists but the duplicate-email handling is inconsistent.
  </status_quo>
  <target_end_state>
    Signup always returns the expected response and the behavior is fully proven.
  </target_end_state>
  <end_state_checklist>
    - [x] "signup returns the expected response" — this is the required end state
    - [x] "duplicate-email handling is deterministic" — this is the required end state
  </end_state_checklist>
  <ambiguity_check>
    - [x] "no blocking ambiguity remains" — duplicate-email behavior was clarified from the request
  </ambiguity_check>
  <work_plan>
    - [ ] inspect the signup handler and tests
    - [ ] implement the behavior change
    - [ ] rerun the final verification gates
  </work_plan>
  <verification_gates>
    - command: bun test tests/signup.test.ts
    - observe: signup returns the expected response
  </verification_gates>
</${PLAN_TAG}>
`.trim()
}

function validCompletionBlock(): string {
	return `
<${COMPLETION_TAG}>
  <verification>
    $ bun test tests/signup.test.ts
    [exit 0] 4 passed
  </verification>
  <requirements_check>
    - [x] "signup returns the expected response" — tests pass and code was updated
    - [x] "duplicate-email handling is deterministic" — the verified flow now behaves consistently
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
}

function validVerifiedBlock(): string {
	return `
<${VERIFIED_TAG}>
  <verification_rerun>
    $ bun test tests/signup.test.ts
    [exit 0] 4 passed
  </verification_rerun>
  <final_check>
    - [x] "signup returns the expected response" — re-audited in verifier phase
    - [x] "duplicate-email handling is deterministic" — re-audited in verifier phase
    - [x] "signup returns the expected response" — planned observe gate rechecked
  </final_check>
</${VERIFIED_TAG}>
`.trim()
}

describe("evaluateAutowork", () => {
	test("planning phase asks for a structured plan before execution", () => {
		const decision = evaluateAutowork(makeState({ phase: "planning" }), makeSignals())
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain(`<${SYSTEM_WRAPPER_TAG}`)
		expect(decision.prompt).toContain(`<${PLAN_TAG}>`)
		expect(decision.prompt).toContain("status quo")
	})

	test("planning phase rejects unresolved ambiguity in the plan", () => {
		const text = `
<${PLAN_TAG}>
  <status_quo>Current behavior is unclear.</status_quo>
  <target_end_state>We should have a better flow.</target_end_state>
  <end_state_checklist>
    - [x] "better flow exists" — required end state
  </end_state_checklist>
  <ambiguity_check>
    - [ ] "what should happen on duplicate email" — still unknown
  </ambiguity_check>
  <work_plan>
    - [ ] implement it
  </work_plan>
  <verification_gates>
    - command: bun test tests/signup.test.ts
  </verification_gates>
</${PLAN_TAG}>
`.trim()
		const decision = evaluateAutowork(makeState({ phase: "planning" }), makeSignals({
			assistantMessages: [{ messageIndex: 0, text, completedNonQuestionToolCalls: [] }],
			latestAssistantMessage: { messageIndex: 0, text, completedNonQuestionToolCalls: [] },
			latestPlanCandidate: planCandidate(text),
		}))
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("unresolved ambiguity item")
	})

	test("planning phase approves a valid plan and transitions to execution", () => {
		const text = validPlanBlock()
		const decision = evaluateAutowork(makeState({ phase: "planning" }), makeSignals({
			assistantMessages: [{ messageIndex: 0, text, completedNonQuestionToolCalls: [] }],
			latestAssistantMessage: { messageIndex: 0, text, completedNonQuestionToolCalls: [] },
			latestPlanCandidate: planCandidate(text),
		}))
		expect(decision.action).toBe("continue")
		expect(decision.nextPhase).toBe("execution")
		expect(decision.approvedPlan).toBe(renderApprovedPlan(planCandidate(text).parsed))
		expect(decision.prompt).toContain("Planning is complete")
	})

	test("execution phase advances to mandatory verifier phase instead of stopping immediately", () => {
		const text = validCompletionBlock()
		const edit = toolCall("edit", 0, { filePath: "src/auth/signup.ts" }, "patched")
		const testRun = toolCall("bash", 1, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const decision = evaluateAutowork(makeState({ approvedPlan: validPlanBlock() }), makeSignals({
			assistantMessages: [{ messageIndex: 2, text, completedNonQuestionToolCalls: [testRun] }],
			latestAssistantMessage: { messageIndex: 2, text, completedNonQuestionToolCalls: [testRun] },
			latestCompletionCandidate: completionCandidate(text, 2),
			completedToolCalls: [edit, testRun],
			completedNonQuestionToolCalls: [edit, testRun],
			completedBashToolCalls: [testRun],
			lastMutatingToolCall: edit,
			hasAnyWorkSignal: true,
		}))
		expect(decision.action).toBe("continue")
		expect(decision.nextPhase).toBe("verifying")
		expect(decision.approvedCompletion).toContain(`<${COMPLETION_TAG}>`)
		expect(decision.prompt).toContain(`<${VERIFIED_TAG}>`)
	})

	test("execution requires native todo tracking before proceeding", () => {
		const decision = evaluateAutowork(makeState({ approvedPlan: validPlanBlock() }), makeSignals({
			todoResult: {
				verdict: "done",
				reason: "no tracked work",
				remainingItems: [],
				totalItems: 0,
				completedItems: 0,
			},
		}))
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("Native todo tracking is required")
	})

	test("execution rejects completion when planned end-state items are not all covered", () => {
		const text = `
<${COMPLETION_TAG}>
  <verification>
    $ bun test tests/signup.test.ts
    [exit 0] 4 passed
  </verification>
  <requirements_check>
    - [x] "signup returns the expected response" — tests pass
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
		const edit = toolCall("edit", 0, { filePath: "src/auth/signup.ts" }, "patched")
		const testRun = toolCall("bash", 1, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const decision = evaluateAutowork(makeState({ approvedPlan: validPlanBlock() }), makeSignals({
			assistantMessages: [{ messageIndex: 2, text, completedNonQuestionToolCalls: [testRun] }],
			latestAssistantMessage: { messageIndex: 2, text, completedNonQuestionToolCalls: [testRun] },
			latestCompletionCandidate: completionCandidate(text, 2),
			completedToolCalls: [edit, testRun],
			completedNonQuestionToolCalls: [edit, testRun],
			completedBashToolCalls: [testRun],
			lastMutatingToolCall: edit,
			hasAnyWorkSignal: true,
		}))
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("completion does not cover all planned end-state items")
	})

	test("verifier phase stops only when verifier tag reruns the approved verification commands", () => {
		const completion = validCompletionBlock()
		const verified = validVerifiedBlock()
		const initialRun = toolCall("bash", 1, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const verifierRun = toolCall("bash", 4, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const decision = evaluateAutowork(makeState({ phase: "verifying", approvedPlan: validPlanBlock(), approvedCompletion: completion }), makeSignals({
			assistantMessages: [{ messageIndex: 4, text: verified, completedNonQuestionToolCalls: [verifierRun] }],
			latestAssistantMessage: { messageIndex: 4, text: verified, completedNonQuestionToolCalls: [verifierRun] },
			latestVerifiedCandidate: verifiedCandidate(verified, 4),
			completedToolCalls: [initialRun, verifierRun],
			completedNonQuestionToolCalls: [initialRun, verifierRun],
			completedBashToolCalls: [initialRun, verifierRun],
			hasAnyWorkSignal: true,
		}))
		expect(decision.action).toBe("stop")
		expect(decision.stopReason).toBe("complete")
	})

	test("verifier phase rejects tags without same-message bash reruns", () => {
		const completion = validCompletionBlock()
		const verified = validVerifiedBlock()
		const initialRun = toolCall("bash", 1, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const decision = evaluateAutowork(makeState({ phase: "verifying", approvedPlan: validPlanBlock(), approvedCompletion: completion }), makeSignals({
			assistantMessages: [{ messageIndex: 4, text: verified, completedNonQuestionToolCalls: [] }],
			latestAssistantMessage: { messageIndex: 4, text: verified, completedNonQuestionToolCalls: [] },
			latestVerifiedCandidate: verifiedCandidate(verified, 4),
			completedToolCalls: [initialRun],
			completedNonQuestionToolCalls: [initialRun],
			completedBashToolCalls: [initialRun],
			hasAnyWorkSignal: true,
		}))
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("verification commands not backed by completed bash runs")
	})

	test("verifier phase rejects final checks that miss planned observe gates", () => {
		const planWithDistinctObserveGate = `
<${PLAN_TAG}>
  <status_quo>
    The signup flow exists but the duplicate-email handling is inconsistent.
  </status_quo>
  <target_end_state>
    Signup always returns the expected response and the behavior is fully proven.
  </target_end_state>
  <end_state_checklist>
    - [x] "signup returns the expected response" — this is the required end state
    - [x] "duplicate-email handling is deterministic" — this is the required end state
  </end_state_checklist>
  <ambiguity_check>
    - [x] "no blocking ambiguity remains" — duplicate-email behavior was clarified from the request
  </ambiguity_check>
  <work_plan>
    - [ ] inspect the signup handler and tests
    - [ ] implement the behavior change
    - [ ] rerun the final verification gates
  </work_plan>
  <verification_gates>
    - command: bun test tests/signup.test.ts
    - observe: duplicate email response includes code DUPLICATE_EMAIL
  </verification_gates>
</${PLAN_TAG}>
`.trim()
		const completion = validCompletionBlock()
		const verified = `
<${VERIFIED_TAG}>
  <verification_rerun>
    $ bun test tests/signup.test.ts
    [exit 0] 4 passed
  </verification_rerun>
  <final_check>
    - [x] "signup returns the expected response" — re-audited in verifier phase
    - [x] "duplicate-email handling is deterministic" — re-audited in verifier phase
  </final_check>
</${VERIFIED_TAG}>
`.trim()
		const verifierRun = toolCall("bash", 4, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const decision = evaluateAutowork(makeState({ phase: "verifying", approvedPlan: planWithDistinctObserveGate, approvedCompletion: completion }), makeSignals({
			assistantMessages: [{ messageIndex: 4, text: verified, completedNonQuestionToolCalls: [verifierRun] }],
			latestAssistantMessage: { messageIndex: 4, text: verified, completedNonQuestionToolCalls: [verifierRun] },
			latestVerifiedCandidate: verifiedCandidate(verified, 4),
			completedToolCalls: [verifierRun],
			completedNonQuestionToolCalls: [verifierRun],
			completedBashToolCalls: [verifierRun],
			hasAnyWorkSignal: true,
		}))
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("verifier final check does not cover all planned proof items")
	})

	test("execution rejects completion when claimed verification commands were not run via bash", () => {
		const text = validCompletionBlock()
		const read = toolCall("read", 0, { path: "src/auth/signup.ts" }, "file contents")
		const decision = evaluateAutowork(makeState({ approvedPlan: validPlanBlock() }), makeSignals({
			assistantMessages: [{ messageIndex: 1, text, completedNonQuestionToolCalls: [read] }],
			latestAssistantMessage: { messageIndex: 1, text, completedNonQuestionToolCalls: [read] },
			latestCompletionCandidate: completionCandidate(text, 1),
			completedToolCalls: [read],
			completedNonQuestionToolCalls: [read],
			hasAnyWorkSignal: true,
		}))
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("verification commands not backed by completed bash runs")
	})

	test("execution rejects completion when verification went stale after a later edit", () => {
		const text = validCompletionBlock()
		const oldTestRun = toolCall("bash", 0, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const laterEdit = toolCall("edit", 1, { filePath: "src/auth/signup.ts" }, "patched again")
		const decision = evaluateAutowork(makeState({ approvedPlan: validPlanBlock() }), makeSignals({
			assistantMessages: [{ messageIndex: 2, text, completedNonQuestionToolCalls: [laterEdit] }],
			latestAssistantMessage: { messageIndex: 2, text, completedNonQuestionToolCalls: [laterEdit] },
			latestCompletionCandidate: completionCandidate(text, 2),
			completedToolCalls: [oldTestRun, laterEdit],
			completedNonQuestionToolCalls: [oldTestRun, laterEdit],
			completedBashToolCalls: [oldTestRun],
			lastMutatingToolCall: laterEdit,
			hasAnyWorkSignal: true,
		}))
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("verification stale after newer code changes")
	})

	test("execution rejects completion when unfinished native todos remain", () => {
		const text = validCompletionBlock()
		const testRun = toolCall("bash", 0, { command: "bun test tests/signup.test.ts" }, "[exit 0] 4 passed")
		const decision = evaluateAutowork(makeState({ approvedPlan: validPlanBlock() }), makeSignals({
			assistantMessages: [{ messageIndex: 1, text, completedNonQuestionToolCalls: [testRun] }],
			latestAssistantMessage: { messageIndex: 1, text, completedNonQuestionToolCalls: [testRun] },
			latestCompletionCandidate: completionCandidate(text, 1),
			completedToolCalls: [testRun],
			completedNonQuestionToolCalls: [testRun],
			completedBashToolCalls: [testRun],
			hasAnyWorkSignal: true,
			todoResult: {
				verdict: "unfinished",
				reason: "1 remaining (1 pending) of 1 total",
				remainingItems: [{ id: "todo-1", content: "write regression test", status: "pending", priority: "high" }],
				totalItems: 1,
				completedItems: 0,
			},
		}))
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("unfinished native todo items remain")
	})

	test("stops with failed reason when max iterations reached", () => {
		const decision = evaluateAutowork(makeState({ iteration: 50, maxIterations: 50 }), makeSignals())
		expect(decision.action).toBe("stop")
		expect(decision.stopReason).toBe("failed")
		expect(decision.reason).toContain("max iterations")
	})
})
