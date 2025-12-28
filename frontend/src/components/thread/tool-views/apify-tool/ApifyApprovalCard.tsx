import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle2, XCircle, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApifyApproval } from '@/hooks/apify/use-apify-approvals';
import { useApproveApifyRequest, useGetApifyApprovalStatus } from '@/hooks/apify/use-apify-approvals';

interface ApifyApprovalCardProps {
  approval: ApifyApproval;
  threadId: string;
  onApproved?: () => void;
}

export function ApifyApprovalCard({ approval, threadId, onApproved }: ApifyApprovalCardProps) {
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

  const getStatusConfig = () => {
    switch (currentApproval.status) {
      case 'pending':
        return { icon: Clock, color: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Pending Approval' };
      case 'approved':
        return { icon: CheckCircle2, color: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Approved' };
      case 'rejected':
        return { icon: XCircle, color: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Rejected' };
      case 'expired':
        return { icon: AlertCircle, color: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Expired' };
      case 'executed':
        return { icon: CheckCircle2, color: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Executed' };
      default:
        return { icon: AlertCircle, color: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: currentApproval.status };
    }
  };

  const statusConfig = getStatusConfig();
  const StatusIcon = statusConfig.icon;

  const formatCredits = (credits?: number) => {
    if (!credits && credits !== 0) return '—';
    return credits % 1 === 0 ? credits.toString() : credits.toFixed(2).replace(/\.?0+$/, '');
  };

  const formatUSD = (usd?: number) => {
    if (!usd && usd !== 0) return '—';
    if (usd >= 1) return usd % 1 === 0 ? usd.toString() : usd.toFixed(2).replace(/\.?0+$/, '');
    return usd.toFixed(4).replace(/\.?0+$/, '');
  };

  return (
    <Card className={cn('border-2', statusConfig.borderColor, statusConfig.bgColor)}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={cn('p-2 rounded-lg', statusConfig.bgColor, statusConfig.borderColor, 'border')}>
              <StatusIcon className={cn('h-5 w-5', statusConfig.color)} />
            </div>
            <div>
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Apify Approval Request
              </CardTitle>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
                {currentApproval.actor_id}
              </p>
            </div>
          </div>
          <Badge variant="outline" className={cn(statusConfig.borderColor, statusConfig.color)}>
            {statusConfig.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Maximum Cost</p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
              {formatCredits(currentApproval.max_cost_usd ? currentApproval.max_cost_usd * 100 * 1.2 : 0)}
            </span>
            <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">credits</span>
          </div>
          {currentApproval.max_cost_usd && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">≈ ${formatUSD(currentApproval.max_cost_usd)} USD</p>
          )}
        </div>

        {currentApproval.estimated_cost_usd && currentApproval.estimated_cost_usd !== (currentApproval.max_cost_usd || currentApproval.estimated_cost_usd) && (
          <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-1.5">Estimated Cost</p>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-semibold text-zinc-700 dark:text-zinc-300 tabular-nums">
                {formatCredits(currentApproval.estimated_cost_credits)}
              </span>
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">credits</span>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">≈ ${formatUSD(currentApproval.estimated_cost_usd)} USD</span>
            </div>
          </div>
        )}

        {currentApproval.status === 'pending' && (
          <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800">
            <Button
              onClick={handleApprove}
              disabled={approveMutation.isPending}
              size="lg"
              className="w-full bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-medium shadow-sm"
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
        )}

        {currentApproval.status === 'approved' && (
          <div className="flex items-center gap-2 p-2.5 bg-zinc-100 dark:bg-zinc-800 rounded-md border border-zinc-200 dark:border-zinc-700">
            <CheckCircle2 className="h-4 w-4 text-zinc-900 dark:text-zinc-100 flex-shrink-0" />
            <p className="text-sm text-zinc-900 dark:text-zinc-100 font-medium">Approved – Actor can be executed</p>
          </div>
        )}

        {currentApproval.status === 'expired' && (
          <div className="flex items-center gap-2 p-2.5 bg-zinc-100 dark:bg-zinc-800 rounded-md border border-zinc-200 dark:border-zinc-700">
            <AlertCircle className="h-4 w-4 text-zinc-900 dark:text-zinc-100 flex-shrink-0" />
            <p className="text-sm text-zinc-900 dark:text-zinc-100 font-medium">Expired – Create a new approval request</p>
          </div>
        )}

        <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-1">
          {currentApproval.created_at && <p>Created: {new Date(currentApproval.created_at).toLocaleString()}</p>}
          {currentApproval.approved_at && <p>Approved: {new Date(currentApproval.approved_at).toLocaleString()}</p>}
          {currentApproval.expires_at && <p>Expires: {new Date(currentApproval.expires_at).toLocaleString()}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
