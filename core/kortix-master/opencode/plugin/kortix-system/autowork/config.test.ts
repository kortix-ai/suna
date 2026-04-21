import { describe, expect, test } from "bun:test"
import {
	COMPLETION_TAG,
	PLAN_TAG,
	VERIFIED_TAG,
	extractVerificationCommands,
	normalizeShellCommand,
	parseAutoworkArgs,
	parseCompletionTag,
	parsePlanTag,
	parseVerifiedTag,
	planCommandGates,
	planObserveGates,
	renderApprovedPlan,
	validateCompletion,
	validatePlan,
	validateVerified,
} from "./config"

describe("parseAutoworkArgs", () => {
	test("parses --max-iterations", () => {
		const parsed = parseAutoworkArgs(`--max-iterations 12 ship the feature`)
		expect(parsed.options.maxIterations).toBe(12)
		expect(parsed.task).toBe("ship the feature")
	})

	test("silently drops legacy --completion-promise flag", () => {
		// Spawned task workers still pass `--completion-promise TASK_COMPLETE`
		// until task-service is updated. Accept + ignore so nothing breaks.
		const parsed = parseAutoworkArgs(`--completion-promise TASK_COMPLETE --max-iterations 10 build it`)
		expect(parsed.options.maxIterations).toBe(10)
		expect(parsed.task).toBe("build it")
	})

	test("silently drops legacy --verification flag", () => {
		const parsed = parseAutoworkArgs(`--verification "bun test passes" build feature`)
		expect(parsed.task).toBe("build feature")
	})

	test("falls back to defaults when no flags", () => {
		const parsed = parseAutoworkArgs("ship the feature")
		expect(parsed.options.maxIterations).toBe(50)
		expect(parsed.task).toBe("ship the feature")
	})
})

describe("parseCompletionTag", () => {
	test("returns null when tag is absent", () => {
		expect(parseCompletionTag("some prose without the tag")).toBeNull()
		expect(parseCompletionTag("")).toBeNull()
	})

	test("parses a well-formed tag", () => {
		const text = `
Here is my completion:

<${COMPLETION_TAG}>
  <verification>
    ran bun test — exit 0, 4 passed
  </verification>
  <requirements_check>
    - [x] "ship the feature" — deployed to dev, smoke test passes
    - [x] "write unit tests" — 4 new tests in tests/feature.test.ts
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
		const parsed = parseCompletionTag(text)
		expect(parsed).not.toBeNull()
		expect(parsed!.verification).toContain("bun test")
		expect(parsed!.requirementItems.length).toBe(2)
		expect(parsed!.requirementItems.every((item) => item.checked)).toBe(true)
	})

	test("flags unchecked items", () => {
		const text = `
<${COMPLETION_TAG}>
  <verification>tests pass</verification>
  <requirements_check>
    - [x] "ship the feature" — deployed
    - [ ] "write docs" — not done
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
		const parsed = parseCompletionTag(text)
		expect(parsed).not.toBeNull()
		expect(parsed!.requirementItems.length).toBe(2)
		expect(parsed!.requirementItems[0]?.checked).toBe(true)
		expect(parsed!.requirementItems[1]?.checked).toBe(false)
	})

	test("returns parsed (with empty verification) when <verification> child is missing so validator can reject with reason", () => {
		const text = `
<${COMPLETION_TAG}>
  <requirements_check>
    - [x] "done"
  </requirements_check>
</${COMPLETION_TAG}>
`.trim()
		const parsed = parseCompletionTag(text)
		expect(parsed).not.toBeNull()
		expect(parsed!.verification).toBe("")
		expect(validateCompletion(parsed!).ok).toBe(false)
	})

	test("returns parsed (with empty requirements_check) when child is missing so validator can reject with reason", () => {
		const text = `
<${COMPLETION_TAG}>
  <verification>tests pass</verification>
</${COMPLETION_TAG}>
`.trim()
		const parsed = parseCompletionTag(text)
		expect(parsed).not.toBeNull()
		expect(parsed!.requirementsCheck).toBe("")
		expect(parsed!.requirementItems.length).toBe(0)
		expect(validateCompletion(parsed!).ok).toBe(false)
	})

	test("picks the LAST tag if multiple are present", () => {
		const text = `
<${COMPLETION_TAG}>
  <verification></verification>
  <requirements_check>- [ ] "first draft"</requirements_check>
</${COMPLETION_TAG}>

Later after fixing:

<${COMPLETION_TAG}>
  <verification>all tests green</verification>
  <requirements_check>- [x] "first draft" — done</requirements_check>
</${COMPLETION_TAG}>
`.trim()
		const parsed = parseCompletionTag(text)
		expect(parsed).not.toBeNull()
		expect(parsed!.verification).toContain("all tests green")
		expect(parsed!.requirementItems[0]?.checked).toBe(true)
	})
})

