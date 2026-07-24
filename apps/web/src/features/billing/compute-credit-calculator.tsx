'use client';

import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  estimateTeamCompute,
} from '@/features/billing/compute-pricing';
import { useState } from 'react';

const MIN_TEAM_MEMBERS = 1;
const MAX_TEAM_MEMBERS = 100;

function clampTeamMembers(value: number): number {
  return Math.min(MAX_TEAM_MEMBERS, Math.max(MIN_TEAM_MEMBERS, Math.floor(value)));
}

export function ComputeCreditCalculator() {
  const [teamMembers, setTeamMembers] = useState(1);
  const estimate = estimateTeamCompute(teamMembers);

  const setClampedTeamMembers = (value: number) => {
    setTeamMembers(clampTeamMembers(Number.isFinite(value) ? value : MIN_TEAM_MEMBERS));
  };

  return (
    <div className="bg-card rounded-md border px-5 py-6 sm:px-6">
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)] md:items-end">
        <div className="space-y-5">
          <div className="flex items-end justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="team-members-input" className="text-foreground text-sm font-medium">
                Team members
              </label>
              <p className="text-muted-foreground text-xs">
                Each member adds 2,500 pooled credits each month.
              </p>
            </div>
            <Input
              id="team-members-input"
              type="number"
              min={MIN_TEAM_MEMBERS}
              max={MAX_TEAM_MEMBERS}
              step={1}
              value={teamMembers}
              onChange={(event) => setClampedTeamMembers(Number(event.target.value))}
              className="w-28 text-right tabular-nums"
              aria-label="Team members"
            />
          </div>

          <Slider
            min={MIN_TEAM_MEMBERS}
            max={MAX_TEAM_MEMBERS}
            step={1}
            value={[teamMembers]}
            onValueChange={([value]) => setClampedTeamMembers(value)}
            aria-label="Team members"
          />

          <div className="text-muted-foreground flex justify-between text-xs tabular-nums">
            <span>{MIN_TEAM_MEMBERS} member</span>
            <span>{MAX_TEAM_MEMBERS} members</span>
          </div>
        </div>

        <div className="border-border grid grid-cols-2 gap-5 border-t pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-6">
          <div>
            <div className="text-foreground text-3xl font-medium tracking-tight tabular-nums">
              {estimate.monthlyCredits.toLocaleString()}
            </div>
            <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
              Pooled credits each month
            </div>
          </div>
          <div>
            <div className="text-foreground text-3xl font-medium tracking-tight tabular-nums">
              {estimate.runtimeHours.toLocaleString(undefined, {
                maximumFractionDigits: 1,
                minimumFractionDigits: 1,
              })}
            </div>
            <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
              Agent Computer hours each month
            </div>
          </div>
        </div>
      </div>

      <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-xs leading-relaxed">
        Agent Computer runtime costs about{' '}
        <span className="text-foreground font-medium tabular-nums">
          ${DEFAULT_COMPUTE_HOURLY_PRICE_USD.toFixed(2)}/hour
        </span>
        . Managed model usage uses the same pooled Team credits.
      </p>
    </div>
  );
}
