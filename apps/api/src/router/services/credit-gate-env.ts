import { config } from '../../config';

/**
 * dev/preview QA exemption from the internal credit gate — the same policy
 * carve-out as `accountIsFreeTierForModels` (billing/services/tiers.ts): every
 * fresh dev/preview signup has a $0 credit account, so with billing internal
 * enabled (intentional on dev, to exercise Stripe test mode elsewhere) NO QA
 * account could ever use billed router tools (web_search 402'd with
 * "Insufficient credits" on every call). prod and staging keep the real gate —
 * staging is where the credit gate itself gets verified.
 *
 * Fail closed: the exemption needs the deploy to SET the variable. An unset
 * variable defaults to `dev` in config, and a prod task that lost the variable
 * (task-definition drift, new environment, rollback image) would otherwise
 * bill nothing, silently.
 *
 * `env` and `explicit` are parameters (defaulting to the deployed values)
 * purely so tests can exercise every branch without module-mocking config.
 */
export function creditGateExemptEnv(
  env: string = config.INTERNAL_KORTIX_ENV,
  explicit: boolean = config.INTERNAL_KORTIX_ENV_EXPLICIT,
): boolean {
  return explicit && (env === 'dev' || env === 'preview');
}
