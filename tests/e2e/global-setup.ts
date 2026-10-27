/**
 * Up-front capability assertion for the strict deployed browser lane.
 *
 * `local-runner.ts` sets `E2E_REQUIRE_ALL_BROWSER=1` for the deployed lane and
 * `strict-skip-reporter.ts` then fails the lane if ANY journey skipped. But 11
 * specs decide to skip at RUNTIME on environment availability — a missing
 * `KE2E_DATABASE_URL`, or a Resend key that answers 403. So a single
 * email-provider blip turned the whole lane red only after ~50 minutes of
 * running everything else first, and the failure named a skipped test rather
 * than the missing capability.
 *
 * This runs ONCE before any journey and fails in seconds with the exact list of
 * what is missing. The per-spec `test.skip(...)` guards stay: they are the
 * correct behaviour on local and other non-strict runs, where a missing optional
 * capability should degrade instead of fail. On the strict lane they are now
 * unreachable, because this setup fails first — which is what removes the old
 * contradiction between the strict reporter and the conditional skips.
 */
import { writeDeploymentBypassState } from './helpers/deployment-bypass';
import { emailProviderStatus } from './helpers/inbox';

interface Requirement {
  name: string;
  detail: string;
  ok: () => boolean | Promise<boolean>;
  reason?: () => string | Promise<string>;
}

export interface EmailProbeResult {
  available: boolean;
  reason: string;
}

export type EmailProbe = () => Promise<EmailProbeResult>;

export function strictBrowserLane(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.E2E_REQUIRE_ALL_BROWSER === '1';
}

export function browserLaneRequirements(
  env: NodeJS.ProcessEnv = process.env,
  // `emailProviderStatus` reads process.env and memoizes its live probe, so it
  // is injected rather than called through `env` — otherwise a caller passing a
  // synthetic env would silently get the real process's answer.
  probeEmail: EmailProbe = emailProviderStatus,
): Requirement[] {
  const present = (value: string | undefined): boolean => Boolean(value?.trim());
  const requirements: Requirement[] = [
    {
      // 49-connector-connect-landing `test.skip(!databaseUrl, ...)`; 27, 34,
      // 37 and 45 throw without it.
      name: 'KE2E_DATABASE_URL',
      detail: 'direct database access; 49 skips and 27, 34, 37, 45 fail without it',
      ok: () => present(env.KE2E_DATABASE_URL) || present(env.E2E_DATABASE_URL),
    },
    {
      // 01-account-auth skips on a live probe, so this must PROBE, not just
      // check that a key is set.
      name: 'email provider',
      detail: 'inbox delivery; 01 skips without it',
      ok: async () => (await probeEmail()).available,
      reason: async () => (await probeEmail()).reason,
    },
    {
      name: 'E2E_ENABLE_BILLING_JOURNEY=1',
      detail: '10-billing-journey skips without it',
      ok: () => env.E2E_ENABLE_BILLING_JOURNEY === '1',
    },
  ];
  return requirements;
}

export async function assertBrowserLaneCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  probeEmail: EmailProbe = emailProviderStatus,
): Promise<void> {
  if (!strictBrowserLane(env)) return;
  const missing: string[] = [];
  for (const requirement of browserLaneRequirements(env, probeEmail)) {
    if (await requirement.ok()) continue;
    const reason = requirement.reason ? ` (${await requirement.reason()})` : '';
    missing.push(`- ${requirement.name}: ${requirement.detail}${reason}`);
  }
  if (missing.length === 0) return;
  throw new Error(
    `The strict deployed browser lane (E2E_REQUIRE_ALL_BROWSER=1) requires every journey to run, ` +
      `but ${missing.length} capability/capabilities are unavailable:\n${missing.join('\n')}\n` +
      `Fix the environment, or run without E2E_REQUIRE_ALL_BROWSER=1 to allow conditional skips.`,
  );
}

export default async function globalSetup(): Promise<void> {
  await assertBrowserLaneCapabilities();
  // Exchange the bypass secret for the deployment cookie ONCE, against the
  // deployment origin only. `playwright.config.ts` points `use.storageState` at
  // the file this writes. No secret (local, unprotected target) means no file
  // and no `storageState`.
  await writeDeploymentBypassState(process.env.E2E_BASE_URL || 'http://localhost:3000');
}
