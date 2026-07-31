'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { getEnv } from '@/lib/env-config';
import { useDeploymentCliInstallCommand } from '@/lib/use-deployment-cli-install-command';
import { TerminalIcon } from '@phosphor-icons/react';

import { TERMINAL } from './content';

/**
 * The CLI install command for THIS deployment (kortix.com, dev, or a preview).
 *
 * Client-only because the origin is a browser fact: the hook reads
 * `window.location.origin` through `useSyncExternalStore`. It renders the
 * origin-less default on the server and settles after hydration. This is the
 * page's ONLY client island — both cards stay server-rendered.
 *
 * Full width on purpose. The command is long, and a half-width column truncates
 * it on a laptop; a visitor who cannot read the command before copying it has no
 * way to know what they are about to pipe into a shell.
 *
 * `CopyButton` is reused as-is. It already implements the mandated blur + scale
 * + opacity icon crossfade, so no second `copied` state is hand-rolled here.
 *
 * Phosphor is imported from the client entry rather than `@/lib/icons/ssr`
 * because this file is in the client graph — the SSR barrel exists for server
 * components, which cannot use React context.
 */
export function TerminalBlock() {
  const command = useDeploymentCliInstallCommand(getEnv().VERSION);

  return (
    <section className="bg-popover overflow-hidden rounded-md border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-5 pb-4">
        <TerminalIcon className="text-foreground size-5 shrink-0" />
        <h2 className="text-foreground text-base font-medium">{TERMINAL.title}</h2>
        <p className="text-muted-foreground w-full text-sm sm:w-auto sm:flex-1">
          {TERMINAL.description}
        </p>
        {/* States the gap rather than hiding it: there is no Windows CLI binary,
            and the install script is bash-only. */}
        <span className="text-muted-foreground text-xs">{TERMINAL.support}</span>
      </div>

      <div className="bg-muted/50 flex items-center gap-2 border-t px-5 py-3">
        <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs select-all">
          {command}
        </code>
        <CopyButton code={command} className="shrink-0" />
      </div>
    </section>
  );
}
