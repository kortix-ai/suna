/**
 * Async-local recorder so the HTTP client can attribute every request +
 * assertion to the currently-running step without manual wiring.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Assertion, Captured } from "./result";

export interface StepRecorder {
  pushRequest(c: Captured): void;
  pushAssertion(a: Assertion): void;
  /** Route templates touched, for coverage aggregation. */
  routesHit: Set<string>;
}

const als = new AsyncLocalStorage<StepRecorder>();

export function withRecorder<T>(rec: StepRecorder, fn: () => Promise<T>): Promise<T> {
  return als.run(rec, fn);
}

export function currentRecorder(): StepRecorder | undefined {
  return als.getStore();
}
