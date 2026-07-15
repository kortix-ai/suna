'use client';

/**
 * `AppsCard` — the things the agent has running, and one row each.
 *
 * A running app used to be row 13 of 13 inside Outputs, buried under twelve
 * `.tsx` files nobody asked for. But the fix isn't a hero banner either: a real
 * session runs SEVERAL servers at once — the site on :3000, the API on :8000,
 * Storybook on :6006 — and "Your app is running" is wrong the moment there are
 * two of them. A banner per app is a wall of banners.
 *
 * So this is a card shaped exactly like Outputs and Context: a count in the
 * header, one row per thing, expand to see them. That shape already survives 1
 * file or 40, and it survives 1 app or 10 for the same reason. Consistency is
 * what scales; a special case is what breaks.
 *
 * Each row is a live dot, a name, and the port. The dot is the whole "this is
 * alive" signal — a non-technical user reads it without being told to, and
 * unlike a live thumbnail it cannot half-load and libel a working app as broken.
 */

import { useSandboxConnectionStore } from '@kortix/sdk/sandbox-connection-store';
import { cn } from '@/lib/utils';
import { parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { useSyncExternalStore } from 'react';
import type { OutputItem } from '../shared/derive-panels';
import { PanelCard } from './panel-card';

function portOf(url: string | undefined): number {
  return parseLocalhostUrl(url ?? '')?.port ?? 0;
}

// zustand v5's own hook feeds React's `useSyncExternalStore` a
// `getServerSnapshot` pinned to `getInitialState()` — correct for real SSR
// (sandbox health can only ever be learned from a client-side poll, so it is
// genuinely "connecting" at request time), but it means a real server-render
// dispatcher (which is exactly what `renderToStaticMarkup` uses, in this
// component's own test) can never observe a `setState` call that happened
// earlier in the same process. Reading through `getState()` for both
// snapshots sidesteps that — same live value, same reactivity via
// `subscribe`, no behavior change in the browser or in real SSR.
const getSandboxAliveSnapshot = () => {
  const s = useSandboxConnectionStore.getState();
  return s.status === 'connected' && s.healthy === true;
};

export function AppsCard({
  apps,
  onOpenApp,
}: {
  apps: OutputItem[];
  onOpenApp: (app: OutputItem) => void;
}) {
  // One subscription for the card, not one per row: liveness is a property of
  // the sandbox, and every app in it lives or dies together. The green pulse
  // was static markup before this — a stopped sandbox kept "live" dots pulsing
  // over dead servers, which is the panel lying (W8).
  const sandboxAlive = useSyncExternalStore(
    useSandboxConnectionStore.subscribe,
    getSandboxAliveSnapshot,
    getSandboxAliveSnapshot,
  );

  return (
    <PanelCard
      title="Apps"
      count={apps.length}
      isEmpty={apps.length === 0}
      // The payoff: if the agent got something running, that is the single most
      // interesting fact in the panel. It should not take a click to learn it.
      defaultExpanded={apps.length > 0}
      emptyArt={<AppsArt />}
      emptyText="Anything the agent runs — a site, an app, an API — opens from here."
      contentClassName="border-border border-t px-2 py-2"
    >
      <ul className="flex flex-col gap-0">
        {apps.map((app) => {
          const port = portOf(app.url);
          return (
            <li key={app.url}>
              <button
                type="button"
                onClick={() => onOpenApp(app)}
                className={cn(
                  'hover:bg-accent -mx-0.5 flex w-full items-center gap-2.5 rounded-sm px-1 py-1.5 text-left',
                  'transition-[background-color,transform] active:scale-[0.998]',
                )}
              >
                <span className="flex size-7 shrink-0 items-center justify-center" aria-hidden>
                  <span className="relative flex size-2">
                    {sandboxAlive && (
                      <span className="bg-kortix-green absolute inline-flex size-2 animate-ping rounded-full opacity-60 motion-reduce:animate-none" />
                    )}
                    <span
                      className={cn(
                        'relative inline-flex size-2 rounded-full',
                        sandboxAlive ? 'bg-kortix-green' : 'bg-muted-foreground/40',
                      )}
                    />
                  </span>
                </span>
                <span className="text-foreground min-w-0 flex-1 truncate text-sm">{app.name}</span>
                {!sandboxAlive && (
                  <span className="text-muted-foreground shrink-0 text-xs">stopped</span>
                )}
                {sandboxAlive && port > 0 && (
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    :{port}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </PanelCard>
  );
}

/** Soft placeholder art — a browser window, matching the other cards' empty states. */
function AppsArt() {
  return (
    <div
      aria-hidden
      className="border-border/60 bg-muted/30 flex h-16 w-20 flex-col gap-1.5 rounded-md border p-2"
    >
      <div className="flex gap-1">
        <span className="bg-muted-foreground/30 size-1 rounded-full" />
        <span className="bg-muted-foreground/30 size-1 rounded-full" />
        <span className="bg-muted-foreground/30 size-1 rounded-full" />
      </div>
      <span className="bg-muted-foreground/20 h-full w-full rounded-sm" />
    </div>
  );
}
