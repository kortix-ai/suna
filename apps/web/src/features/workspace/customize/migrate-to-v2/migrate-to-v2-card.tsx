'use client';

/**
 * The full "Upgrade to v2" banner — description + action, for surfaces that
 * want more than a bare button (Settings today). Hides itself entirely
 * (not just the button) once the project is v2 or the read hasn't resolved,
 * so no orphaned label/description ever renders without an action.
 */

import { Badge } from '@/components/ui/badge';

import { MigrateToV2Button } from './migrate-to-v2-button';
import { useProjectManifestVersion } from './manifest-version';

export function MigrateToV2Card({ projectId }: { projectId: string }) {
  const { version, isLoading } = useProjectManifestVersion(projectId);
  if (isLoading || version !== 1) return null;

  return (
    <section className="space-y-4">
      <div className="bg-popover flex items-center justify-between gap-4 rounded-md border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-foreground text-sm font-medium">Upgrade to kortix.yaml (v2)</p>
            <Badge variant="highlight" size="sm">
              New
            </Badge>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            This project still uses the v1 <span className="font-mono">kortix.toml</span> manifest.
            An agent session converts it to <span className="font-mono">kortix.yaml</span> — per-agent
            model, permissions, and grants unified in one place — and opens a change request for you
            to review and merge.
          </p>
        </div>
        <MigrateToV2Button projectId={projectId} className="shrink-0" />
      </div>
    </section>
  );
}
