'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DollarSign, Users, Activity, CreditCard, Loader2, AlertCircle, Plus, Settings, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useAdminCheck } from '@/hooks/use-admin-check';
import UsageLogs from '@/components/billing/usage-logs';

export default function AdminPage() {
  const queryClient = useQueryClient();
  const { data: adminCheck, isLoading: adminLoading, error: adminError } = useAdminCheck();
  
  // Get enterprise status
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['enterprise-status'],
    queryFn: async () => {
      const response = await apiClient.request('/enterprise/status');
      return response.data;
    },
    enabled: !!adminCheck?.isAdmin
  });
  
  // Get all users
  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ['enterprise-users'],
    queryFn: async () => {
      const response = await apiClient.request('/enterprise/users?items_per_page=100');
      return response.data;
    },
    enabled: !!adminCheck?.isAdmin
  });
  
  // Get global defaults
  const { data: globalDefaults, isLoading: globalDefaultsLoading } = useQuery({
    queryKey: ['global-defaults'],
    queryFn: async () => {
      const response = await apiClient.request('/enterprise/global-defaults');
      return response.data;
    },
    enabled: !!adminCheck?.isAdmin
  });
  
  // Loading states
  if (adminLoading || statusLoading || usersLoading || globalDefaultsLoading) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }
  
  // Check admin access
  if (!adminCheck?.isAdmin) {
    return (
      <div className="container mx-auto py-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center text-center">
              <AlertCircle className="h-12 w-12 text-destructive mb-4" />
              <h2 className="text-2xl font-bold mb-2">Access Denied</h2>
              <p className="text-muted-foreground">
                You don\'t have permission to access this page.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
  
  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Enterprise Admin</h1>
          <p className="text-muted-foreground">Manage enterprise billing and user limits</p>
        </div>
        {adminCheck?.isOmniAdmin && <LoadCreditsButton />}
      </div>
      
      {/* Global Defaults */}
      <GlobalDefaultsCard globalDefaults={globalDefaults} />
      
      {/* Enterprise Status */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Credit Balance</CardTitle>
            <DollarSign className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${status?.credit_balance?.toFixed(2) || '0.00'}</div>
            <p className="text-xs text-muted-foreground">Available credits</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status?.total_users || 0}</div>
            <p className="text-xs text-muted-foreground">Active users</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Usage</CardTitle>
            <Activity className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${status?.total_monthly_usage?.toFixed(2) || '0.00'}</div>
            <p className="text-xs text-muted-foreground">This month</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Loaded</CardTitle>
            <CreditCard className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${status?.total_loaded?.toFixed(2) || '0.00'}</div>
            <p className="text-xs text-muted-foreground">All time</p>
          </CardContent>
        </Card>
      </div>
      
      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
        </CardHeader>
        <CardContent>
          {users?.users && users.users.length > 0 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-5 gap-4 text-sm font-medium text-muted-foreground border-b pb-2">
                <div>Account</div>
                <div className="text-right">Monthly Limit</div>
                <div className="text-right">Used This Month</div>
                <div className="text-right">Remaining</div>
                <div className="text-right">Actions</div>
              </div>
              {users.users.map((user: any) => (
                <UserRow key={user.account_id} user={user} />
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No users found
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UserRow({ user }: { user: any }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const remaining = user.monthly_limit - user.current_month_usage;
  const usagePercent = (user.current_month_usage / user.monthly_limit) * 100;
  
  return (
    <>
      <div className="grid grid-cols-5 gap-4 items-center py-2 hover:bg-muted/50 rounded-lg px-2">
        <div className="font-medium">
          {user.account_info?.name || 'Unnamed Account'}
          <div className="text-xs text-muted-foreground">
            {user.account_info?.personal_account ? 'Personal' : 'Team'}
          </div>
        </div>
        <div className="text-right">${user.monthly_limit?.toFixed(2)}</div>
        <div className="text-right">
          ${user.current_month_usage?.toFixed(2)}
          <div className="mt-1 h-2 bg-secondary rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all ${
                usagePercent > 90 ? 'bg-red-500' : 
                usagePercent > 75 ? 'bg-orange-500' : 
                'bg-green-500'
              }`}
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
        </div>
        <div className={`text-right ${remaining < 0 ? 'text-red-500' : ''}`}>
          ${remaining.toFixed(2)}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDetailsOpen(true)}
          >
            View Details
          </Button>
          <SetLimitButton user={user} />
        </div>
      </div>
      
      {/* User Details Dialog */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{user.account_info?.name || 'User'} - Usage Details</DialogTitle>
          </DialogHeader>
          <UserDetails accountId={user.account_id} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function UserDetails({ accountId }: { accountId: string }) {
  const { data: details, isLoading } = useQuery({
    queryKey: ['user-details', accountId],
    queryFn: async () => {
      const response = await apiClient.request(`/enterprise/users/${accountId}`);
      return response.data;
    }
  });
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Monthly Limit</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">${details?.monthly_limit?.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Used This Month</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">${details?.current_month_usage?.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Remaining</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">${details?.remaining_monthly?.toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>Daily Usage Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageLogs accountId={accountId} />
        </CardContent>
      </Card>
    </div>
  );
}

function LoadCreditsButton() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(0);
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();
  
  const loadMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await apiClient.request('/enterprise/load-credits', {
        method: 'POST',
        body: JSON.stringify(data)
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['enterprise-status'] });
      queryClient.invalidateQueries({ queryKey: ['enterprise-users'] });
      toast.success(`Loaded $${amount} credits successfully!`);
      setOpen(false);
      setAmount(0);
      setDescription('');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to load credits');
    }
  });
  
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Load Credits
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Load Credits</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="amount">Amount ($)</Label>
            <Input
              id="amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
              placeholder="1000.00"
              required
            />
          </div>
          <div>
            <Label htmlFor="description">Description (Optional)</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Manual credit load"
            />
          </div>
          <Button 
            onClick={() => loadMutation.mutate({ amount, description })}
            disabled={amount <= 0 || loadMutation.isPending}
            className="w-full"
          >
            {loadMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading...
              </>
            ) : (
              `Load $${amount.toFixed(2)}`
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SetLimitButton({ user }: { user: any }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(user.monthly_limit);
  const queryClient = useQueryClient();
  
  const setLimitMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await apiClient.request(`/enterprise/users/${user.account_id}/limit`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['enterprise-users'] });
      toast.success('Monthly limit updated!');
      setOpen(false);
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to update limit');
    }
  });
  
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings className="h-3 w-3" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set Monthly Limit - {user.accounts?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="limit">Monthly Limit ($)</Label>
            <Input
              id="limit"
              type="number"
              min="0"
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(parseFloat(e.target.value) || 0)}
              placeholder="1000.00"
              required
            />
            <p className="text-sm text-muted-foreground mt-1">
              Current usage: ${user.current_month_usage?.toFixed(2)}
            </p>
          </div>
          <Button 
            onClick={() => setLimitMutation.mutate({ 
              account_id: user.account_id, 
              monthly_limit: limit 
            })}
            disabled={limit < 0 || setLimitMutation.isPending}
            className="w-full"
          >
            {setLimitMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Updating...
              </>
            ) : (
              'Update Limit'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GlobalDefaultsCard({ globalDefaults }: { globalDefaults: any }) {
  const [editOpen, setEditOpen] = useState(false);
  const [newLimit, setNewLimit] = useState(globalDefaults?.default_monthly_limit || 1000);
  const queryClient = useQueryClient();
  
  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await apiClient.post('/enterprise/global-defaults', data);
      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to update global default');
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['global-defaults'] });
      queryClient.invalidateQueries({ queryKey: ['enterprise-status'] });
      queryClient.invalidateQueries({ queryKey: ['enterprise-users'] });
      toast.success(`Global default limit updated to $${newLimit}`);
      setEditOpen(false);
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to update global default');
    }
  });

  // Update local state when data changes
  React.useEffect(() => {
    if (globalDefaults?.default_monthly_limit) {
      setNewLimit(globalDefaults.default_monthly_limit);
    }
  }, [globalDefaults]);

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Global Default Settings</CardTitle>
            <p className="text-sm text-muted-foreground">
              Default monthly limit applied to all new users
            </p>
          </div>
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Settings className="h-4 w-4 mr-2" />
                Edit Default
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Set Global Default Monthly Limit</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="globalLimit">Default Monthly Limit ($)</Label>
                  <Input
                    id="globalLimit"
                    type="number"
                    min="0"
                    step="0.01"
                    value={newLimit}
                    onChange={(e) => setNewLimit(parseFloat(e.target.value) || 0)}
                    placeholder="1000.00"
                    required
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    This limit will be applied to all new users by default
                  </p>
                </div>
                <Button 
                  onClick={() => updateMutation.mutate({ monthly_limit: newLimit })}
                  disabled={newLimit <= 0 || updateMutation.isPending}
                  className="w-full"
                >
                  {updateMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Updating...
                    </>
                  ) : (
                    `Set Default to $${newLimit.toFixed(2)}`
                  )}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <div className="text-2xl font-bold">
              ${globalDefaults?.default_monthly_limit?.toFixed(2) || '1000.00'}
            </div>
            <p className="text-xs text-muted-foreground">Current Default Limit</p>
          </div>
          <div>
            <div className="text-sm">
              {globalDefaults?.setting_details?.updated_at 
                ? new Date(globalDefaults.setting_details.updated_at).toLocaleDateString()
                : 'Not set'
              }
            </div>
            <p className="text-xs text-muted-foreground">Last Updated</p>
          </div>
          <div>
            <div className="text-sm">
              {globalDefaults?.setting_details?.description || 'Default monthly spending limit for new enterprise users'}
            </div>
            <p className="text-xs text-muted-foreground">Description</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}