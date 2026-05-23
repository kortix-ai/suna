'use client';

import { useTranslations } from 'next-intl';

import React from 'react';
import {
  ExternalLink,
  RotateCcw,
  Square,
  Trash2,
  ScrollText,
  GitBranch,
  FileCode2,
  Files,
  Archive,
  Globe,
  AlertCircle,
  Settings,
  Pencil,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Deployment, DeploymentStatus, DeploymentSource } from '@/hooks/deployments/use-deployments';

// ─── Helpers ────────────────────────────────────────────────────────────────

export const statusConfig: Record<DeploymentStatus, {
  label: string;
  variant: 'highlight' | 'secondary' | 'destructive' | 'outline' | 'beta';
  dotColor: string;
}> = {
  active: { label: 'Active', variant: 'highlight', dotColor: 'bg-emerald-500' },
  pending: { label: 'Pending', variant: 'beta', dotColor: 'bg-blue-500 animate-pulse' },
  building: { label: 'Building', variant: 'beta', dotColor: 'bg-blue-500 animate-pulse' },
  deploying: { label: 'Deploying', variant: 'beta', dotColor: 'bg-blue-500 animate-pulse' },
  failed: { label: 'Failed', variant: 'destructive', dotColor: 'bg-red-500' },
  stopped: { label: 'Stopped', variant: 'secondary', dotColor: 'bg-gray-400' },
};

const sourceIcons: Record<DeploymentSource, React.ComponentType<{ className?: string }>> = {
  git: GitBranch,
  code: FileCode2,
  files: Files,
  tar: Archive,
};

const sourceLabels: Record<DeploymentSource, string> = {
  git: 'Git',
  code: 'Code',
  files: 'Files',
  tar: 'Tar',
};

export function isFreestyleKeyError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('freestyle') && (lower.includes('key') || lower.includes('configured'));
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const absDiff = Math.abs(diffMs);

  if (absDiff < 60_000) return 'just now';
  if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    return `${mins}m ago`;
  }
  if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    return `${hrs}h ago`;
  }
  const days = Math.round(absDiff / 86_400_000);
  return `${days}d ago`;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface DeploymentCardProps {
  deployment: Deployment;
  onViewLogs: (deployment: Deployment) => void;
  onStop: (deployment: Deployment) => void;
  onRedeploy: (deployment: Deployment) => void;
  onEditRedeploy: (deployment: Deployment) => void;
  onDelete: (deployment: Deployment) => void;
  onConfigureApiKey?: () => void;
  isStopPending?: boolean;
  isRedeployPending?: boolean;
  isDeletePending?: boolean;
  /** Compact mode for version sub-rows inside a domain group */
  compact?: boolean;
}

