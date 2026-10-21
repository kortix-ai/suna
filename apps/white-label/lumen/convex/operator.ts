"use node";

// The operator credential and the retry rule every Kortix call shares.
// KORTIX_OPERATOR_TOKEN lives only in Convex env; Next.js and the browser never hold it.

import { makeDriveFolder } from "@kortix/sdk";
import { createScopedKortix, runWithKortix } from "@kortix/sdk/server";

export function operator() {
  const backendUrl = process.env.KORTIX_UPSTREAM;
  const token = process.env.KORTIX_OPERATOR_TOKEN;
  if (!backendUrl || !token) throw new Error("500: KORTIX_UPSTREAM / KORTIX_OPERATOR_TOKEN unset");
  const config = { backendUrl, getToken: async () => token };
  return { config, kortix: createScopedKortix(config) };
}

/** Run module-level SDK calls (Drive, agent config) as the operator. */
export function asOperator<T>(fn: () => Promise<T>): Promise<T> {
  return runWithKortix(operator().config, fn);
}

/**
 * Optional sandbox provider for sessions Lumen starts (`KORTIX_SANDBOX_PROVIDER`,
 * e.g. "platinum"). Unset: the Kortix project's default.
 */
export function sandboxProvider(): { provider?: "platinum" | "daytona" } {
  const p = process.env.KORTIX_SANDBOX_PROVIDER;
  return p === "platinum" || p === "daytona" ? { provider: p } : {};
}

const statusOf = (err: unknown) => (err as { status?: number })?.status;

/** Retry network errors and 5xx 3 times (1 s, 4 s, 15 s). A 4xx is the caller's to handle: never retried. */
export async function withRetry<T>(fn: () => Promise<T>, delays = [1000, 4000, 15000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      if ((status !== undefined && status < 500) || attempt >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

/**
 * mkdir with the shared retry. "Already exists" (409) is done, so re-runs are no-ops.
 * A transient 5xx (e.g. Drive 503) is retried, never surfaced as a failed upload.
 */
export async function ensureFolder(driveId: string, path: string): Promise<void> {
  try {
    await withRetry(() => makeDriveFolder(driveId, path));
  } catch (err) {
    if (statusOf(err) !== 409) throw err;
  }
}

/** The short, member-safe form of an upstream error (raw text goes to the Convex log only). */
export function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 500);
}
