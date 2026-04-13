import { describe, expect, test } from "bun:test"
import { COMPLETION_TAG, SYSTEM_WRAPPER_TAG, createInitialAutoworkState } from "./config"
import { evaluateAutowork } from "./engine"

function makeState(overrides: Record<string, unknown> = {}) {
	return {
		...createInitialAutoworkState(),
		active: true,
		sessionId: "ses-test",
		taskPrompt: "build the signup flow",
		...overrides,
	}
}

function validCompletionBlock(): string {
	return `
Here is the completion contract.

<${COMPLETION_TAG}>
  <verification>
    $ bun test tests/signup.test.ts
    [exit 0] 4 passed
    $ curl -X POST http://localhost:8080/signup -d '{"email":"a@b.c"}'
    201 {"id":"u_123"}
  </verification>
  <requirements_check>
    - [x] "build the signup flow" — src/auth/signup.ts:1, integration test passes
    - [x] "must return 201 on success" — curl above returned 201
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
}

describe("evaluateAutowork", () => {
	test("continues when no completion tag is present", () => {
		const state = makeState()
		const decision = evaluateAutowork(state, ["Still working on the signup flow."])
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain(`<${SYSTEM_WRAPPER_TAG}`)
		expect(decision.prompt).toContain("Iteration 1/50")
		expect(decision.prompt).toContain("build the signup flow")
	})

	test("stops cleanly on a well-formed completion tag", () => {
		const state = makeState()
		const decision = evaluateAutowork(state, [validCompletionBlock()])
		expect(decision.action).toBe("stop")
		expect(decision.stopReason).toBe("complete")
	})

	test("rejects completion with empty <verification>", () => {
		const state = makeState()
		const text = `
<${COMPLETION_TAG}>
  <verification></verification>
  <requirements_check>
    - [x] "build the signup flow" — done
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
		const decision = evaluateAutowork(state, [text])
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("REJECTED")
		expect(decision.prompt).toContain("empty <verification>")
	})

	test("rejects completion with unchecked items", () => {
		const state = makeState()
		const text = `
<${COMPLETION_TAG}>
  <verification>ran tests, all green</verification>
  <requirements_check>
    - [x] "build the signup flow" — done
    - [ ] "must return 201 on success" — not verified yet
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
		const decision = evaluateAutowork(state, [text])
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("unchecked requirement item")
		expect(decision.prompt).toContain("must return 201 on success")
	})

	test("rejects completion with missing <requirements_check>", () => {
		const state = makeState()
		const text = `
<${COMPLETION_TAG}>
  <verification>ran tests, all green</verification>
</${COMPLETION_TAG}>
`.trim()
		const decision = evaluateAutowork(state, [text])
		expect(decision.action).toBe("continue")
		expect(decision.prompt).toContain("REJECTED")
	})

	test("ignores the completion tag if it appears inside a code block discussion", () => {
		// The worker writing example documentation about the tag should NOT trigger
		// completion. The only way the engine is fooled is if the tag literally
		// appears in the assistant text — but because the tag is namespaced + XML,
		// incidental prose mentions (e.g. "to finish, emit kortix_autowork_complete")
		// won't trip it. The engine parses the actual XML tag, not a string mention.
		const state = makeState()
		const decision = evaluateAutowork(state, [
			"Quick reminder: the completion contract is a kortix_autowork_complete tag with verification + requirements_check children. I'll emit it when the work is done.",
		])
		expect(decision.action).toBe("continue")
	})

	test("takes the LAST completion tag if there are multiple", () => {
		// The worker may paste an earlier rejection example. Only the most recent
		// well-formed tag counts.
		const state = makeState()
		const earlier = `
<${COMPLETION_TAG}>
  <verification></verification>
  <requirements_check>
    - [ ] "build the signup flow" — not done
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
		const text = `${earlier}\n\nNow the real one:\n\n${validCompletionBlock()}`
		const decision = evaluateAutowork(state, [text])
		expect(decision.action).toBe("stop")
		expect(decision.stopReason).toBe("complete")
	})

	test("stops with failed reason when max iterations reached", () => {
		const state = makeState({ iteration: 50, maxIterations: 50 })
		const decision = evaluateAutowork(state, ["Still working"])
		expect(decision.action).toBe("stop")
		expect(decision.stopReason).toBe("failed")
		expect(decision.reason).toContain("max iterations")
	})
})
