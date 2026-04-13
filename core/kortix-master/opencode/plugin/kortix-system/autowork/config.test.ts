import { describe, expect, test } from "bun:test"
import {
	COMPLETION_TAG,
	parseAutoworkArgs,
	parseCompletionTag,
	validateCompletion,
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
