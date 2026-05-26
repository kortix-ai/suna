'use client';

import { useTranslations } from 'next-intl';

import React, { useCallback, useMemo, useState } from 'react';
import {
  useDeployments,
  useStopDeployment,
  useRedeployDeployment,
  useDeleteDeployment,
  groupDeploymentsByDomain,
  type Deployment,
  type DeploymentStatus,
} from '@/hooks/deployments/use-deployments';
import { useSecrets } from '@/hooks/secrets/use-secrets';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  AlertCircle,
  Rocket,
  Plus,
  Search,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page-header';
import { DeploymentGroup } from './deployment-group';
import { DeploymentLogsDialog } from './deployment-logs-dialog';
import { CreateDeploymentDialog } from './create-deployment-dialog';
import { FreestyleApiKeyDialog } from './freestyle-api-key-dialog';
import { toast } from 'sonner';

// ─── Filter Tabs ────────────────────────────────────────────────────────────

const filterTabs: Array<{ label: string; value: DeploymentStatus | undefined }> = [
  { label: 'All', value: undefined },
  { label: 'Active', value: 'active' },
  { label: 'Pending', value: 'pending' },
  { label: 'Failed', value: 'failed' },
  { label: 'Stopped', value: 'stopped' },
];

// ─── Sub-components ─────────────────────────────────────────────────────────

const LoadingSkeleton = () => (
  <div className="space-y-4">
    {[1, 2, 3].map((i) => (
      <div key={i} className="rounded-2xl border dark:bg-card px-5 py-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      </div>
    ))}
  </div>
);

// ─── Main Page ──────────────────────────────────────────────────────────────

