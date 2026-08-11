'use client';

/**
 * The generic "Migrate to v2" action — a session-backed button usable from
 * any Customize surface (Settings' workspace-level card here; the Agents
 * section's own v1 hint owns its own placement). Self-contained: fetches its
 * own v1/v2 read (reusing the shared `project-detail` query key) and hides
 * itself once the workspace is on v2 or the read hasn't resolved yet.
 */

import type { ButtonProps } from '@/components/ui/button';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { ArrowCircleUpIcon as ArrowUpCircle } from '@phosphor-icons/react';

import { useWorkspaceManifestVersion } from './manifest-version';
import { useMigrateToV2 } from './use-migrate-to-v2';

/** Presentational only — no hooks, no data fetching. Kept separate from
 *  `MigrateToV2Button` so the click behavior is testable without mocking
 *  react-query or the SDK. */
export function MigrateToV2ButtonView({
  visible,
  pending,
  onClick,
  size = 'sm',
  variant = 'secondary',
  className,
}: {
  visible: boolean;
  pending: boolean;
  onClick: () => void;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
}) {
  if (!visible) return null;
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={pending}
      onClick={onClick}
    >
      {pending ? (
        <Loading className="size-3.5 shrink-0" />
      ) : (
        <ArrowUpCircle className="size-3.5 shrink-0" />
      )}
      Migrate to v2
    </Button>
  );
}

export function MigrateToV2Button({
  workspaceId,
  size,
  variant,
  className,
}: {
  workspaceId: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
}) {
  const { version, isLoading } = useWorkspaceManifestVersion(workspaceId);
  const migrate = useMigrateToV2(workspaceId);

  return (
    <MigrateToV2ButtonView
      visible={!isLoading && version === 1}
      pending={migrate.pending}
      onClick={migrate.start}
      size={size}
      variant={variant}
      className={className}
    />
  );
}
