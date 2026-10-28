'use client';

import { getEnv } from '@/lib/env-config';
import { CopyButton } from '@kortix/ui/markdown';
import { useDeploymentCliInstallCommand } from '@kortix/ui/internal/lib/use-deployment-cli-install-command';

/**
 * The CLI install command for this deployment (kortix.com, dev or a preview),
 * with a copy button: the /cli hero's first action. Same hook and button as
 * the /download page's TerminalBlock. Wraps instead of truncating, so a
 * visitor reads the whole command before piping it into a shell.
 */
export function InstallCommand() {
  const command = useDeploymentCliInstallCommand(getEnv().VERSION);
  return (
    <div className="bg-card flex max-w-full items-center gap-2 rounded-md border py-1 pr-1 pl-4">
      <code className="text-foreground min-w-0 font-mono text-sm break-all select-all">
        <span className="text-muted-foreground select-none">$ </span>
        {command}
      </code>
      <CopyButton code={command} className="shrink-0" />
    </div>
  );
}
