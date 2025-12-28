import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Clock, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { ApifyApproval } from '@/hooks/apify/use-apify-approvals';
import { useApproveApifyRequest, useGetApifyApprovalStatus } from '@/hooks/apify/use-apify-approvals';

interface ApifyApprovalInlineProps {
  approval: ApifyApproval;
  threadId: string;
  onApproved?: () => void;
}

export function ApifyApprovalInline({ approval, threadId, onApproved }: ApifyApprovalInlineProps) {
  const approveMutation = useApproveApifyRequest(threadId);
  const { data: updatedApproval } = useGetApifyApprovalStatus(approval.approval_id, threadId);
  
  const currentApproval = updatedApproval || approval;

  const handleApprove = async () => {
    try {
      await approveMutation.mutateAsync(approval.approval_id);
      onApproved?.();
    } catch (error) {
      // handled by mutation
    }
  };

  const formatCredits = (credits?: number) => {
    if (!credits && credits !== 0) return '—';
    return credits % 1 === 0 ? credits.toString() : credits.toFixed(2).replace(/\.?0+$/, '');
  };

  const formatUSD = (usd?: number) => {
    if (!usd && usd !== 0) return '—';
    if (usd >= 1) return usd % 1 === 0 ? usd.toString() : usd.toFixed(2).replace(/\.?0+$/, '');
    return usd.toFixed(4).replace(/\.?0+$/, '');
  };

  const maxCostUsd = currentApproval.max_cost_usd || currentApproval.estimated_cost_usd || 0;
  const maxCostCredits = currentApproval.estimated_cost_credits || (maxCostUsd * 100 * 1.2);

  if (currentApproval.status === 'approved') {
    return (
      <div className="my-2 p-2.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-zinc-900 dark:text-zinc-100 flex-shrink-0" />
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Approved – Actor can be executed</span>
        </div>
      </div>
    );
  }

  if (currentApproval.status === 'expired') {
    return (
      <div className="my-2 p-2.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-zinc-900 dark:text-zinc-100 flex-shrink-0" />
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Expired – Create a new approval request</span>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/50">
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-zinc-200 dark:bg-zinc-700">
              <Clock className="h-3.5 w-3.5 text-zinc-900 dark:text-zinc-100" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{currentApproval.actor_id}</p>
            </div>
          </div>
          <Badge variant="outline" className="border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 text-xs font-medium px-2 py-0.5">
            Approval Required
          </Badge>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">{formatCredits(maxCostCredits)}</span>
            <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">credits</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-500 ml-1">(max)</span>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">≈ ${formatUSD(maxCostUsd)} USD</p>
          {currentApproval.estimated_cost_usd && currentApproval.estimated_cost_usd !== maxCostUsd && (
            <div className="pt-1.5 mt-1.5 border-t border-zinc-200 dark:border-zinc-700">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm text-zinc-600 dark:text-zinc-400">Est:</span>
                <span className="text-base font-semibold text-zinc-700 dark:text-zinc-300 tabular-nums">{formatCredits(currentApproval.estimated_cost_credits)}</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-500">credits ≈ ${formatUSD(currentApproval.estimated_cost_usd)}</span>
              </div>
            </div>
          )}
        </div>

        <Button
          onClick={handleApprove}
          disabled={approveMutation.isPending}
          className="w-full bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-medium shadow-sm"
          size="default"
        >
          {approveMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Approving...
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Approve Spending
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
