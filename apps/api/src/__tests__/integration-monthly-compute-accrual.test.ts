/**
 * CHARACTERIZATION: the monthly unbilled-compute accrual, for BOTH readers.
 *
 * `monitorMonthlyComputeCost` (projects/lib/monitor-box.ts) and
 * `appMonthlyComputeCost` (apps/budget.ts) hand-encode the same select list
 * and the same accrual loop — monitor-box's doc comment admits the mirror.
 * The dedupe keeps one copy. These pins hold the observable contract of both
 * functions against a real database: recorded cost sums, an open window
 * accrues the seconds since its last bill, a closed row contributes its
 * recorded cost only, a zero-cost open row contributes nothing, and a row
 * that started last month sits outside the month bucket.
 *
 * Real: the compute-session rows and both joins. Faked: only the cost
 * function — 1 USD per unbilled second, so the accrual is directly readable
 * in the total.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  accounts,
  appArtifacts,
  appDeployments,
  apps,
  appRuntimes,
  projectMonitorBoxes,
  projects,
  sandboxComputeSessions,
} from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import * as realMetering from '../billing/services/compute-metering';
import { seedAccount } from './helpers/integration-fixtures';

import { db } from '../shared/db';

const unbilledSeconds: number[] = [];
mock.module('../billing/services/compute-metering', () => ({
  ...realMetering,
  calculateComputeCost: (_spec: unknown, seconds: number) => {
    unbilledSeconds.push(seconds);
    return seconds;
  },
}));

const { monitorMonthlyComputeCost } = await import('../projects/lib/monitor-box');
const { appMonthlyComputeCost } = await import('../apps/budget');
const NOW = new Date('2026-09-15T12:00:00.000Z');
/** One of this month's sessions, in the per-spec shape the meter bills. */
const SPEC = { cpuCores: 1, memoryGb: 2, diskGb: 10, gpuCount: 0 };

let accountId: string;
let projectId: string;
let otherProjectId: string;
let appId: string;
const sandboxIds: string[] = [];

/** One monitor box + its compute session. `boxId` IS the session's sandbox id. */
async function monitorRow(
  projectId: string,
  over: {
    costUsd: string;
    startedAt: string;
    endedAt?: string | null;
    lastBilledAt?: string;
  },
): Promise<void> {
  const boxId = crypto.randomUUID();
  sandboxIds.push(boxId);
  await db.insert(projectMonitorBoxes).values({
    boxId,
    projectId,
    accountId,
    provider: 'daytona',
    boxEpoch: 'epoch-1',
    // Only one live box per project is allowed; every extra row is stopped.
    status: 'stopped',
  });
  await db.insert(sandboxComputeSessions).values({
    accountId,
    sandboxId: boxId,
    workloadType: 'monitor',
    provider: 'daytona',
    cpuCores: SPEC.cpuCores,
    memoryGb: SPEC.memoryGb,
    diskGb: SPEC.diskGb,
    startedAt: over.startedAt,
    endedAt: over.endedAt ?? null,
    lastBilledAt: over.lastBilledAt ?? NOW.toISOString(),
    costUsd: over.costUsd,
  });
}

