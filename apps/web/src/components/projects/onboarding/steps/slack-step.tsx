'use client';

/**
 * Install Kortix into Slack.
 *
 * The managed and custom install paths stay in one fixed decision lane. The
 * custom manifest form opens in the shared context rail, so the lane never
 * widens or moves.
 *
 * The install itself is unchanged: open the OAuth popup, poll, detect.
 */

import { CheckCircleIcon, SlidersHorizontalIcon, XIcon as X } from '@phosphor-icons/react';
import { AnimatePresence } from 'motion/react';
import { Suspense, lazy, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { useSlackInstall, useSlackMode } from '@/hooks/channels/use-channels-installations';

import { Slack } from '@/features/icon/icons/slack';
import { ActionRow, StepContext, StepShell } from '../step-shell';

/** Lazy — keeps the giant connectors-view module out of the project bundle. */
const importConnectorsView = () =>
  import('@/features/workspace/customize/sections/connectors-view');

const SlackConnectForm = lazy(() =>
  importConnectorsView().then((m) => ({ default: m.SlackConnectForm })),
);

/**
 * Fetch the chunk on hover, before the click.
 *
 * Left to itself, `lazy()` starts downloading when the panel mounts — so the
 * browser downloads, parses, and mounts a large form with a syntax-highlighted
 * manifest *during* the open animation, and drops frames doing it. This was the
 * single biggest source of jank on this step; easing had nothing to do with it.
 * Idempotent: the module registry dedupes, so repeat calls are free.
 */
const preloadConnectorsView = () => {
  void importConnectorsView();
};

export function SlackStep({
  projectId,
  onContinue,
  onSkip,
}: {
  projectId: string;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const mode = useSlackMode(projectId);
  const install = useSlackInstall(projectId);
  const [customRequested, setCustomRequested] = useState(false);
  const [pollRequested, setPollRequested] = useState(false);

  const installUrl = mode.data?.oauth_available ? mode.data.install_url : null;
  const connected = !!install.data;

  // Both derived rather than reset from effects: a landed install closes the
  // panel and stops the poll without cascading a render to say so.
  const customOpen = customRequested && !connected;
  const waiting = pollRequested && !connected;

  const refetch = install.refetch;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => refetch(), 2500);
    return () => clearInterval(id);
  }, [waiting, refetch]);

  const openInstall = () => {
    if (!installUrl) return;
    window.open(installUrl, 'kortix-slack-install', 'width=640,height=780,noopener');
    setCustomRequested(false);
    setPollRequested(true);
  };

  const toggleCustom = () => {
    setPollRequested(false);
    setCustomRequested((open) => !open);
  };

  return (
    <StepShell
      title="Add Kortix to Slack"
      description="This is where most teams actually use Kortix — @mention your agent, kick off tasks, get results in the channel."
      primaryLabel="Continue"
      primaryDisabled={!connected}
      onPrimary={onContinue}
      skipLabel={connected ? undefined : 'Not now'}
      onSkip={connected ? undefined : onSkip}
      context={
        <AnimatePresence initial={false}>
          {connected ? (
            <StepContext key="connected">
              <div
                className="border-border bg-popover rounded-md border p-4"
                aria-live="polite"
                aria-atomic="true"
              >
                <div className="flex items-center gap-2">
                  <CheckCircleIcon weight="fill" className="text-kortix-green size-4 shrink-0" />
                  <h2 className="text-foreground text-sm font-medium">Connected to Slack</h2>
                </div>
                <p className="text-muted-foreground mt-2 text-xs leading-5 text-pretty">
                  Installed to{' '}
                  <span className="text-foreground font-medium">
                    {install.data?.workspaceName || install.data?.workspaceId}
                  </span>
                  . You can @mention your agent in any channel it&apos;s invited to.
                </p>
              </div>
            </StepContext>
          ) : customOpen ? (
            <StepContext key="custom">
              <div className="border-border bg-popover rounded-md border p-4">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h2 className="text-foreground text-sm font-medium">
                      Bring your own Slack app
                    </h2>
                    <p className="text-muted-foreground text-xs leading-5">
                      For self-hosted setups or workspace-scoped installs.
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close custom Slack app setup"
                    className="text-muted-foreground shrink-0"
                    onClick={() => setCustomRequested(false)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
                {/* Bounded, with the fallback the same height as the loaded form.
                The manifest block is very tall; letting the panel size to it
                made the row grow far past the chooser, and since the wizard
                centres its body vertically the whole step lurched upward as it
                appeared. A fixed viewport with internal scroll keeps the row's
                height governed by the chooser, so nothing moves but the panel. */}
                <div className="max-h-[380px] overflow-y-auto pr-1">
                  <Suspense fallback={<Skeleton className="h-[380px] w-full rounded-md" />}>
                    <SlackConnectForm
                      projectId={projectId}
                      customOnly
                      onConnected={() => install.refetch()}
                    />
                  </Suspense>
                </div>
              </div>
            </StepContext>
          ) : waiting ? (
            <StepContext key="waiting">
              <div
                className="border-border/60 bg-popover rounded-md border p-4"
                aria-live="polite"
                aria-atomic="true"
              >
                <div className="flex items-center gap-2">
                  <Loading className="size-4 shrink-0" />
                  <h2 className="text-foreground text-sm font-medium">
                    Waiting for approval in Slack…
                  </h2>
                </div>
                <p className="text-muted-foreground mt-2 text-xs leading-5 text-pretty">
                  Complete the install in the Slack popup. Kortix checks the connection every 2.5
                  seconds.
                </p>
              </div>
            </StepContext>
          ) : null}
        </AnimatePresence>
      }
    >
      {!connected ? (
        <div className="flex flex-col gap-2" role="group" aria-label="Slack install method">
          <ActionRow
            label="Add to Slack"
            description="One click, nothing to configure"
            disabled={mode.isLoading || !installUrl || waiting}
            onSelect={openInstall}
            leading={<Slack className="size-5 shrink-0" />}
          />
          <ActionRow
            active={customOpen}
            label="Use a custom Slack app"
            description="For self-hosted workspaces, or when managed install is unavailable"
            onSelect={toggleCustom}
            onPreload={preloadConnectorsView}
            leading={<SlidersHorizontalIcon className="text-muted-foreground size-5 shrink-0" weight="duotone" />}
          />
        </div>
      ) : null}
    </StepShell>
  );
}
