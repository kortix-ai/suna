// The ticks of the hourly billing sweeps. workers/billing-rotation-worker.ts
// schedules them.

export async function runTrialExpirySweep(): Promise<void> {
  const { sweepExpiredTrials, sweepTrialMonthlyGrants } = await import('./services/trial-admin');
  await sweepExpiredTrials();
  await sweepTrialMonthlyGrants();
}

export async function runYearlyCreditRotation(): Promise<void> {
  const { processYearlyCreditRotation } = await import('./services/yearly-rotation');
  await processYearlyCreditRotation();
}

export async function runFreeTierCreditRotation(): Promise<void> {
  const { processFreeTierCreditRotation } = await import('./services/free-tier-rotation');
  await processFreeTierCreditRotation();
}
