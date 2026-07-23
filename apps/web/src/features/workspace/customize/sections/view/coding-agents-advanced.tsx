'use client';

/**
 * Coding agents → Advanced. The escape hatch for the two manifest details the
 * main panel deliberately derives instead of asking about:
 *
 *   - the folder each coding agent reads its native config from (`config_dir`)
 *   - duplicate profiles — two entries pointing at the same harness, which the
 *     panel collapses into one row
 *
 * Deliberately NOT here: renaming a profile. The old modal offered it, and it
 * was a pure footgun — the name is a reference target (`agents.<x>.runtime`),
 * so renaming one silently invalidates every agent pointing at it and the save
 * comes back a 400 from `validateManifestCrossRefsV3`. Nothing in the product
 * reads the name anymore, so there's nothing to gain by changing it. Legacy
 * slugs (`runtime-1`) stay visible here as context, read-only.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import type { RuntimeProfile } from '@kortix/sdk/projects-client';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { CodingAgentRow } from './coding-agents';
import { ACP_HARNESS_CONFIG_DIRS, ACP_HARNESS_LABELS } from './runtime-profile-options';

/** Order the entries the way the panel above orders its rows, so Advanced
 *  reads as the same list with more detail — never a second, differently-sorted
 *  inventory of the same thing. */
function orderedEntries(
  runtimes: Record<string, RuntimeProfile>,
  rows: readonly CodingAgentRow[],
): Array<[string, RuntimeProfile]> {
  const rank = new Map(rows.map((row, index) => [row.harness, index]));
  return Object.entries(runtimes).sort(
    ([, a], [, b]) => (rank.get(a.harness) ?? 99) - (rank.get(b.harness) ?? 99),
  );
}

export function CodingAgentsAdvanced({
  runtimes,
  rows,
  canWrite,
  isSaving,
  onSave,
}: {
  runtimes: Record<string, RuntimeProfile>;
  rows: readonly CodingAgentRow[];
  canWrite: boolean;
  isSaving: boolean;
  onSave: (next: Record<string, RuntimeProfile>) => void;
}) {
  const [draft, setDraft] = useState(runtimes);
  // Track the committed map: a toggle in the panel above rewrites `runtimes`
  // underneath us, and Advanced must follow rather than hold a stale draft that
  // would resurrect a just-removed profile on the next save.
  useEffect(() => setDraft(runtimes), [runtimes]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(runtimes);
  const entries = orderedEntries(draft, rows);
  // A harness with more than one profile — the only case where a Remove button
  // here is safe and meaningful (the panel's switch owns the last one).
  const duplicated = new Set(
    rows.filter((row) => row.extraProfileNames.length > 0).map((row) => row.harness),
  );

  const setConfigDir = (name: string, value: string) =>
    setDraft((current) => ({
      ...current,
      [name]: { ...current[name]!, config_dir: value || undefined },
    }));

  const remove = (name: string) =>
    setDraft((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });

  return (
    <Disclosure variant="outline" className="overflow-hidden">
      <DisclosureTrigger variant="outline">
        <Button
          variant="popover"
          className="flex w-full items-center justify-start rounded-none text-xs font-medium"
        >
          Advanced — config folders
        </Button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <div className="space-y-4 px-4 py-4">
          <p className="text-muted-foreground/70 text-xs leading-relaxed text-pretty">
            The folder inside the sandbox each coding agent reads its own settings from. Leave blank
            to use its default.
          </p>

          {entries.map(([name, profile]) => (
            <div key={name} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{ACP_HARNESS_LABELS[profile.harness]}</span>
                {name !== profile.harness ? (
                  <Badge variant="muted" size="xs" className="font-mono">
                    {name}
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  variant="popover"
                  aria-label={`Config folder for ${ACP_HARNESS_LABELS[profile.harness]}`}
                  value={profile.config_dir ?? ''}
                  placeholder={ACP_HARNESS_CONFIG_DIRS[profile.harness]}
                  disabled={!canWrite}
                  onChange={(event) => setConfigDir(name, event.target.value)}
                />
                {duplicated.has(profile.harness) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    aria-label={`Remove ${name}`}
                    disabled={!canWrite}
                    onClick={() => remove(name)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}

          {entries.length === 0 ? (
            <p className="text-muted-foreground/60 text-xs">No coding agents turned on yet.</p>
          ) : null}

          {canWrite ? (
            <div className="border-border/50 flex items-center justify-end gap-2 border-t pt-3">
              {dirty ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isSaving}
                  onClick={() => setDraft(runtimes)}
                >
                  Reset
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                className="transition-transform active:scale-[0.96]"
                disabled={!dirty || isSaving}
                onClick={() => onSave(draft)}
              >
                {isSaving ? <Loading className="size-3.5 shrink-0" /> : null}
                Save folders
              </Button>
            </div>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
