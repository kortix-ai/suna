import { availableParallelism } from "node:os";
import type { RegisteredFlow } from "./flow";
import type { Capability } from "./types";

export const EXTERNAL_CAPABILITIES = new Set<Capability>([
  "daytona",
  "managedGit",
  "managedGitPush",
  "stripe",
  "funded",
]);
export const LOCAL_FLOW_INTERNAL_SERVICE_KEY = "local-flow-runner-internal-service-key";

export interface LocalWorktreeConfig {
  ports: {
    web: number;
    api: number;
    gateway: number;
  };
}

export interface LocalSupabaseEnvironment {
  API_URL?: string;
  DB_URL?: string;
  MAILPIT_URL?: string;
  ANON_KEY?: string;
  SERVICE_ROLE_KEY?: string;
  JWT_SECRET?: string;
}

export interface LocalProfileInput {
  worktree?: LocalWorktreeConfig | null;
  supabase: LocalSupabaseEnvironment;
}

export interface LocalFlowExclusion {
  id: string;
  reason: string;
}

export function localWebUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function localEnvironmentOverrides(input: LocalProfileInput): Record<string, string> {
  const { worktree, supabase } = input;
  const apiPort = worktree?.ports.api ?? 8008;
  const webPort = worktree?.ports.web ?? 3000;
  const gatewayPort = worktree?.ports.gateway ?? 8090;

  if (!supabase.API_URL || !supabase.DB_URL || !supabase.ANON_KEY || !supabase.SERVICE_ROLE_KEY) {
    throw new Error("local Supabase is unavailable or incomplete; start the local stack and retry");
  }

  return {
    KE2E_TARGET: "local",
    KE2E_API_URL: `http://127.0.0.1:${apiPort}/v1`,
    KE2E_BASE_URL: localWebUrl(webPort),
    KE2E_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    KE2E_SUPABASE_URL: supabase.API_URL,
    KE2E_DATABASE_URL: supabase.DB_URL,
    KE2E_SUPABASE_ANON_KEY: supabase.ANON_KEY,
    KE2E_SUPABASE_SERVICE_ROLE_KEY: supabase.SERVICE_ROLE_KEY,
    KE2E_INTERNAL_SERVICE_KEY: LOCAL_FLOW_INTERNAL_SERVICE_KEY,
    KE2E_LIVE_CONFIRM: "local",
    KE2E_LOCAL_BILLING_ENABLED: "1",
    KE2E_CAP_DAYTONA: "0",
    KE2E_CAP_MANAGED_GIT: "0",
    KE2E_CAP_MANAGED_GIT_PUSH: "0",
    KE2E_CAP_FUNDED: "0",
    KE2E_DEFAULT_FLOW_ATTEMPTS: "1",
    KE2E_API_WORKERS: String(localWorkerCount()),
    KE2E_SANDBOX_WORKERS: "1",
    KE2E_TEARDOWN_WORKERS: String(Math.min(8, localWorkerCount())),
  };
}

export function planLocalFlows(flows: RegisteredFlow[]): {
  runnable: RegisteredFlow[];
  excluded: LocalFlowExclusion[];
} {
  const runnable: RegisteredFlow[] = [];
  const excluded: LocalFlowExclusion[] = [];

  for (const candidate of flows) {
    const external = (candidate.meta.requires ?? []).filter((capability) => EXTERNAL_CAPABILITIES.has(capability));
    if (external.length) {
      excluded.push({
        id: candidate.id,
        reason: `external capabilities: ${external.join(", ")}`,
      });
      continue;
    }
    if (candidate.meta.todo) {
      excluded.push({
        id: candidate.id,
        reason: `todo: ${candidate.meta.todo}`,
      });
      continue;
    }
    runnable.push(candidate);
  }

  return { runnable, excluded };
}

export function localRunExitCode(summary: { failed: number; skipped: number; todo: number }): 0 | 1 {
  return summary.failed === 0 && summary.skipped === 0 && summary.todo === 0 ? 0 : 1;
}

export function localWorkerCount(cpuCount = availableParallelism()): number {
  return Math.max(4, Math.min(16, Math.trunc(cpuCount)));
}
