// The ticks of the hourly billing sweeps. workers/billing-rotation-worker.ts
// schedules them.

/** Trials and contracts: expire, end, and send the warnings that are due. */
export async function runTrialExpirySweep(): Promise<void> {
  const { runAccessSweep } = await import('./services/access-notices');
  await runAccessSweep();
}

export async function runYearlyCreditRotation(): Promise<void> {
  const { processYearlyCreditRotation } = await import('./services/yearly-rotation');
  await processYearlyCreditRotation();
}

export async function runFreeTierCreditRotation(): Promise<void> {
  const { processFreeTierCreditRotation } = await import('./services/free-tier-rotation');
  await processFreeTierCreditRotation();
}

/** DPA section 7.3: email each open subprocessor notice to every paid account. */
export async function runSubprocessorNotices(): Promise<void> {
  const { runSubprocessorNoticeSweep } = await import('./services/subprocessor-notices');
  await runSubprocessorNoticeSweep();
}

/** Terms section 16: email an open Terms change to every paid account. */
export async function runTermsNotices(): Promise<void> {
  const { runTermsNoticeSweep } = await import('./services/terms-notices');
  await runTermsNoticeSweep();
}
