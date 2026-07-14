'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { harnessLabel, type ModelsPageRuntime } from '@kortix/sdk/react';
import {
  setActiveHarnessConnection,
  type HarnessAuthKind,
  type HarnessId,
} from '@kortix/sdk/projects-client';

/**
 * Which compatible runtimes should default to "Use with <runtime>" checked
 * when a new connection is created — every runtime this connection is
 * compatible with that currently has no ready connection at all (handoff §6:
 * "checked when this is the first compatible connection").
 */
export function defaultUseWithHarnesses(
  compatible: HarnessId[],
  runtimes: ModelsPageRuntime[],
): Set<HarnessId> {
  const missing = runtimes.filter(
    (runtime) => compatible.includes(runtime.harness) && runtime.status === 'missing',
  );
  return new Set(missing.map((runtime) => runtime.harness));
}

export async function applyUseWithSelections(
  projectId: string,
  kind: HarnessAuthKind,
  harnesses: Set<HarnessId>,
): Promise<void> {
  await Promise.all(
    [...harnesses].map((harness) => setActiveHarnessConnection(projectId, harness, kind)),
  );
}

export function UseWithRuntimes({
  compatible,
  runtimes,
  value,
  onChange,
}: {
  compatible: HarnessId[];
  runtimes: ModelsPageRuntime[];
  value: Set<HarnessId>;
  onChange: (next: Set<HarnessId>) => void;
}) {
  const relevant = runtimes.filter((runtime) => compatible.includes(runtime.harness));
  if (relevant.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs font-medium">Use with</p>
      <div className="flex flex-col gap-2">
        {relevant.map((runtime) => (
          <Checkbox
            key={runtime.harness}
            label={harnessLabel(runtime.harness)}
            checked={value.has(runtime.harness)}
            onCheckedChange={(checked) => {
              const next = new Set(value);
              if (checked === true) next.add(runtime.harness);
              else next.delete(runtime.harness);
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}
