'use client';

/**
 * Instance list row components.
 * Shared by /instances, /debug/instances, and anywhere else we need to
 * render a sandbox row in the same visual language.
 *
 * Status pills intentionally removed — neither lifecycle status nor live
 * probes were trustworthy (init status lied; the live probe never settled
 * fast enough to be useful). Clicking the row IS the test: it works, or
 * the connecting screen takes over with the real diagnostic.
 *
 * No provider distinction — from a user's perspective a "VPS", a "cloud
 * machine" and a "local docker container" are all just computers.
 */

import { ChevronRight, Settings2, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { SandboxInfo } from '@/lib/platform-client';
import type { ServerEntry } from '@/stores/server-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// ─── Shared row primitives ─────────────────────────────────────────────────

const CARD_CLS =
  'w-full rounded-xl border border-border/50 bg-card hover:bg-muted/30 hover:border-border transition-colors group';

/** First two alphanumeric characters of the workspace name, uppercased.
 *  Matches the sidebar switcher's avatar treatment so workspaces have a
 *  consistent visual identity across the picker + the in-app switcher. */
function workspaceInitials(label: string): string {
  const parts = label.split(/[\s-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

function WorkspaceTile({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'inline-flex items-center justify-center h-10 w-10 rounded-lg flex-shrink-0 mt-0.5',
        'bg-foreground/[0.07] text-foreground/80 text-[13px] font-semibold select-none',
      )}
    >
      {workspaceInitials(label) || 'W'}
    </div>
  );
}

function ChevronAffordance({ className }: { className?: string }) {
  return (
    <ChevronRight
      className={cn(
        'h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground group-hover:translate-x-0.5 transition-all',
        className,
      )}
    />
  );
}

// ─── Card action button ────────────────────────────────────────────────────
//
// Inline icon action rendered inside the card. Clicks don't bubble to the
// card's main navigation handler — each action is its own leaf interaction.

function CardAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled) return;
            onClick();
          }}
          className={cn(
            'flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground/60',
            'hover:text-foreground hover:bg-muted/70 transition-colors',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Instance card (live sandbox) ──────────────────────────────────────────

export function InstanceCard({
  sandbox,
  onClick,
  onSettings,
}: {
  sandbox: SandboxInfo;
  onClick: () => void;
  onSettings?: () => void;
}) {
  const meta = sandbox.metadata as Record<string, unknown> | undefined;
  const serverType = (meta?.serverType as string) || null;

  // Settings modal is meaningful for any non-archived sandbox the user
  // wants to inspect/configure — including ones in a failed/stopped state
  // (those are the ones that often need the modal most).
  const showSettings = sandbox.status !== 'archived' && !!onSettings;

  return (
    <div className={CARD_CLS}>
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          onClick={onClick}
          className="flex items-start gap-3 flex-1 min-w-0 text-left cursor-pointer"
        >
          <WorkspaceTile label={sandbox.name || sandbox.sandbox_id} />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-foreground truncate block">
              {sandbox.name || sandbox.sandbox_id}
            </span>

            {(serverType || sandbox.version) && (
              <div className="flex items-center gap-3 mt-1">
                {serverType && (
                  <span className="text-[11px] text-muted-foreground/50 font-mono">{serverType}</span>
                )}
                {sandbox.version && (
                  <span className="text-[11px] text-muted-foreground/50 font-mono">v{sandbox.version}</span>
                )}
              </div>
            )}
          </div>
        </button>

        <div className="flex items-center flex-shrink-0 mt-1">
          {showSettings && (
            <div className="flex items-center gap-0.5 mr-1 opacity-70 group-hover:opacity-100 transition-opacity">
              <CardAction
                icon={Settings2}
                label="Instance settings"
                onClick={onSettings!}
              />
            </div>
          )}
          <button
            type="button"
            onClick={onClick}
            aria-label="Open instance"
            className="flex items-center justify-center h-8 w-6 rounded-md cursor-pointer"
          >
            <ChevronAffordance />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Fallback card (server-store entry, no live sandbox) ───────────────────

export function FallbackInstanceCard({
  server,
  isActive,
  onClick,
}: {
  server: ServerEntry;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(CARD_CLS, 'text-left cursor-pointer')}
    >
      <div className="flex items-start gap-3 p-4">
        <WorkspaceTile label={server.label || server.instanceId || server.id} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">
              {server.label || server.instanceId || server.id}
            </span>
            {isActive && (
              <span className="px-1.5 py-px text-[0.5625rem] font-medium rounded-full uppercase tracking-wider leading-none text-primary bg-primary/10">
                current
              </span>
            )}
          </div>
          {server.instanceId && (
            <div className="flex items-center gap-3 mt-1">
              <span className="text-[11px] text-muted-foreground/50 font-mono">
                {server.instanceId}
              </span>
            </div>
          )}
        </div>
        <ChevronAffordance className="flex-shrink-0 mt-1" />
      </div>
    </button>
  );
}
