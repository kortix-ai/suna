'use client';

import { Slider } from '@/components/ui/slider';
import {
  CREDITS_PER_USD,
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  TEAM_CREDITS_PER_SEAT,
} from '@/features/billing/compute-pricing';
import { useState, type ReactNode } from 'react';

/** Credits one default Agent Computer burns per hour — derived, never typed. */
const CREDITS_PER_HOUR = DEFAULT_COMPUTE_HOURLY_PRICE_USD * CREDITS_PER_USD;

/** The receipt quotes a month as 30 days and says so in the row label. */
const DAYS_PER_MONTH = 30;

const FMT = new Intl.NumberFormat('en-US');

function ControlRow({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: string;
  hint: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-foreground text-sm font-medium">{label}</span>
        <span className="text-foreground font-mono text-sm tabular-nums">{value}</span>
      </div>
      {children}
      <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>
    </div>
  );
}

function ReceiptRow({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-foreground font-mono text-xs tabular-nums">{value}</span>
    </div>
  );
}

/**
 * The pricing page's credits explainer, as a thing you can push on instead of
 * three paragraphs. Two sliders — seats, runtime — and a receipt that
 * recomputes live: pooled credits, what the chosen runtime draws, and whether
 * the pool covers it. Every number derives from `compute-pricing.ts`; the $40
 * seat price is deliberately absent (the plan card above owns it, and a second
 * typed-in copy of a billing number has drifted wrong here before).
 */
export function ComputeCreditCalculator(): ReactNode {
  const [seats, setSeats] = useState(3);
  const [hoursPerDay, setHoursPerDay] = useState(4);

  const pooledCredits = seats * TEAM_CREDITS_PER_SEAT;
  const poolHours = pooledCredits / CREDITS_PER_HOUR;
  const usedHours = hoursPerDay * DAYS_PER_MONTH;
  const usedCredits = usedHours * CREDITS_PER_HOUR;
  const remaining = pooledCredits - usedCredits;
  const covered = remaining >= 0;

  return (
    <div className="bg-card overflow-hidden rounded-md border">
      <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex flex-col gap-8 p-6 sm:p-8">
          <ControlRow
            label="Team seats"
            value={String(seats)}
            hint={`Each seat adds ${FMT.format(TEAM_CREDITS_PER_SEAT)} pooled credits a month. The whole team draws from one balance.`}
          >
            <Slider
              value={[seats]}
              onValueChange={([v]) => setSeats(v ?? 1)}
              min={1}
              max={20}
              step={1}
              thumbLabel="Team seats"
              formatValue={(v) => `${v} seats`}
            />
          </ControlRow>

          <ControlRow
            label="Agent Computer runtime"
            value={`${hoursPerDay} h / day`}
            hint="Total running time across the team, on the default 2 vCPU / 4 GiB machine. Auto-stop means stopped time draws 0 credits."
          >
            <Slider
              value={[hoursPerDay]}
              onValueChange={([v]) => setHoursPerDay(v ?? 0)}
              min={0}
              max={24}
              step={1}
              thumbLabel="Agent Computer hours per day"
              formatValue={(v) => `${v} hours per day`}
            />
          </ControlRow>
        </div>

        <div className="border-border bg-muted/40 dark:bg-muted/15 flex flex-col gap-3 border-t p-6 sm:p-8 md:border-t-0 md:border-l">
          <ReceiptRow label="Pooled credits / month" value={FMT.format(pooledCredits)} />
          <ReceiptRow label="Runtime the pool covers" value={`≈ ${FMT.format(Math.floor(poolHours))} h`} />
          <ReceiptRow label={`Your runtime (${DAYS_PER_MONTH} days)`} value={`${FMT.format(usedHours)} h`} />
          <ReceiptRow label="Compute draw" value={`≈ ${FMT.format(Math.round(usedCredits))} credits`} />

          <div className="border-border mt-auto border-t pt-4">
            <div className="text-muted-foreground text-xs">
              {covered ? 'Left in the pool' : 'Top-up needed'}
            </div>
            <div className="text-foreground mt-1 font-mono text-2xl font-medium tracking-tight tabular-nums">
              {`≈ ${FMT.format(Math.round(Math.abs(remaining)))} credits`}
            </div>
            <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
              {covered
                ? 'Spend it on managed model tokens or more runtime — or don’t; unused compute bills nothing.'
                : `About $${(Math.abs(remaining) / CREDITS_PER_USD).toFixed(0)} of top-up credits at this pace.`}
            </p>
          </div>
        </div>
      </div>

      <p className="text-muted-foreground border-border border-t px-6 py-4 text-xs leading-relaxed sm:px-8">
        Compute is billed per second, per resource. The default Agent Computer uses{' '}
        <span className="text-foreground font-medium tabular-nums">
          {`≈ ${CREDITS_PER_HOUR.toFixed(0)} credits ($${DEFAULT_COMPUTE_HOURLY_PRICE_USD.toFixed(2)}) per hour`}
        </span>{' '}
        while running. Optional managed model usage is token-based and draws from the same pool.
      </p>
    </div>
  );
}
