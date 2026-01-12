import React, { useState } from 'react';
import { View, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import {
  AlertCircle,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react-native';
import { ToolViewProps } from '../types';
import { ToolViewCard } from '../shared/ToolViewCard';
import { ApifyApproval } from '@/api/apify-approvals';
import { useApproveApifyRequest, useGetApifyApprovalStatus } from '@/hooks/apify/use-apify-approvals';
import { log } from '@/lib/logger';

export function ApifyApprovalView({
  toolCall,
  toolResult,
  threadId,
  isSuccess = true,
}: ToolViewProps) {
  const [initialApproval, setInitialApproval] = useState<ApifyApproval | null>(null);

  React.useEffect(() => {
    if (toolResult?.output) {
      try {
        const output = typeof toolResult.output === 'string' 
          ? JSON.parse(toolResult.output) 
          : toolResult.output;
        
        if (output.approval_id) {
          setInitialApproval({
            approval_id: output.approval_id,
            status: output.status || 'pending',
            actor_id: output.actor_id || '',
            estimated_cost_usd: output.estimated_cost_usd,
            estimated_cost_credits: output.estimated_cost_credits,
            max_cost_usd: output.max_cost_usd,
            actual_cost_usd: output.actual_cost_usd,
            actual_cost_credits: output.actual_cost_credits,
            run_id: output.run_id,
            created_at: output.created_at,
            approved_at: output.approved_at,
            expires_at: output.expires_at,
            message: output.message,
          });
        }
      } catch (error) {
        log.error('Error parsing approval data:', error);
      }
    }
  }, [toolResult]);

  const approveMutation = useApproveApifyRequest(threadId || '');
  const { data: updatedApproval } = useGetApifyApprovalStatus(
    initialApproval?.approval_id || null,
    threadId || ''
  );
  
  const currentApproval = updatedApproval || initialApproval;

  const handleApprove = async () => {
    if (!currentApproval || !threadId) {
      Alert.alert('Error', 'Missing approval or thread ID');
      return;
    }

    try {
      await approveMutation.mutateAsync(currentApproval.approval_id);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to approve request');
    }
  };

  const getStatusConfig = () => {
    if (!currentApproval) return null;
    switch (currentApproval.status) {
      case 'pending':
        return { icon: Clock, iconColor: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Pending Approval' };
      case 'approved':
        return { icon: CheckCircle2, iconColor: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Approved' };
      case 'rejected':
        return { icon: XCircle, iconColor: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Rejected' };
      case 'expired':
        return { icon: AlertCircle, iconColor: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Expired' };
      case 'executed':
        return { icon: CheckCircle2, iconColor: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: 'Executed' };
      default:
        return { icon: AlertCircle, iconColor: 'text-zinc-900 dark:text-zinc-100', bgColor: 'bg-zinc-50 dark:bg-zinc-900/20', borderColor: 'border-zinc-300 dark:border-zinc-700', label: currentApproval.status };
    }
  };

  if (!currentApproval) {
    return (
      <ToolViewCard
        header={{
          icon: AlertCircle,
          iconColor: 'text-zinc-600',
          iconBgColor: 'bg-zinc-100 dark:bg-zinc-800',
          subtitle: 'Apify Approval',
          title: 'Approval Request',
          isSuccess: false,
          showStatus: true,
        }}
      >
        <View className="flex-1 items-center justify-center px-6 py-12">
          <Text className="text-sm text-muted-foreground text-center">No approval data available</Text>
        </View>
      </ToolViewCard>
    );
  }

  const statusConfig = getStatusConfig();
  const StatusIcon = statusConfig?.icon || AlertCircle;

  const formatCredits = (credits?: number) => {
    if (!credits && credits !== 0) return '—';
    return credits % 1 === 0 ? credits.toString() : credits.toFixed(2).replace(/\.?0+$/, '');
  };

  const formatUSD = (usd?: number) => {
    if (!usd && usd !== 0) return '—';
    if (usd >= 1) return usd % 1 === 0 ? usd.toString() : usd.toFixed(2).replace(/\.?0+$/, '');
    return usd.toFixed(4).replace(/\.?0+$/, '');
  };

  const maxCostUsd = currentApproval?.max_cost_usd || currentApproval?.estimated_cost_usd || 0;
  const maxCostCredits = maxCostUsd * 100 * 1.2;

  return (
    <ToolViewCard
      header={{
        icon: StatusIcon,
        iconColor: statusConfig?.iconColor || 'text-zinc-600',
        iconBgColor: statusConfig?.bgColor || 'bg-zinc-100 dark:bg-zinc-800',
        subtitle: 'Apify Approval',
        title: 'Approval Request',
        isSuccess: currentApproval.status === 'approved' || currentApproval.status === 'executed',
        showStatus: true,
      }}
    >
      <ScrollView className="flex-1" showsVerticalScrollIndicator={true}>
        <View className="gap-4 p-4">
          <View className="gap-2">
            <Text className="px-1 font-roobert-medium text-xs uppercase tracking-wider text-primary opacity-60">Actor ID</Text>
            <View className="rounded-xl border border-border bg-card p-4">
              <Text className="font-roobert-mono text-xs leading-5 text-primary" selectable>{currentApproval.actor_id}</Text>
            </View>
          </View>

          <View className="gap-3">
            <Text className="px-1 font-roobert-medium text-xs uppercase tracking-wider text-primary opacity-60">Maximum Cost</Text>
            <View className="gap-2">
              <View className="flex-row items-baseline gap-2">
                <Text className="text-4xl font-roobert-bold text-primary">{formatCredits(maxCostCredits)}</Text>
                <Text className="text-sm font-roobert-medium text-muted-foreground">credits</Text>
              </View>
              {currentApproval.max_cost_usd && (
                <Text className="text-xs text-muted-foreground">≈ ${formatUSD(currentApproval.max_cost_usd)} USD</Text>
              )}
            </View>
          </View>

          {currentApproval.estimated_cost_usd && currentApproval.estimated_cost_usd !== (currentApproval.max_cost_usd || currentApproval.estimated_cost_usd) && (
            <View className="gap-2 pt-2 border-t border-border">
              <Text className="px-1 font-roobert-medium text-xs uppercase tracking-wider text-primary opacity-60">Estimated Cost</Text>
              <View className="flex-row items-baseline gap-2">
                <Text className="text-2xl font-roobert-semibold text-primary">{formatCredits(currentApproval.estimated_cost_credits)}</Text>
                <Text className="text-xs font-roobert-medium text-muted-foreground">credits</Text>
                <Text className="text-xs text-muted-foreground">≈ ${formatUSD(currentApproval.estimated_cost_usd)} USD</Text>
              </View>
            </View>
          )}

          <View className="flex-row items-center gap-2">
            <Badge variant="outline" className={statusConfig?.borderColor}>
              <Text className={`text-xs font-roobert-medium ${statusConfig?.iconColor}`}>{statusConfig?.label}</Text>
            </Badge>
          </View>

          {currentApproval.message && (
            <View className="rounded-xl border border-border bg-card p-4">
              <Text className="text-sm text-primary">{currentApproval.message}</Text>
            </View>
          )}

          {currentApproval.status === 'pending' && (
            <View className="gap-2 pt-3 border-t border-border">
              <Button onPress={handleApprove} disabled={approveMutation.isPending} className="bg-zinc-900 dark:bg-zinc-100">
                {approveMutation.isPending ? (
                  <View className="flex-row items-center gap-2">
                    <ActivityIndicator size="small" color="white" />
                    <Text className="text-white dark:text-zinc-900 font-roobert-semibold">Approving...</Text>
                  </View>
                ) : (
                  <View className="flex-row items-center gap-2">
                    <Icon as={CheckCircle2} size={16} className="text-white dark:text-zinc-900" />
                    <Text className="text-white dark:text-zinc-900 font-roobert-semibold">Approve Spending</Text>
                  </View>
                )}
              </Button>
            </View>
          )}

          {currentApproval.status === 'approved' && (
            <View className="flex-row items-center gap-2 p-3 bg-zinc-100 dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
              <Icon as={CheckCircle2} size={16} className="text-primary" />
              <Text className="text-sm font-roobert-medium text-primary flex-1">Approved – Actor can be executed</Text>
            </View>
          )}

          {currentApproval.status === 'expired' && (
            <View className="flex-row items-center gap-2 p-3 bg-zinc-100 dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
              <Icon as={AlertCircle} size={16} className="text-primary" />
              <Text className="text-sm font-roobert-medium text-primary flex-1">Expired – Create a new approval request</Text>
            </View>
          )}

          <View className="gap-1">
            {currentApproval.created_at && <Text className="text-xs text-muted-foreground">Created: {new Date(currentApproval.created_at).toLocaleString()}</Text>}
            {currentApproval.approved_at && <Text className="text-xs text-muted-foreground">Approved: {new Date(currentApproval.approved_at).toLocaleString()}</Text>}
            {currentApproval.expires_at && <Text className="text-xs text-muted-foreground">Expires: {new Date(currentApproval.expires_at).toLocaleString()}</Text>}
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
