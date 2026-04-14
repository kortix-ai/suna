'use client';

/**
 * Instance list row components + status config.
 * Shared by /instances, /debug/instances, and anywhere else we need to
 * render a sandbox row in the same visual language.
 *
 * No provider distinction — from a user's perspective a "VPS", a
 * "cloud machine" and a "local docker container" are all just
 * computers. We render them uniformly.
 */

import { ChevronRight, Loader2, Server, Settings2, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { SandboxInfo } from '@/lib/platform-client';
import type { ServerEntry } from '@/stores/server-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// ─── Status config ─────────────────────────────────────────────────────────

export interface StatusConfig {
  label: string;
  color: string;
  dotColor: string;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  active: { label: 'Active', color: 'text-emerald-500', dotColor: 'bg-emerald-500' },
  provisioning: { label: 'Provisioning', color: 'text-amber-500', dotColor: 'bg-amber-400' },
  stopped: { label: 'Stopped', color: 'text-muted-foreground', dotColor: 'bg-muted-foreground/40' },
  error: { label: 'Error', color: 'text-red-400', dotColor: 'bg-red-400' },
  available: { label: 'Available', color: 'text-blue-500', dotColor: 'bg-blue-500' },
  archived: { label: 'Archived', color: 'text-muted-foreground/50', dotColor: 'bg-muted-foreground/20' },
};

export function getStatusConfig(status: string): StatusConfig {
  return (
    STATUS_CONFIG[status] ?? {
      label: status,
      color: 'text-muted-foreground',
      dotColor: 'bg-muted-foreground/30',
    }
  );
}

// ─── Shared row primitives ─────────────────────────────────────────────────

const CARD_CLS =
  'w-full rounded-xl border border-border/50 bg-card hover:bg-muted/30 hover:border-border transition-colors group';

function IconBox() {
  return (
    <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-muted/50 flex-shrink-0 mt-0.5">
      <Server className="h-5 w-5 text-muted-foreground/70" />
    </div>
  );
}

function StatusPill({
  status,
  animated,
}: {
  status: StatusConfig;
  animated?: boolean;
}) {
  return (
    <span className={cn('flex items-center gap-1.5 text-xs font-medium', status.color)}>
      <span
        className={cn(
          'h-[7px] w-[7px] rounded-full flex-shrink-0',
          status.dotColor,
          animated && 'animate-pulse',
        )}
      />
      {status.label}
    </span>
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
  loading,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled || loading}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled || loading) return;
            onClick();
          }}
          className={cn(
            'flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground/60',
            'hover:text-foreground hover:bg-muted/70 transition-colors',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          )}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Icon className="h-3.5 w-3.5" />
          )}
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
  const status = getStatusConfig(sandbox.status);
  const meta = sandbox.metadata as Record<string, unknown> | undefined;
  const location = (meta?.location as string) || null;
  const serverType = (meta?.serverType as string) || null;

  // Actions only make sense once the machine has settled — hide everything
  // while it's still provisioning so users can't poke at a half-built box.
  const actionable = ['active', 'stopped', 'error'].includes(sandbox.status);
  const showSettings = actionable && !!onSettings;

  return (
    <div className={CARD_CLS}>
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          onClick={onClick}
          className="flex items-start gap-3 flex-1 min-w-0 text-left cursor-pointer"
        >
          <IconBox />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-foreground truncate block">
              {sandbox.name || sandbox.sandbox_id}
            </span>

            <div className="flex items-center gap-3 mt-1.5">
              <StatusPill status={status} animated={sandbox.status === 'provisioning'} />
              {location && (
                <span className="text-[11px] text-muted-foreground/50">{location}</span>
              )}
              {serverType && (
                <span className="text-[11px] text-muted-foreground/50 font-mono">{serverType}</span>
              )}
              {sandbox.version && (
                <span className="text-[11px] text-muted-foreground/50 font-mono">v{sandbox.version}</span>
              )}
            </div>
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
  const status = getStatusConfig(server.instanceId ? 'active' : 'available');

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(CARD_CLS, 'text-left cursor-pointer')}
    >
      <div className="flex items-start gap-3 p-4">
        <IconBox />
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
          <div className="flex items-center gap-3 mt-1.5">
            <StatusPill status={status} />
            {server.instanceId && (
              <span className="text-[11px] text-muted-foreground/50 font-mono">
                {server.instanceId}
              </span>
            )}
          </div>
        </div>
        <ChevronAffordance className="flex-shrink-0 mt-1" />
      </div>
    </button>
  );
}
