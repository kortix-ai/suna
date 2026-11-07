import { logger } from '../lib/logger';

// The ticks of the hourly billing sweeps. worker/jobs/billing-rotation.ts
// schedules them.

/** Trials and contracts: expire, end, and send the warnings that are due. */
export async function runTrialExpirySweep(): Promise<void> {
  const { runAccessSweep } = await import('./services/access-sweep');
  await runAccessSweep();
}

export async function runYearlyCreditRotation(): Promise<void> {
  const { processYearlyCreditRotation } = await import('./services/yearly-rotation');
  await processYearlyCreditRotation();
}

export async function runFreeTierCreditRotation(): Promise<void> {
  // Split-off comps that ended move to Free with free credits first
  // (design.md §3.2 C6). A failure here never stops the Free rotation.
  try {
    const { expireSplitOffComps } = await import('./services/split-off-billing');
    const comps = await expireSplitOffComps();
    if (comps.ended.length + comps.kept.length > 0) {
      logger.info('[billing-rotation] split-off comps ended', { toFree: comps.ended.length, keptOwnPlan: comps.kept.length });
    }
  } catch (err) {
    logger.error('[billing-rotation] split-off comp step failed', { error: (err as Error).message });
  }
  const { processFreeTierCreditRotation } = await import('./services/free-tier-rotation');
  await processFreeTierCreditRotation();
}

/** DPA section 7.3: email each open subprocessor notice to every paid account. */
export async function runSubprocessorNotices(): Promise<void> {
  const { runSubprocessorNoticeSweep } = await import('./services/subprocessor-notices');
  await runSubprocessorNoticeSweep();
}