beforeAll(async () => {
  accountId = await seedAccount('accrual');
  projectId = crypto.randomUUID();
  otherProjectId = crypto.randomUUID();
  await db.insert(projects).values([
    { projectId, accountId, name: 'accrual-monitor', repoUrl: 'https://example.test/accrual-monitor.git' },
    { projectId: otherProjectId, accountId, name: 'accrual-other', repoUrl: 'https://example.test/accrual-other.git' },
  ]);

  await monitorRow(projectId, {
    costUsd: '2.500000',
    startedAt: '2026-09-10T00:00:00.000Z',
    lastBilledAt: '2026-09-15T11:00:00.000Z', // open: 3600 unbilled seconds
  });
  await monitorRow(projectId, {
    costUsd: '1.250000',
    startedAt: '2026-09-11T00:00:00.000Z',
    endedAt: '2026-09-12T00:00:00.000Z', // closed: recorded cost only
  });
  await monitorRow(projectId, {
    costUsd: '0',
    startedAt: '2026-09-14T00:00:00.000Z', // open, nothing unbilled
    lastBilledAt: NOW.toISOString(),
  });
  await monitorRow(otherProjectId, {
    costUsd: '7.000000',
    startedAt: '2026-09-12T00:00:00.000Z',
  });
  // A row from before this month's bucket never counts, open or not.
  await monitorRow(projectId, {
    costUsd: '9.000000',
    startedAt: '2026-08-20T00:00:00.000Z',
  });

  const routeKey = `ac${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const [app] = await db
    .insert(apps)
    .values({ accountId, projectId, name: 'accrual-app', slug: routeKey, routeKey })
    .returning({ appId: apps.appId });
  appId = app!.appId;
  const [artifact] = await db
    .insert(appArtifacts)
    .values({ accountId, projectId, kind: 'archive', status: 'ready' })
    .returning({ artifactId: appArtifacts.artifactId });
  const [deployment] = await db
    .insert(appDeployments)
    .values({
      appId,
      artifactId: artifact!.artifactId,
      version: 1,
      status: 'ready',
      sourceKind: 'dockerfile',
      runtimeVersion: 'v1',
      createdBy: accountId,
    })
    .returning({ deploymentId: appDeployments.deploymentId });
  const [runtime] = await db
    .insert(appRuntimes)
    .values({
      deploymentId: deployment!.deploymentId,
      accountId,
      provider: 'daytona',
      externalId: 'sbx-accrual',
      status: 'running',
      controlTokenHash: 'hash',
    })
    .returning({ runtimeId: appRuntimes.runtimeId });

  const appRow = {
    accountId,
    sandboxId: crypto.randomUUID(),
    appRuntimeId: runtime!.runtimeId,
    workloadType: 'app' as const,
    provider: 'daytona' as const,
    cpuCores: SPEC.cpuCores,
    memoryGb: SPEC.memoryGb,
    diskGb: SPEC.diskGb,
  };
  sandboxIds.push(appRow.sandboxId);
  await db.insert(sandboxComputeSessions).values({
    ...appRow,
    startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: null,
    lastBilledAt: '2026-09-15T11:30:00.000Z', // open: 1800 unbilled seconds
    costUsd: '3.000000',
  });
  const closedApp = { ...appRow, sandboxId: crypto.randomUUID() };
  sandboxIds.push(closedApp.sandboxId);
  await db.insert(sandboxComputeSessions).values({
    ...closedApp,
    startedAt: '2026-09-11T00:00:00.000Z',
    endedAt: '2026-09-12T00:00:00.000Z',
    costUsd: '0.750000',
  });
});

afterAll(async () => {
  await db.delete(sandboxComputeSessions).where(inArray(sandboxComputeSessions.sandboxId, sandboxIds));
  await db.delete(appRuntimes).where(eq(appRuntimes.accountId, accountId));
  await db.delete(appDeployments).where(eq(appDeployments.appId, appId));
  await db.delete(appArtifacts).where(eq(appArtifacts.accountId, accountId));
  await db.delete(apps).where(eq(apps.appId, appId));
  await db.delete(projectMonitorBoxes).where(inArray(projectMonitorBoxes.projectId, [projectId, otherProjectId]));
  await db.delete(projects).where(inArray(projects.projectId, [projectId, otherProjectId]));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('the monthly unbilled-compute accrual', () => {
  test('monitorMonthlyComputeCost: recorded cost + open-window accrual, this month only', async () => {
    unbilledSeconds.length = 0;
    expect(await monitorMonthlyComputeCost(projectId, NOW)).toBe(3603.75);
    // The two open in-month rows accrued their unbilled seconds: 3600 for the
    // billed-an-hour-ago box, 0 for the just-billed zero-cost row. The closed
    // and prior-month rows never reach the meter.
    expect([...unbilledSeconds].sort((a, b) => a - b)).toEqual([0, 3600]);
  });

  test('appMonthlyComputeCost: same accrual over the app join', async () => {
    unbilledSeconds.length = 0;
    expect(await appMonthlyComputeCost(appId, NOW)).toBe(1803.75);
    // The closed row contributes its recorded cost only: one accrual call.
    expect(unbilledSeconds).toEqual([1800]);
  });

  test('each scope reads only its own rows', async () => {
    expect(await monitorMonthlyComputeCost(otherProjectId, NOW)).toBe(7);
  });
});