export function DeploymentCard({
  deployment,
  onViewLogs,
  onStop,
  onRedeploy,
  onEditRedeploy,
  onDelete,
  onConfigureApiKey,
  isStopPending,
  isRedeployPending,
  isDeletePending,
  compact = false,
}: DeploymentCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const status = statusConfig[deployment.status] || statusConfig.pending;
  const SourceIcon = sourceIcons[deployment.sourceType] || FileCode2;
  const domain = deployment.domains?.[0] || null;
  const isInProgress = deployment.status === 'pending' || deployment.status === 'building' || deployment.status === 'deploying';
  const canRedeploy = deployment.status === 'active' || deployment.status === 'failed' || deployment.status === 'stopped';

  // ─── Compact version row (used inside domain groups) ────────────────────
  if (compact) {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg hover:bg-muted/30 transition-colors group/version">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Badge variant="secondary" className="text-xs shrink-0 tabular-nums">
            v{deployment.version}
          </Badge>
          {deployment.status === 'failed' && deployment.error ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant={status.variant} className="text-xs shrink-0 cursor-help">
                  <span className={cn('inline-block w-1.5 h-1.5 rounded-full mr-1', status.dotColor)} />
                  {status.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs max-w-[300px]">
                {deployment.error}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Badge variant={status.variant} className="text-xs shrink-0">
              <span className={cn('inline-block w-1.5 h-1.5 rounded-full mr-1', status.dotColor)} />
              {status.label}
            </Badge>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <span className="flex items-center gap-1 shrink-0">
              <SourceIcon className="h-3 w-3" />
              {sourceLabels[deployment.sourceType]}
            </span>
            {deployment.framework && (
              <>
                <span className="text-border">·</span>
                <span className="shrink-0">{deployment.framework}</span>
              </>
            )}
            <span className="text-border">·</span>
            <span className="shrink-0">{formatRelativeTime(deployment.createdAt)}</span>
          </div>
        </div>

        {/* Compact action buttons */}
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/version:opacity-100 transition-opacity">
          {deployment.liveUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon-sm">
                  <a
                    href={deployment.liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{tHardcodedUi.raw('componentsDeploymentsDeploymentCard.line177JsxTextOpenLiveUrl')}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => onViewLogs(deployment)}
                variant="ghost"
                size="icon-sm"
              >
                <ScrollText className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{tHardcodedUi.raw('componentsDeploymentsDeploymentCard.line190JsxTextViewLogs')}</TooltipContent>
          </Tooltip>
           {canRedeploy && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => onRedeploy(deployment)}
                  disabled={isRedeployPending}
                  variant="ghost"
                  size="icon-sm"
                >
                  <RotateCcw className={cn('h-3.5 w-3.5', isRedeployPending && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Redeploy</TooltipContent>
            </Tooltip>
          )}
          {(deployment.status === 'active' || isInProgress) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => onStop(deployment)}
                  disabled={isStopPending}
                  variant="ghost"
                  size="icon-sm"
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Stop</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => onDelete(deployment)}
                disabled={isDeletePending}
                variant="ghost"
                size="icon-sm"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
    );
  }

  // ─── Full card (standalone, used when not grouped) ──────────────────────
  return (
    <SpotlightCard className="bg-card transition-colors group">
      <div className="p-5">
        {/* Top row: icon + info + status */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-card border border-border/50 shrink-0">
              <Globe className="h-5 w-5 text-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <h3 className="font-medium text-foreground truncate">
                  {domain || deployment.deploymentId.slice(0, 8)}
                </h3>
                <Badge variant={status.variant} className="text-xs">
                  <span className={cn('inline-block w-1.5 h-1.5 rounded-full mr-1', status.dotColor)} />
                  {status.label}
                </Badge>
                {deployment.version > 1 && (
                  <Badge variant="secondary" className="text-xs">
                    v{deployment.version}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <SourceIcon className="h-3 w-3" />
                  {sourceLabels[deployment.sourceType]}
                </span>
                {deployment.framework && (
                  <>
                    <span className="text-border">|</span>
                    <span>{deployment.framework}</span>
                  </>
                )}
                {deployment.sourceRef && (
                  <>
                    <span className="text-border">|</span>
                    <span className="truncate max-w-[200px]">{deployment.sourceRef}</span>
                  </>
                )}
                <span className="text-border">|</span>
                <span>{formatRelativeTime(deployment.createdAt)}</span>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            {deployment.liveUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button asChild variant="ghost" size="icon">
                    <a
                      href={deployment.liveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">{tHardcodedUi.raw('componentsDeploymentsDeploymentCard.line303JsxTextOpenLiveUrl')}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => onViewLogs(deployment)}
                  variant="ghost"
                  size="icon"
                >
                  <ScrollText className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{tHardcodedUi.raw('componentsDeploymentsDeploymentCard.line316JsxTextViewLogs')}</TooltipContent>
            </Tooltip>
            {canRedeploy && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onEditRedeploy(deployment)}
                    variant="ghost"
                    size="icon"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">{tHardcodedUi.raw('componentsDeploymentsDeploymentCard.line329JsxTextEditAmpRedeploy')}</TooltipContent>
              </Tooltip>
            )}
            {canRedeploy && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onRedeploy(deployment)}
                    disabled={isRedeployPending}
                    variant="ghost"
                    size="icon"
                  >
                    <RotateCcw className={cn('h-4 w-4', isRedeployPending && 'animate-spin')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Redeploy</TooltipContent>
              </Tooltip>
            )}
            {(deployment.status === 'active' || isInProgress) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onStop(deployment)}
                    disabled={isStopPending}
                    variant="ghost"
                    size="icon"
                  >
                    <Square className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Stop</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => onDelete(deployment)}
                  disabled={isDeletePending}
                  variant="ghost"
                  size="icon"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Delete</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Live URL row */}
        {deployment.liveUrl && deployment.status === 'active' && (
          <div className="mt-3 pl-16">
            <a
              href={deployment.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline cursor-pointer"
            >
              <ExternalLink className="h-3 w-3" />
              {deployment.liveUrl}
            </a>
          </div>
        )}

        {/* Error message + actions */}
        {deployment.status === 'failed' && deployment.error && (
          <div className="mt-3 pl-16 space-y-2.5">
            <InfoBanner
              tone="destructive"
              icon={AlertCircle}
              action={
                isFreestyleKeyError(deployment.error) && onConfigureApiKey ? (
                  <Button
                    onClick={onConfigureApiKey}
                    size="xs"
                    variant="muted"
                    className="shrink-0"
                  >
                    <Settings className="h-3 w-3" />
                    Configure
                  </Button>
                ) : undefined
              }
            >
              <span className="line-clamp-2">{deployment.error}</span>
            </InfoBanner>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onEditRedeploy(deployment)}
              >
                <Pencil className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsDeploymentsDeploymentCard.line422JsxTextEditAmpRedeploy')}</Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onRedeploy(deployment)}
                disabled={isRedeployPending}
              >
                <RotateCcw className={cn('h-3.5 w-3.5', isRedeployPending && 'animate-spin')} />
                {isRedeployPending ? 'Redeploying...' : 'Redeploy'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </SpotlightCard>
  );
}
