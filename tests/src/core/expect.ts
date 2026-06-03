/**
 * Dependency-free assertion layer. Every assertion records a structured
 * {kind, expected, actual, pass} into the active step (so the report shows WHY
 * it failed) and then throws on failure so the step/flow is marked failed.
 *
 * Negative assertions (expecting a 4xx) are ordinary assertions — not special.
 */
import { currentRecorder } from "./context";
import type { Assertion } from "./result";

export class AssertionError extends Error {
  constructor(
    message: string,
    public assertion: Assertion,
  ) {
    super(message);
    this.name = "AssertionError";
  }
}

/** Record an assertion and throw if it failed. */
export function assert(a: Assertion): void {
  currentRecorder()?.pushAssertion(a);
  if (!a.pass) {
    throw new AssertionError(
      `${a.description} — expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)}`,
      a,
    );
  }
}

/**
 * jsonpath-lite: supports `$.a.b`, `a.b[0].c`, leading `$.` optional.
 * Returns undefined for any missing segment.
 */
export function jsonpath(obj: unknown, path: string): unknown {
  const clean = path.replace(/^\$\.?/, "");
  if (clean === "") return obj;
  const segments = clean.match(/[^.[\]]+/g) ?? [];
  let cur: any = obj;
  for (const seg of segments) {
    if (cur == null) return undefined;
    const idx = /^\d+$/.test(seg) ? Number(seg) : seg;
    cur = cur[idx as any];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

/** Minimal schema interface so we don't hard-depend on zod here. */
export interface Validator<T = unknown> {
  safeParse(input: unknown): { success: boolean; error?: unknown; data?: T };
}

export class BodyAssert {
  constructor(private body: unknown) {}

  has(path: string, expected: unknown): this {
    const actual = jsonpath(this.body, path);
    assert({
      kind: "body.has",
      description: `body ${path} === ${JSON.stringify(expected)}`,
      expected,
      actual,
      pass: deepEqual(actual, expected),
    });
    return this;
  }

  exists(path: string): this {
    const actual = jsonpath(this.body, path);
    assert({
      kind: "body.exists",
      description: `body ${path} exists`,
      expected: "<defined>",
      actual,
      pass: actual !== undefined && actual !== null,
    });
    return this;
  }

  matches(path: string, re: RegExp): this {
    const actual = jsonpath(this.body, path);
    assert({
      kind: "body.matches",
      description: `body ${path} matches ${re}`,
      expected: re.toString(),
      actual,
      pass: typeof actual === "string" && re.test(actual),
    });
    return this;
  }

  schema(validator: Validator, path = "$"): this {
    const target = jsonpath(this.body, path);
    const result = validator.safeParse(target);
    assert({
      kind: "body.schema",
      description: `body ${path} matches schema`,
      expected: "<valid schema>",
      actual: result.success ? "<valid>" : result.error,
      pass: result.success,
    });
    return this;
  }
}
