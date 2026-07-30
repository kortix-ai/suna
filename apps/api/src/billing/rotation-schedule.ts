interface BillingRotationConfig {
  KORTIX_BILLING_INTERNAL_ENABLED: boolean;
  KORTIX_WORKERS_ENABLED: boolean;
}

export function billingRotationIntervalsEnabled(config: BillingRotationConfig): boolean {
  return config.KORTIX_BILLING_INTERNAL_ENABLED && config.KORTIX_WORKERS_ENABLED;
}
