/**
 * The runner: discover flows, build the world (principals + fixtures), schedule
 * across lanes (isolated-parallel / serial / global-serial), run each flow with
 * per-step capture, infra-only retry, timeout, and guaranteed teardown.
 */
import { Glob } from "bun";
import { resolve } from "node:path";
import { Client } from "./client";
import { withRecorder, type StepRecorder } from "./context";
import { AssertionError } from "./expect";
import { allFlows, clearRegistry, type RegisteredFlow } from "./flow";
import { loadEnv, type Env } from "./env";
import {
  summarize,
  type Assertion,
  type Captured,
  type FlowResult,
  type RunResult,
  type StepResult,
  type Status,
} from "./result";
import type { FlowContext } from "./types";
import { buildWorld, type World } from "../fixtures/world";

export interface RunOptions {
  ids?: string[];
  domains?: string[];
  tags?: string[];
  grep?: string;
  workers?: number;
  /** Read-mostly subset for prod smoke. */
  smoke?: boolean;
  runId: string;
  gitSha?: string | null;
}

const FLOWS_DIR = resolve(import.meta.dir, "../flows");

export async function discoverFlows(): Promise<void> {
  clearRegistry();
  const glob = new Glob("*.flow.ts");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: FLOWS_DIR, absolute: true })) files.push(f);
  files.sort();
  for (const f of files) await import(f);
}

function selected(f: RegisteredFlow, o: RunOptions): boolean {
  if (o.ids?.length && !o.ids.includes(f.id)) return false;
  if (o.domains?.length && !o.domains.includes(f.meta.domain)) return false;
  if (o.tags?.length && !(f.meta.tags ?? []).some((t) => o.tags!.includes(t))) return false;
  if (o.grep && !f.id.includes(o.grep) && !f.meta.domain.includes(o.grep)) return false;
  if (o.smoke && !(f.meta.tags ?? []).includes("smoke")) return false;
  return true;
}

class StepCollector implements StepRecorder {
  requests: Captured[] = [];
  assertions: Assertion[] = [];
  routesHit: Set<string>;
  constructor(shared: Set<string>) {
    this.routesHit = shared;
  }
  pushRequest(c: Captured) {
    this.requests.push(c);
  }
  pushAssertion(a: Assertion) {
    this.assertions.push(a);
  }
}

class SkipSignal extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

async function runOneFlow(
  f: RegisteredFlow,
  env: Env,
  world: World,
  routesHit: Set<string>,
): Promise<FlowResult> {
  const steps: StepResult[] = [];
  const flowStart = performance.now();
  const maxAttempts = f.meta.retry?.attempts ?? 1;

  // Capability gating → skip with reason.
  const missing = (f.meta.requires ?? []).filter((cap) => !env.capabilities[cap]);
  if (missing.length) {
    return mkResult(f, "skip", `missing capabilities: ${missing.join(", ")}`, [], performance.now() - flowStart, 0);
  }
  if (f.meta.todo) {
    return mkResult(f, "todo", f.meta.todo, [], performance.now() - flowStart, 0);
  }

  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    attempt++;
    steps.length = 0;
    const stack = world.newStack();
    const ctx: FlowContext = {
      client: new Client(env.apiUrl),
      P: world.principals,
      env,
      track: (kind, id, meta) => stack.push(kind, id, meta),
      skip: (reason) => {
        throw new SkipSignal(reason);
      },
      fixtures: world.makeFixtures(stack),
      step: async (name, fn) => {
        const collector = new StepCollector(routesHit);
        const start = performance.now();
        try {
          const out = await withRecorder(collector, fn);
          steps.push(stepResult(name, "pass", start, collector));
          return out;
        } catch (err) {
          steps.push(stepResult(name, "fail", start, collector, err));
          throw err;
        }
      },
    };

    try {
      await withTimeout(f.fn(ctx), f.meta.timeoutMs ?? 120_000, f.id);
      await stack.teardown();
      return mkResult(f, "pass", undefined, steps, performance.now() - flowStart, attempt);
    } catch (err) {
      await stack.teardown();
      if (err instanceof SkipSignal) {
        return mkResult(f, "skip", err.reason, steps, performance.now() - flowStart, attempt);
      }
      lastError = err;
      // Never retry assertion failures — only infra signals.
      const retryable = !(err instanceof AssertionError) && (err as any)?.ke2eRetryable === true;
      if (!retryable || attempt >= maxAttempts) break;
    }
  }
  const reason = (lastError as Error)?.message ?? String(lastError);
  return mkResult(f, "fail", reason, steps, performance.now() - flowStart, attempt);
}

function stepResult(
  name: string,
  status: Status,
  start: number,
  c: StepCollector,
  err?: unknown,
): StepResult {
  return {
    name,
    status,
    durationMs: performance.now() - start,
    requests: c.requests,
    assertions: c.assertions,
    error: err ? { message: (err as Error)?.message ?? String(err), stack: (err as Error)?.stack } : undefined,
  };
}

function mkResult(
  f: RegisteredFlow,
  status: Status,
  reason: string | undefined,
  steps: StepResult[],
  durationMs: number,
  attempts: number,
): FlowResult {
  return {
    id: f.id,
    domain: f.meta.domain,
    tags: f.meta.tags ?? [],
    status,
    reason,
    durationMs,
    attempts,
    steps: [...steps],
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, id: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => {
      const e = new Error(`flow ${id} exceeded ${ms}ms`);
      (e as any).ke2eRetryable = true;
      rej(e);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runSuite(opts: RunOptions): Promise<RunResult> {
  const env = loadEnv();
  await discoverFlows();
  const flows = allFlows().filter((f) => selected(f, opts));
  const routesHit = new Set<string>();
  const startedAt = new Date().toISOString();
  const start = performance.now();

  const world = await buildWorld(env, flows);

  try {
    const parallelLane = flows.filter((f) => !f.meta.serial && !f.meta.global);
    const serialLane = flows.filter((f) => f.meta.serial && !f.meta.global);
    const globalLane = flows.filter((f) => f.meta.global);

    const out: FlowResult[] = [];
    out.push(...(await pool(parallelLane, opts.workers ?? 4, (f) => runOneFlow(f, env, world, routesHit))));
    for (const f of serialLane) out.push(await runOneFlow(f, env, world, routesHit));
    for (const f of globalLane) out.push(await runOneFlow(f, env, world, routesHit));

    out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const durationMs = performance.now() - start;
    return {
      runId: opts.runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      apiUrl: env.apiUrl,
      target: env.target,
      gitSha: opts.gitSha ?? null,
      capabilities: env.capabilities as unknown as Record<string, boolean>,
      routesHit: [...routesHit].sort(),
      flows: out,
      summary: summarize(out, durationMs),
    };
  } finally {
    await world.teardownAll();
  }
}
