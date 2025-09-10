'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import {
  User,
  CreditCard,
  History,
  DollarSign,
  Calendar,
  Activity,
  AlertCircle,
  CheckCircle,
  RefreshCw,
  Clock,
  Infinity,
} from 'lucide-react';
import { useAdminUserDetails } from '@/hooks/react-query/admin/use-admin-users';
import {
  useUserBillingSummary,
  useAdjustCredits,
  useProcessRefund,
} from '@/hooks/react-query/admin/use-admin-billing';
import type { UserSummary } from '@/hooks/react-query/admin/use-admin-users';

interface AdminUserDetailsDialogProps {
  user: UserSummary | null;
  isOpen: boolean;
  onClose: () => void;
  onRefresh?: () => void;
}

export function AdminUserDetailsDialog({
  user,
  isOpen,
  onClose,
  onRefresh,
}: AdminUserDetailsDialogProps) {
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [adjustIsExpiring, setAdjustIsExpiring] = useState(true);
  const [refundIsExpiring, setRefundIsExpiring] = useState(false);

  const { data: userDetails, isLoading } = useAdminUserDetails(user?.id || null);
  const { data: billingSummary, refetch: refetchBilling } = useUserBillingSummary(user?.id || null);
  const adjustCreditsMutation = useAdjustCredits();
  const processRefundMutation = useProcessRefund();

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatCurrency = (amount: number) => {
    return `$${amount.toFixed(2)}`;
  };

  const handleAdjustCredits = async () => {
    if (!user || !adjustAmount || !adjustReason) {
      toast.error('Please fill in all fields');
      return;
    }

    try {
      const result = await adjustCreditsMutation.mutateAsync({
        account_id: user.id,
        amount: parseFloat(adjustAmount),
        reason: adjustReason,
        notify_user: true,
        is_expiring: adjustIsExpiring,
      });

      toast.success(
        `Credits adjusted successfully. New balance: ${formatCurrency(result.new_balance)}`
      );

      refetchBilling();
      onRefresh?.();
      setAdjustAmount('');
      setAdjustReason('');
      setAdjustIsExpiring(true);
    } catch (error: any) {
      toast.error(error.message || 'Failed to adjust credits');
    }
  };

  const handleProcessRefund = async () => {
    if (!user || !refundAmount || !refundReason) {
      toast.error('Please fill in all fields');
      return;
    }

    try {
      const result = await processRefundMutation.mutateAsync({
        account_id: user.id,
        amount: parseFloat(refundAmount),
        reason: refundReason,
        stripe_refund: false,
        is_expiring: refundIsExpiring,
      });

      toast.success(
        `Refund processed. New balance: ${formatCurrency(result.new_balance)}`
      );

      refetchBilling();
      onRefresh?.();

      setRefundAmount('');
      setRefundReason('');
      setRefundIsExpiring(false);
    } catch (error: any) {
      toast.error(error.message || 'Failed to process refund');
    }
  };

  const getTierBadgeVariant = (tier: string) => {
    switch (tier.toLowerCase()) {
      case 'pro':
        return 'default';
      case 'premium':
        return 'secondary';
      case 'free':
        return 'outline';
      default:
        return 'outline';
    }
  };

  const getSubscriptionBadgeVariant = (status?: string) => {
    switch (status) {
      case 'active':
        return 'default';
      case 'cancelled':
        return 'destructive';
      case 'past_due':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  const getTransactionColor = (type: string) => {
    switch (type) {
      case 'usage':
        return 'text-red-600';
      case 'admin_grant':
        return 'text-green-600';
      case 'tier_grant':
        return 'text-blue-600';
      case 'purchase':
        return 'text-purple-600';
      case 'refund':
        return 'text-orange-600';
      default:
        return 'text-muted-foreground';
    }
  };

  if (!user) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            User Details - {user.email}
          </DialogTitle>
          <DialogDescription>
            Manage user account, billing, and perform admin actions
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-4 p-1">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <Tabs defaultValue="overview" className="w-full">
              <TabsList className="grid w-full grid-cols-4 sticky top-0 z-10">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="transactions">Transactions</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="actions">Admin Actions</TabsTrigger>
              </TabsList>

            <TabsContent value="overview" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      Account Info
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Email</p>
                      <p className="font-mono text-sm">{user.email}</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">User ID</p>
                      <p className="font-mono text-xs">{user.id}</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Joined</p>
                      <p className="text-sm">{formatDate(user.created_at)}</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Tier</p>
                      <Badge variant={getTierBadgeVariant(user.tier)} className="capitalize">
                        {user.tier}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CreditCard className="h-4 w-4" />
                      Credit Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Current Balance</p>
                      <p className="text-2xl font-bold text-green-600">
                        {formatCurrency(user.credit_balance)}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Purchased</p>
                        <p className="font-medium">{formatCurrency(user.total_purchased)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Used</p>
                        <p className="font-medium">{formatCurrency(user.total_used)}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Subscription</p>
                      <Badge
                        variant={getSubscriptionBadgeVariant(user.subscription_status)}
                        className="capitalize"
                      >
                        {user.subscription_status || 'None'}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="transactions" className="space-y-4">
              {billingSummary && (
                <Card className='border-0 shadow-none bg-transparent'>
                  <CardContent className='p-0'>
                    <div className="space-y-2">
                      {billingSummary.recent_transactions?.length > 0 ? (
                        billingSummary.recent_transactions.map((transaction: any) => (
                          <div
                            key={transaction.id}
                            className="flex items-center justify-between p-3 border rounded-lg"
                          >
                            <div>
                              <p className="text-sm font-medium">{transaction.description}</p>
                              <p className="text-xs text-muted-foreground">
                                {formatDate(transaction.created_at)}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className={`font-semibold ${getTransactionColor(transaction.type)}`}>
                                {transaction.amount > 0 ? '+' : ''}
                                {formatCurrency(Math.abs(transaction.amount))}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Balance: {formatCurrency(transaction.balance_after)}
                              </p>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">No recent transactions</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="activity" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    Recent Activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {userDetails?.recent_activity?.length > 0 ? (
                    <div className="space-y-2">
                      {userDetails.recent_activity.map((activity) => (
                        <div
                          key={activity.id}
                          className="flex items-center justify-between p-3 border rounded-lg"
                        >
                          <div>
                            <p className="text-sm font-medium">Agent Run</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(activity.created_at)} • Thread {activity.thread_id.slice(-8)}
                            </p>
                          </div>
                          <Badge
                            variant={activity.status === 'completed' ? 'default' : 'secondary'}
                          >
                            {activity.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No recent activity</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="actions" className="space-y-4">
              <div className="grid grid-cols-1 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CreditCard className="h-4 w-4" />
                      Process Refund
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="p-3 border border-red-200 dark:border-red-950 bg-red-50 dark:bg-red-950/20 rounded-lg">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" />
                        <p className="text-sm text-red-700">
                          Refunds assigns credits back to the user's account.
                        </p>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="refund-amount">Refund Amount (USD)</Label>
                      <Input
                        id="refund-amount"
                        type="number"
                        step="0.01"
                        placeholder="50.00"
                        value={refundAmount}
                        onChange={(e) => setRefundAmount(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor="refund-reason mb-2">Refund Reason</Label>
                      <Textarea
                        id="refund-reason"
                        placeholder="Service outage compensation"
                        value={refundReason}
                        onChange={(e) => setRefundReason(e.target.value)}
                        rows={3}
                      />
                    </div>
                    <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
                      <div className="flex items-center gap-2">
                        <Label htmlFor="refund-expiring" className="cursor-pointer flex items-center gap-2">
                          {refundIsExpiring ? (
                            <Clock className="h-4 w-4 text-orange-500" />
                          ) : (
                            <Infinity className="h-4 w-4 text-blue-500" />
                          )}
                          <span className="font-medium">
                            {refundIsExpiring ? 'Expiring Credits' : 'Non-Expiring Credits'}
                          </span>
                        </Label>
                      </div>
                      <Switch
                        id="refund-expiring"
                        checked={!refundIsExpiring}
                        onCheckedChange={(checked) => setRefundIsExpiring(!checked)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground -mt-2">
                      {refundIsExpiring 
                        ? 'Credits will expire at the end of the billing cycle'
                        : 'Refunds typically use non-expiring credits (recommended)'}
                    </p>
                    <Button
                      onClick={handleProcessRefund}
                      disabled={processRefundMutation.isPending}
                      variant="destructive"
                      className="w-full"
                    >
                      {processRefundMutation.isPending ? (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        'Process Refund'
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </Tabs>
          )}
        </div>

        <DialogFooter className="flex-shrink-0">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
} 