describe("parsePlanTag", () => {
	test("returns null when plan tag is absent", () => {
		expect(parsePlanTag("no plan here")).toBeNull()
	})

	test("parses a well-formed plan", () => {
		const text = `
<${PLAN_TAG}>
  <status_quo>Current bug exists.</status_quo>
  <target_end_state>Bug is fixed.</target_end_state>
  <end_state_checklist>
    - [x] "bug no longer reproduces" — required done state
    - [x] "tests prove the fix" — required done state
  </end_state_checklist>
  <ambiguity_check>
    - [x] "no blocking ambiguity remains" — clarified by prompt
  </ambiguity_check>
  <work_plan>
    - [ ] inspect code
    - [ ] implement fix
  </work_plan>
  <verification_gates>
    - command: bun test tests/auth.test.ts
  </verification_gates>
</${PLAN_TAG}>
`.trim()
		const parsed = parsePlanTag(text)
		expect(parsed).not.toBeNull()
		expect(parsed!.statusQuo).toContain("Current bug")
		expect(parsed!.endStateItems.length).toBe(2)
		expect(parsed!.ambiguityItems[0]?.checked).toBe(true)
		expect(parsed!.workPlanItems.length).toBe(2)
		expect(planCommandGates(parsed!)).toEqual(["bun test tests/auth.test.ts"])
	})
})

describe("parseVerifiedTag", () => {
	test("returns null when verifier tag is absent", () => {
		expect(parseVerifiedTag("no verifier here")).toBeNull()
	})

	test("parses a well-formed verifier tag", () => {
		const text = `
<${VERIFIED_TAG}>
  <verification_rerun>
    $ bun test tests/auth.test.ts
    [exit 0] 12 passed
  </verification_rerun>
  <final_check>
    - [x] "approved plan fully satisfied" — yes
    - [x] "completion claim re-audited" — yes
  </final_check>
</${VERIFIED_TAG}>
`.trim()
		const parsed = parseVerifiedTag(text)
		expect(parsed).not.toBeNull()
		expect(parsed!.verificationRerun).toContain("bun test")
		expect(parsed!.finalCheckItems.length).toBe(2)
	})
})

