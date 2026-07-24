import {
  CREDITS_PER_USD,
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
} from '@/features/billing/compute-pricing';

export function ComputeCreditCalculator() {
  return (
    <div className="bg-card rounded-md border px-5 py-6 sm:px-6">
      <div
        className="grid gap-4 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center sm:gap-5"
        role="group"
        aria-label="1 Team seat equals 2,500 pooled credits equals 125 Agent Computer hours per month."
      >
        <div>
          <div className="text-foreground text-3xl font-medium tracking-tight tabular-nums">1</div>
          <div className="text-muted-foreground mt-1 text-xs leading-relaxed">Team seat</div>
        </div>

        <div className="text-muted-foreground text-xl" aria-hidden="true">
          =
        </div>

        <div>
          <div className="text-foreground text-3xl font-medium tracking-tight tabular-nums">
            2,500
          </div>
          <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
            pooled credits / month
          </div>
        </div>

        <div className="text-muted-foreground text-xl" aria-hidden="true">
          =
        </div>

        <div>
          <div className="text-foreground flex items-baseline text-3xl font-medium tracking-tight tabular-nums">
            <span>125</span>
            <span className="ml-1" aria-label="hours">
              h
            </span>
          </div>
          <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
            Agent Computer hours / month
          </div>
        </div>
      </div>

      <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-xs leading-relaxed">
        Compute is billed by the second. The default Agent Computer has 2 vCPU, 4 GiB RAM, and 20
        GiB storage. It uses about{' '}
        <span className="text-foreground font-medium tabular-nums">
          {`${(DEFAULT_COMPUTE_HOURLY_PRICE_USD * CREDITS_PER_USD).toFixed(0)} credits ($${DEFAULT_COMPUTE_HOURLY_PRICE_USD.toFixed(2)}) per hour`}
        </span>
        . Auto-stop pauses compute charges, so stopped time uses 0 credits. Optional managed model
        usage is token-based and uses the same pooled Team credits.
      </p>
    </div>
  );
}
