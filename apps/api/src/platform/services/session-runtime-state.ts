/**
 * The complete worker x environment lifecycle contract.
 *
 * The worker owns the model loop, transcript, wake fence and turn ledger. The
 * environment is auxiliary compute. Environment activity therefore never
 * creates turn authority and never keeps a parked worker alive.
 */
export type WorkerRuntimeState = 'missing' | 'live' | 'parked';
export type EnvironmentRuntimeState = 'missing' | 'provisioning' | 'active' | 'stopped' | 'error';
export type EnvironmentRuntimeAction = 'none' | 'wait' | 'serve' | 'ensure' | 'stop' | 'delete';

export interface SessionRuntimePairDecision {
  legal: boolean;
  environmentAction: EnvironmentRuntimeAction;
  turnAuthority: 'worker' | 'none';
}

export function decideSessionRuntimePair(
  worker: WorkerRuntimeState,
  environment: EnvironmentRuntimeState,
): SessionRuntimePairDecision {
  if (worker === 'missing') {
    return environment === 'missing'
      ? { legal: true, environmentAction: 'none', turnAuthority: 'none' }
      : { legal: false, environmentAction: 'delete', turnAuthority: 'none' };
  }

  if (worker === 'parked') {
    return environment === 'active' || environment === 'provisioning'
      ? { legal: false, environmentAction: 'stop', turnAuthority: 'none' }
      : { legal: true, environmentAction: 'none', turnAuthority: 'none' };
  }

  switch (environment) {
    case 'missing':
    case 'stopped':
    case 'error':
      return { legal: true, environmentAction: 'ensure', turnAuthority: 'worker' };
    case 'provisioning':
      return { legal: true, environmentAction: 'wait', turnAuthority: 'worker' };
    case 'active':
      return { legal: true, environmentAction: 'serve', turnAuthority: 'worker' };
  }
}