describe("validateCompletion", () => {
	test("ok on fully checked, non-empty contract", () => {
		const result = validateCompletion({
			verification: "ran bun test, exit 0",
			requirementsCheck: "- [x] done",
			requirementItems: [{ checked: true, text: '"ship it" — deployed' }],
		})
		expect(result.ok).toBe(true)
	})

	test("rejects empty verification", () => {
		const result = validateCompletion({
			verification: "",
			requirementsCheck: "- [x] done",
			requirementItems: [{ checked: true, text: '"ship it"' }],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("verification")
	})

	test("rejects when no requirement items parsed", () => {
		const result = validateCompletion({
			verification: "ran tests",
			requirementsCheck: "no checklist here, just prose",
			requirementItems: [],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("no checklist items")
	})

	test("rejects when any item is unchecked", () => {
		const result = validateCompletion({
			verification: "tests pass",
			requirementsCheck: "...",
			requirementItems: [
				{ checked: true, text: '"first" — done' },
				{ checked: false, text: '"second" — pending' },
			],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("unchecked")
	})
})

describe("validatePlan", () => {
	test("ok on fully specified planning contract", () => {
		const result = validatePlan({
			statusQuo: "Current auth flow is inconsistent.",
			targetEndState: "Auth flow is deterministic and verified.",
			endStateChecklist: '- [x] "auth returns 200" — required done state',
			endStateItems: [{ checked: true, text: '"auth returns 200" — required done state' }],
			ambiguityCheck: '- [x] "no blocking ambiguity remains" — clarified by prompt',
			ambiguityItems: [{ checked: true, text: '"no blocking ambiguity remains" — clarified by prompt' }],
			workPlan: "- [ ] inspect\n- [ ] implement",
			workPlanItems: [
				{ checked: false, text: "inspect" },
				{ checked: false, text: "implement" },
			],
			verificationGates: "- command: bun test tests/auth.test.ts\n- observe: auth returns 200",
			verificationGateItems: [
				{ kind: "command", value: "bun test tests/auth.test.ts" },
				{ kind: "observe", value: "auth returns 200" },
			],
		})
		expect(result.ok).toBe(true)
	})

	test("rejects unresolved ambiguity items", () => {
		const result = validatePlan({
			statusQuo: "Current auth flow is inconsistent.",
			targetEndState: "Auth flow is deterministic and verified.",
			endStateChecklist: '- [x] "auth returns 200" — required done state',
			endStateItems: [{ checked: true, text: '"auth returns 200" — required done state' }],
			ambiguityCheck: '- [ ] "unknown behavior" — unresolved',
			ambiguityItems: [{ checked: false, text: '"unknown behavior" — unresolved' }],
			workPlan: "- [ ] inspect",
			workPlanItems: [{ checked: false, text: "inspect" }],
			verificationGates: "- command: bun test tests/auth.test.ts",
			verificationGateItems: [{ kind: "command", value: "bun test tests/auth.test.ts" }],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("unresolved ambiguity")
	})

	test("rejects plans without explicit end-state checklist", () => {
		const result = validatePlan({
			statusQuo: "Current auth flow is inconsistent.",
			targetEndState: "Auth flow is deterministic and verified.",
			endStateChecklist: "",
			endStateItems: [],
			ambiguityCheck: '- [x] "no blocking ambiguity remains" — clarified by prompt',
			ambiguityItems: [{ checked: true, text: '"no blocking ambiguity remains" — clarified by prompt' }],
			workPlan: "- [ ] inspect",
			workPlanItems: [{ checked: false, text: "inspect" }],
			verificationGates: "- command: bun test tests/auth.test.ts",
			verificationGateItems: [{ kind: "command", value: "bun test tests/auth.test.ts" }],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("end_state_checklist")
	})

	test("renders approved plans as canonical plan tags", () => {
		const rendered = renderApprovedPlan({
			statusQuo: "Current auth flow is inconsistent.",
			targetEndState: "Auth flow is deterministic and verified.",
			endStateChecklist: '- [x] "auth returns 200" — required done state',
			endStateItems: [{ checked: true, text: '"auth returns 200" — required done state' }],
			ambiguityCheck: '- [x] "no blocking ambiguity remains" — clarified by prompt',
			ambiguityItems: [{ checked: true, text: '"no blocking ambiguity remains" — clarified by prompt' }],
			workPlan: "- [ ] inspect",
			workPlanItems: [{ checked: false, text: "inspect" }],
			verificationGates: "- command: bun test tests/auth.test.ts\n- observe: auth returns 200",
			verificationGateItems: [
				{ kind: "command", value: "bun test tests/auth.test.ts" },
				{ kind: "observe", value: "auth returns 200" },
			],
		})
		expect(rendered).toContain(`<${PLAN_TAG}>`)
		expect(rendered).toContain("<end_state_checklist>")
		expect(rendered).toContain("<status_quo>")
		expect(rendered).toContain("<verification_gates>")
		expect(planObserveGates(parsePlanTag(rendered)!)).toEqual(["auth returns 200"])
	})
})

describe("validateVerified", () => {
	test("ok on fully specified verifier contract", () => {
		const result = validateVerified({
			verificationRerun: "$ bun test tests/auth.test.ts\n[exit 0] 12 passed",
			finalCheck: '- [x] "approved plan fully satisfied" — yes',
			finalCheckItems: [{ checked: true, text: '"approved plan fully satisfied" — yes' }],
		})
		expect(result.ok).toBe(true)
	})

	test("rejects unchecked verifier checklist items", () => {
		const result = validateVerified({
			verificationRerun: "$ bun test tests/auth.test.ts\n[exit 0] 12 passed",
			finalCheck: '- [ ] "completion claim re-audited" — not yet',
			finalCheckItems: [{ checked: false, text: '"completion claim re-audited" — not yet' }],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("unchecked final check")
	})
})

describe("verification command extraction", () => {
	test("normalizes shell commands consistently", () => {
		expect(normalizeShellCommand("  $   bun   test tests/auth.test.ts  ")).toBe("bun test tests/auth.test.ts")
	})

	test("extracts executable command lines from verification blocks", () => {
		const commands = extractVerificationCommands([
			"$ bun test tests/auth.test.ts",
			"[exit 0] 12 passed",
			"curl -I https://example.com",
			"201 ok",
		].join("\n"))
		expect(commands).toEqual([
			"bun test tests/auth.test.ts",
			"curl -I https://example.com",
		])
	})
})
