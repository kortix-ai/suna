"use node";

// The two Kortix credentials and the retry rule every Kortix call shares.
// - The operator (KORTIX_OPERATOR_TOKEN, Convex env only): the project owner.
//   It configures the shared project (Drive, folder grants, agents, service
//   accounts) and writes firm files. It never creates or drives a session.
// - A firm's service account (its secret in firmCredentials): project role
//   `member`. It creates and drives that firm's sessions, which Kortix keeps
//   private to it, so no other firm's credential reaches them.

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

/** A firm's service-account client: every session call for that firm goes through it. */
export function firmClient(secret: string) {
  const backendUrl = process.env.KORTIX_UPSTREAM;
  if (!backendUrl) throw new Error("500: KORTIX_UPSTREAM unset");
  const config = { backendUrl, getToken: async () => secret };
  return { config, kortix: createScopedKortix(config) };
}

/** Run module-level SDK calls (sessions, turns) as the firm's service account. */
export function asFirm<T>(secret: string, fn: () => Promise<T>): Promise<T> {
  return runWithKortix(firmClient(secret).config, fn);
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