export function DeploymentsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [statusFilter, setStatusFilter] = useState<DeploymentStatus | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editDeployment, setEditDeployment] = useState<Deployment | null>(null);
  const [logsDeployment, setLogsDeployment] = useState<Deployment | null>(null);
  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Deployment | null>(null);

  const { data, isLoading, error } = useDeployments(statusFilter);
  const { data: secrets } = useSecrets();
  const stopMutation = useStopDeployment();
  const redeployMutation = useRedeployDeployment();
  const deleteMutation = useDeleteDeployment();

  const hasApiKey = !!secrets?.FREESTYLE_API_KEY;

  // Open create dialog if API key is set, otherwise show API key dialog first
  const handleNewDeployment = useCallback(() => {
    setEditDeployment(null); // Clear any edit state
    if (hasApiKey) {
      setShowCreateDialog(true);
    } else {
      setShowApiKeyDialog(true);
    }
  }, [hasApiKey]);

  // Open create dialog pre-filled with existing deployment data
  const handleEditRedeploy = useCallback((deployment: Deployment) => {
    setEditDeployment(deployment);
    setShowCreateDialog(true);
  }, []);

  const deployments = useMemo(() => data?.deployments ?? [], [data?.deployments]);

  const filteredDeployments = useMemo(() => {
    if (!searchQuery) return deployments;
    const q = searchQuery.toLowerCase();
    return deployments.filter(
      (d) =>
        d.domains?.some((domain) => domain.toLowerCase().includes(q)) ||
        d.liveUrl?.toLowerCase().includes(q) ||
        d.sourceRef?.toLowerCase().includes(q) ||
        d.framework?.toLowerCase().includes(q) ||
        d.deploymentId.toLowerCase().includes(q),
    );
  }, [deployments, searchQuery]);

  const groupedDeployments = useMemo(
    () => groupDeploymentsByDomain(filteredDeployments),
    [filteredDeployments],
  );

  const handleStop = async (deployment: Deployment) => {
    try {
      await stopMutation.mutateAsync(deployment.deploymentId);
      toast.success('Deployment stopped');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to stop deployment');
    }
  };

  const handleRedeploy = async (deployment: Deployment) => {
    try {
      const result = await redeployMutation.mutateAsync(deployment.deploymentId);
      if (result.status === 'active') {
        toast.success('Redeployment successful!', {
          description: result.liveUrl || undefined,
        });
      } else if (result.status === 'failed') {
        toast.error('Redeployment failed', {
          description: result.error || undefined,
        });
      } else {
        toast.success('Redeployment started');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to redeploy');
    }
  };

  const handleDelete = useCallback((deployment: Deployment) => {
    setDeleteTarget(deployment);
  }, []);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.deploymentId);
      toast.success('Deployment deleted');
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete deployment');
    }
  };

  if (error) {
    return (
      <div className="h-screen flex flex-col">
        <div className="max-w-4xl mx-auto w-full py-8 px-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line179JsxTextFailedToLoadDeploymentsPleaseTryRefreshingThe')}</AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh]">
      {/* Hero / PageHeader */}
      <div className="py-4 sm:py-8">
        <div className="container mx-auto max-w-7xl px-3 sm:px-4">
          <PageHeader icon={Rocket}>
            <div className="space-y-2 sm:space-y-4">
              <div className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight">
                <span className="text-primary">Deployments</span>
              </div>
            </div>
          </PageHeader>
        </div>
      </div>

      <div className="container mx-auto max-w-7xl px-3 sm:px-4">
        {/* Filter tabs + Search + Create */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-4">
          {/* Filter tabs */}
          <FilterBar>
            {filterTabs.map((tab) => (
              <FilterBarItem
                key={tab.label}
                value={tab.label}
                onClick={() => setStatusFilter(tab.value)}
                data-state={statusFilter === tab.value ? 'active' : 'inactive'}
              >
                {tab.label}
              </FilterBarItem>
            ))}
          </FilterBar>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            {/* Search */}
            <PageSearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line224JsxAttrPlaceholderSearchDeployments')}
              className="sm:max-w-64"
            />

            {/* Create button */}
            <Button
              variant="default"
              size="default"
              className="shrink-0"
              onClick={handleNewDeployment}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden xs:inline">{tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line236JsxTextNewDeployment')}</span>
              <span className="xs:hidden">New</span>
            </Button>
          </div>
        </div>

        {/* Deployment List */}
        <div className="pb-8">
          {isLoading ? (
            <LoadingSkeleton />
          ) : groupedDeployments.length === 0 ? (
            deployments.length === 0 && !statusFilter ? (
              <EmptyState
                icon={Rocket}
                title={tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line250JsxAttrTitleDeployYourFirstApp')}
                description={tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line251JsxAttrDescriptionDeployApplicationsToProductionWithASingleClick')}
                action={
                  <Button onClick={handleNewDeployment} size="sm">
                    <Plus className="h-4 w-4 mr-2" />{tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line255JsxTextNewDeployment')}</Button>
                }
              />
            ) : (
              <EmptyState
                icon={Search}
                title={searchQuery ? 'No matches' : 'No deployments found'}
                description={
                  searchQuery
                    ? `No deployments match "${searchQuery}"`
                    : `No ${statusFilter || ''} deployments found`
                }
              />
            )
          ) : (
            <div className="space-y-4">
              {groupedDeployments.map((group) => (
                <DeploymentGroup
                  key={group.domain}
                  group={group}
                  onViewLogs={setLogsDeployment}
                  onStop={handleStop}
                  onRedeploy={handleRedeploy}
                  onEditRedeploy={handleEditRedeploy}
                  onDelete={handleDelete}
                  onConfigureApiKey={() => setShowApiKeyDialog(true)}
                  isStopPending={stopMutation.isPending}
                  isRedeployPending={redeployMutation.isPending}
                  isDeletePending={deleteMutation.isPending}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <CreateDeploymentDialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          setShowCreateDialog(open);
          if (!open) setEditDeployment(null);
        }}
        prefillFrom={editDeployment}
      />

      <DeploymentLogsDialog
        deployment={logsDeployment}
        open={!!logsDeployment}
        onOpenChange={(open) => {
          if (!open) setLogsDeployment(null);
        }}
      />

      <FreestyleApiKeyDialog
        open={showApiKeyDialog}
        onOpenChange={setShowApiKeyDialog}
        onSaved={() => {
          // After saving the API key, open the create dialog
          setShowCreateDialog(true);
        }}
      />

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line323JsxTextDeleteDeployment')}</AlertDialogTitle>
            <AlertDialogDescription>{tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line325JsxTextAreYouSureYouWantToDelete')}{' '}
              <span className="font-semibold">{tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line327JsxTextQuot')}{deleteTarget?.domains?.[0] || deleteTarget?.deploymentId.slice(0, 8)}{tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line327JsxTextQuotddb5f48f')}</span>{tHardcodedUi.raw('componentsDeploymentsDeploymentsPage.line329JsxTextThisActionCannotBeUndone')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
