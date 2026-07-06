'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { type LegacyMachine } from '@/hooks/legacy/use-legacy-machine-migration';

const SUPPORT_EMAIL = 'support@kortix.com';

/**
 * Read-only card for an archived legacy machine. Automatic migration has been
 * retired; instead we list the old machine and let the user email support to
 * request a manual restore (subject/body prefilled with the sandbox id).
 */
export function LegacyMachineCard({ machine }: { machine: LegacyMachine }) {
  const providerLabel = machine.provider.charAt(0).toUpperCase() + machine.provider.slice(1);
  const created = machine.created_at ? new Date(machine.created_at).toLocaleDateString() : null;

  const subject = encodeURIComponent(`Restore legacy machine: ${machine.name}`);
  const body = encodeURIComponent(
    `Hi Kortix support,\n\nI'd like to restore a legacy machine.\n\n` +
      `Name: ${machine.name}\nSandbox ID: ${machine.sandbox_id}\nProvider: ${machine.provider}\n` +
      (created ? `Created: ${created}\n` : ''),
  );
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;

  return (
    <Card className="bg-secondary/80 relative flex flex-col gap-3 p-5">
      <div className="flex w-full items-center gap-3">
        <EntityAvatar label={machine.name} size="lg" className="bg-background" />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-foreground truncate text-sm leading-tight font-semibold">
            {machine.name}
          </h3>
          <p className="text-muted-foreground truncate text-xs">
            {providerLabel}
            {created ? ` · ${created}` : ''}
          </p>
        </div>
        <Badge variant="muted" size="sm">
          Archived
        </Badge>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => {
          window.location.href = mailto;
        }}
      >
        Request restore
      </Button>
    </Card>
  );
}
