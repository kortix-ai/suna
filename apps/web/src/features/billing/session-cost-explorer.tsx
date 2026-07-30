'use client';

import type { SessionCostSummary, SessionCostsPage } from '@kortix/sdk';
import { EyeIcon as Eye, ReceiptIcon as ReceiptText } from '@phosphor-icons/react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  SESSION_COST_PAGE_SIZE,
  useSessionCostDetail,
  useSessionCostProjects,
  useSessionCosts,
} from '@/hooks/billing/use-session-costs';

import { SessionCostDetailContent } from './session-cost-detail';
import { formatSessionCostUsd } from './session-cost-format';

export interface SessionCostProjectOption {
  project_id: string;
  name: string;
}

interface SessionCostExplorerContentProps {
  data: SessionCostsPage | undefined;
  projects: readonly SessionCostProjectOption[];
  selectedProjectId: string | null;
  isLoading: boolean;
  error: Error | null;
  projectError: Error | null;
  onProjectChange: (projectId: string | null) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onSelectSession: (session: SessionCostSummary) => void;
}

function ownerLabel(session: SessionCostSummary): string {
  if (session.owner_name) return session.owner_name;
  if (session.owner_email) return session.owner_email;
  if (session.owner_type === 'unknown') return 'Unknown owner';
  return 'No owner';
}

function ownerTypeLabel(session: SessionCostSummary): string | null {
  if (session.owner_type === 'service_account') return 'Service';
  if (session.owner_type === 'user') return 'User';
  if (session.owner_type === 'unknown') return 'Unknown';
  return null;
}

function formatActivity(value: string | null): string {
  if (!value) return 'No billed activity';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SessionCostExplorerContent({
  data,
  projects,
  selectedProjectId,
  isLoading,
  error,
  projectError,
  onProjectChange,
  onPreviousPage,
  onNextPage,
  onSelectSession,
}: SessionCostExplorerContentProps) {
  if (error) {
    return (
      <InfoBanner tone="destructive" title="Failed to load session costs">
        {error.message}
      </InfoBanner>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-2" aria-label="Loading session costs">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const sessions = data?.sessions ?? [];
  const offset = data?.offset ?? 0;
  const total = data?.total ?? 0;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + sessions.length, total);
  const reconciliation = data?.reconciliation;
  const hasReconciliation = Boolean(
    reconciliation &&
    (reconciliation.total_cost !== 0 ||
      reconciliation.request_count !== 0 ||
      reconciliation.compute_window_count !== 0 ||
      reconciliation.compute_seconds !== 0),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Select
          value={selectedProjectId ?? 'all'}
          onValueChange={(value) => onProjectChange(value === 'all' ? null : value)}
        >
          <SelectTrigger className="h-8 w-[220px]" aria-label="Filter session costs by project">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.project_id} value={project.project_id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {projectError ? (
        <InfoBanner tone="warning" title="Project filter unavailable">
          {projectError.message}
        </InfoBanner>
      ) : null}

      {hasReconciliation && reconciliation ? (
        <InfoBanner tone="neutral" icon={ReceiptText} title="Unassigned costs">
          {formatSessionCostUsd(reconciliation.total_cost)} is not linked to an existing session.
          This includes {reconciliation.request_count.toLocaleString('en-US')} LLM request
          {reconciliation.request_count === 1 ? '' : 's'} and{' '}
          {reconciliation.compute_window_count.toLocaleString('en-US')} compute window
          {reconciliation.compute_window_count === 1 ? '' : 's'}.
        </InfoBanner>
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState
          size="sm"
          icon={ReceiptText}
          title="No session costs"
          description="Session cost records appear after sessions are created."
        />
      ) : (
        <div className="bg-popover overflow-hidden rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">LLM</TableHead>
                <TableHead className="text-right">Compute</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => {
                const ownerType = ownerTypeLabel(session);
                return (
                  <TableRow key={session.session_id}>
                    <TableCell className="max-w-[180px]">
                      <p className="truncate font-mono text-xs">{session.session_id}</p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {formatActivity(session.last_activity_at)}
                      </p>
                    </TableCell>
                    <TableCell className="max-w-[160px]">
                      <p className="truncate text-sm">{session.project_name}</p>
                    </TableCell>
                    <TableCell className="max-w-[180px]">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-sm">{ownerLabel(session)}</p>
                        {ownerType ? (
                          <Badge variant="outline" size="sm">
                            {ownerType}
                          </Badge>
                        ) : null}
                      </div>
                      {session.owner_email && session.owner_email !== session.owner_name ? (
                        <p className="text-muted-foreground mt-0.5 truncate text-xs">
                          {session.owner_email}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatSessionCostUsd(session.llm_cost)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatSessionCostUsd(session.compute_cost)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-medium tabular-nums">
                      {formatSessionCostUsd(session.total_cost)}
                    </TableCell>
                    <TableCell className="pr-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`View cost details for session ${session.session_id}`}
                        onClick={() => onSelectSession(session)}
                      >
                        <Eye className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {total > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs tabular-nums">
            Showing {start}-{end} of {total} sessions
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={onPreviousPage}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={data?.next_offset == null}
              onClick={onNextPage}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SessionCostExplorer() {
  const [filters, setFilters] = useState<{ projectId: string | null; offset: number }>({
    projectId: null,
    offset: 0,
  });
  const [selectedSession, setSelectedSession] = useState<SessionCostSummary | null>(null);
  const costsQuery = useSessionCosts({
    projectId: filters.projectId,
    limit: SESSION_COST_PAGE_SIZE,
    offset: filters.offset,
  });
  const projectsQuery = useSessionCostProjects();
  const detailQuery = useSessionCostDetail({
    projectId: selectedSession?.project_id ?? null,
    sessionId: selectedSession?.session_id ?? null,
  });

  return (
    <>
      <SessionCostExplorerContent
        data={costsQuery.data}
        projects={projectsQuery.data ?? []}
        selectedProjectId={filters.projectId}
        isLoading={costsQuery.isLoading}
        error={costsQuery.error instanceof Error ? costsQuery.error : null}
        projectError={projectsQuery.error instanceof Error ? projectsQuery.error : null}
        onProjectChange={(projectId) => setFilters({ projectId, offset: 0 })}
        onPreviousPage={() =>
          setFilters((current) => ({
            ...current,
            offset: Math.max(0, current.offset - SESSION_COST_PAGE_SIZE),
          }))
        }
        onNextPage={() =>
          setFilters((current) => ({
            ...current,
            offset: costsQuery.data?.next_offset ?? current.offset,
          }))
        }
        onSelectSession={setSelectedSession}
      />

      <Modal
        open={selectedSession !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedSession(null);
        }}
      >
        <ModalContent className="max-h-[85vh] lg:max-w-5xl">
          <ModalHeader className="sr-only">
            <ModalTitle>Session cost details</ModalTitle>
          </ModalHeader>
          <ModalBody className="pt-5">
            <SessionCostDetailContent
              detail={detailQuery.data}
              isLoading={detailQuery.isLoading}
              error={detailQuery.error instanceof Error ? detailQuery.error : null}
            />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
