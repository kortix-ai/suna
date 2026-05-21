'use client';

import React, { useState } from 'react';
import {
  ExternalLink,
  RotateCcw,
  Square,
  Trash2,
  ScrollText,
  Globe,
  Pencil,
  ChevronRight,
  AlertCircle,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Deployment } from '@/hooks/deployments/use-deployments';
import type { DeploymentGroup as DeploymentGroupType } from '@/hooks/deployments/use-deployments';
import { DeploymentCard, statusConfig, formatRelativeTime, isFreestyleKeyError } from './deployment-card';

// ─── Component ──────────────────────────────────────────────────────────────

interface DeploymentGroupProps {
  group: DeploymentGroupType;
  onViewLogs: (deployment: Deployment) => void;
  onStop: (deployment: Deployment) => void;
  onRedeploy: (deployment: Deployment) => void;
  onEditRedeploy: (deployment: Deployment) => void;
  onDelete: (deployment: Deployment) => void;
  onConfigureApiKey?: () => void;
  isStopPending?: boolean;
  isRedeployPending?: boolean;
  isDeletePending?: boolean;
}

export function DeploymentGroup({
  group,
  onViewLogs,
  onStop,
  onRedeploy,
  onEditRedeploy,
  onDelete,
  onConfigureApiKey,
  isStopPending,
  isRedeployPending,
  isDeletePending,
}: DeploymentGroupProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { latestDeployment, allVersions, versionCount } = group;
  const status = statusConfig[latestDeployment.status] || statusConfig.pending;
  const isInProgress =
    latestDeployment.status === 'pending' ||
    latestDeployment.status === 'building' ||
    latestDeployment.status === 'deploying';
  const canRedeploy =
    latestDeployment.status === 'active' ||
    latestDeployment.status === 'failed' ||
    latestDeployment.status === 'stopped';

  // For single-version groups, render the standard full card
  if (versionCount === 1) {
    return (
      <DeploymentCard
        deployment={latestDeployment}
        onViewLogs={onViewLogs}
        onStop={onStop}
        onRedeploy={onRedeploy}
        onEditRedeploy={onEditRedeploy}
        onDelete={onDelete}
        onConfigureApiKey={onConfigureApiKey}
        isStopPending={isStopPending}
        isRedeployPending={isRedeployPending}
        isDeletePending={isDeletePending}
      />
    );
  }

  // Multi-version group with collapsible history
  return (
    <SpotlightCard className="bg-card transition-colors group">
      <div className="p-5">
        {/* Group header: icon + domain + latest status + actions */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-card border border-border/50 shrink-0">
              <Globe className="h-5 w-5 text-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <h3 className="font-medium text-foreground truncate">
                  {group.domain}
                </h3>
                <Badge variant={status.variant} className="text-xs">
                  <span className={cn('inline-block w-1.5 h-1.5 rounded-full mr-1', status.dotColor)} />
                  {status.label}
                </Badge>
                <Badge variant="secondary" className="text-xs">
                  v{latestDeployment.version}
                </Badge>
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  {versionCount} {versionCount === 1 ? 'version' : 'versions'}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                {latestDeployment.framework && (
                  <>
                    <span>{latestDeployment.framework}</span>
                    <span className="text-border">|</span>
                  </>
                )}
                {latestDeployment.sourceRef && (
                  <>
                    <span className="truncate max-w-[200px]">{latestDeployment.sourceRef}</span>
                    <span className="text-border">|</span>
                  </>
                )}
                <span>{formatRelativeTime(latestDeployment.createdAt)}</span>
              </div>
            </div>
          </div>

          {/* Action buttons for latest deployment */}
          <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            {latestDeployment.liveUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={latestDeployment.liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 rounded-lg cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Open live URL</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => onViewLogs(latestDeployment)}
                  variant="ghost"
                  size="icon"
                  >
                  <ScrollText className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">View logs</TooltipContent>
            </Tooltip>
            {canRedeploy && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onEditRedeploy(latestDeployment)}
                    variant="ghost"
                    size="icon"
                    >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Edit &amp; Redeploy</TooltipContent>
              </Tooltip>
            )}
            {canRedeploy && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onRedeploy(latestDeployment)}
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
            {(latestDeployment.status === 'active' || isInProgress) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onStop(latestDeployment)}
                    disabled={isStopPending}
                    variant="ghost"
                    size="icon"
                    className="hover:text-orange-500 hover:bg-orange-500/10"
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
                  onClick={() => onDelete(latestDeployment)}
                  disabled={isDeletePending}
                  variant="ghost"
                  size="icon"
                  className="hover:text-red-500 hover:bg-red-500/10"
                  >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Delete</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Live URL row */}
        {latestDeployment.liveUrl && latestDeployment.status === 'active' && (
          <div className="mt-3 pl-16">
            <a
              href={latestDeployment.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline cursor-pointer"
            >
              <ExternalLink className="h-3 w-3" />
              {latestDeployment.liveUrl}
            </a>
          </div>
        )}

        {/* Error message for latest deployment */}
        {latestDeployment.status === 'failed' && latestDeployment.error && (
          <div className="mt-3 pl-16 space-y-2.5">
            <div className="flex items-center gap-2 text-sm text-red-500 dark:text-red-400 bg-red-500/5 rounded-2xl px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="flex-1 line-clamp-2">{latestDeployment.error}</span>
              {isFreestyleKeyError(latestDeployment.error) && onConfigureApiKey && (
                <Button
                  onClick={onConfigureApiKey}
                  variant="muted"
                  size="xs"
                  className="shrink-0 hover:text-red-500 hover:bg-red-500/10"
                  >
                  <Settings className="h-3 w-3" />
                  Configure
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onEditRedeploy(latestDeployment)}
                className="h-8 gap-1.5 text-xs cursor-pointer"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit &amp; Redeploy
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRedeploy(latestDeployment)}
                disabled={isRedeployPending}
                className="h-8 gap-1.5 text-xs cursor-pointer"
              >
                <RotateCcw className={cn('h-3.5 w-3.5', isRedeployPending && 'animate-spin')} />
                {isRedeployPending ? 'Redeploying...' : 'Redeploy'}
              </Button>
            </div>
          </div>
        )}

        {/* Expand/collapse toggle for version history */}
        <div className="mt-3 pl-16">
          <Button
            onClick={() => setIsExpanded(!isExpanded)}
            variant="muted"
            size="xs"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-200',
                isExpanded && 'rotate-90',
              )}
            />
            {isExpanded ? 'Hide' : 'Show'} version history
          </Button>
        </div>

        {/* Version history (collapsible) */}
        {isExpanded && (
          <div className="mt-2 ml-16 border-l-2 border-border/40 pl-2 space-y-0.5">
            {allVersions.map((version) => (
              <DeploymentCard
                key={version.deploymentId}
                deployment={version}
                onViewLogs={onViewLogs}
                onStop={onStop}
                onRedeploy={onRedeploy}
                onEditRedeploy={onEditRedeploy}
                onDelete={onDelete}
                onConfigureApiKey={onConfigureApiKey}
                isStopPending={isStopPending}
                isRedeployPending={isRedeployPending}
                isDeletePending={isDeletePending}
                compact
              />
            ))}
          </div>
        )}
      </div>
    </SpotlightCard>
  );
}
