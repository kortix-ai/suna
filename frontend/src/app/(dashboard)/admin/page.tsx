'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Loader2, Plus, CreditCard, DollarSign, Users, Activity, AlertCircle } from 'lucide-react';
import { useAdminCheck } from '@/hooks/use-admin-check';

export default function SimpleAdminPage() {
  const queryClient = useQueryClient();
  const { data: isAdmin, isLoading: adminLoading, error: adminError } = useAdminCheck();

  // Get enterprise accounts
  const { data: enterprises, isLoading: enterprisesLoading } = useQuery({
    queryKey: ['enterprises'],
    queryFn: async () => {
      const response = await apiClient.request('/enterprise/accounts');
      return response.data || [];
    },
    enabled: !!isAdmin
  });

  // Loading states
  if (adminLoading || enterprisesLoading) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  // Access denied
  if (adminError || !isAdmin) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <Card className="max-w-md">
            <CardContent className="pt-6 text-center">
              <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-red-600 mb-2">Access Denied</h2>
              <p className="text-muted-foreground">
                You need admin access to view this page. Contact your system administrator.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Enterprise Admin</h1>
          <p className="text-muted-foreground">Simple enterprise billing management</p>
        </div>
        <CreateAccountButton />
      </div>

      {/* Enterprise Accounts */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {enterprises?.map((enterprise: any) => (
          <EnterpriseCard key={enterprise.id} enterprise={enterprise} />
        ))}
        {(!enterprises || enterprises.length === 0) && (
          <Card className="col-span-full">
            <CardContent className="pt-6 text-center">
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Enterprise Accounts</h3>
              <p className="text-muted-foreground mb-4">
                Create your first enterprise account to get started.
              </p>
              <CreateAccountButton />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Quick Help */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Help</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 text-sm">
            <div>
              <p className="font-medium">1. Create Enterprise Account</p>
              <p className="text-muted-foreground">Start by creating an enterprise account for a company</p>
            </div>
            <div>
              <p className="font-medium">2. Load Credits</p>
              <p className="text-muted-foreground">Add credits to the enterprise account that users will draw from</p>
            </div>
            <div>
              <p className="font-medium">3. Add Users</p>
              <p className="text-muted-foreground">Use the admin API to add user accounts to the enterprise billing</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function EnterpriseCard({ enterprise }: { enterprise: any }) {
  const [usageOpen, setUsageOpen] = useState(false);
  
  const { data: usage } = useQuery({
    queryKey: ['usage', enterprise.id],
    queryFn: async () => {
      const response = await apiClient.request(`/enterprise/usage/${enterprise.id}?page=0&items_per_page=5`);
      return response.data;
    },
    enabled: usageOpen
  });

  return (
    <Card className="relative">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="truncate">{enterprise.name}</span>
          <span className={`px-2 py-1 rounded-full text-xs font-medium ${
            enterprise.is_active 
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' 
              : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
          }`}>
            {enterprise.is_active ? 'Active' : 'Inactive'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Key metrics */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-green-600" />
            <div className="text-sm">
              <p className="font-semibold">${enterprise.credit_balance?.toFixed(2) || '0.00'}</p>
              <p className="text-muted-foreground">Balance</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-blue-600" />
            <div className="text-sm">
              <p className="font-semibold">{enterprise.member_count || 0}</p>
              <p className="text-muted-foreground">Users</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-orange-600" />
            <div className="text-sm">
              <p className="font-semibold">${enterprise.total_used?.toFixed(2) || '0.00'}</p>
              <p className="text-muted-foreground">Used</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-purple-600" />
            <div className="text-sm">
              <p className="font-semibold">${enterprise.total_loaded?.toFixed(2) || '0.00'}</p>
              <p className="text-muted-foreground">Loaded</p>
            </div>
          </div>
        </div>
        
        {/* Action buttons */}
        <div className="flex gap-2">
          <LoadCreditsButton enterprise={enterprise} />
          <Button 
            variant="outline" 
            size="sm" 
            className="flex-1"
            onClick={() => setUsageOpen(!usageOpen)}
          >
            {usageOpen ? 'Hide' : 'Show'} Usage
          </Button>
        </div>

        {/* Usage details */}
        {usageOpen && usage && (
          <div className="mt-4 p-3 bg-muted rounded-lg">
            <h4 className="font-medium mb-2">Recent Usage</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Monthly Usage:</span>
                <span className="font-medium">${usage.total_monthly_usage?.toFixed(2) || '0.00'}</span>
              </div>
              <div className="flex justify-between">
                <span>Monthly Limit:</span>
                <span className="font-medium">${usage.total_monthly_limit?.toFixed(2) || '0.00'}</span>
              </div>
              <div className="flex justify-between">
                <span>Remaining:</span>
                <span className="font-medium text-green-600">
                  ${usage.remaining_monthly_budget?.toFixed(2) || '0.00'}
                </span>
              </div>
              {usage.members?.slice(0, 3).map((member: any) => (
                <div key={member.account_id} className="flex justify-between text-xs">
                  <span className="truncate">{member.accounts?.name || 'User'}</span>
                  <span>${member.current_month_usage?.toFixed(2) || '0.00'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreateAccountButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [credits, setCredits] = useState(0);
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await apiClient.request('/enterprise/accounts', {
        method: 'POST',
        body: JSON.stringify(data)
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['enterprises'] });
      toast.success('Enterprise account created!');
      setOpen(false);
      setName('');
      setCredits(0);
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to create account');
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          New Account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Enterprise Account</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="name">Company Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              required
            />
          </div>
          <div>
            <Label htmlFor="credits">Initial Credits ($)</Label>
            <Input
              id="credits"
              type="number"
              min="0"
              step="0.01"
              value={credits}
              onChange={(e) => setCredits(parseFloat(e.target.value) || 0)}
              placeholder="1000"
            />
          </div>
          <Button 
            onClick={() => createMutation.mutate({ 
              name, 
              initial_credits: credits,
              description: `Enterprise account for ${name}` 
            })}
            disabled={!name || createMutation.isPending}
            className="w-full"
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Creating...
              </>
            ) : (
              'Create Account'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LoadCreditsButton({ enterprise }: { enterprise: any }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(0);
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
      queryClient.invalidateQueries({ queryKey: ['enterprises'] });
      queryClient.invalidateQueries({ queryKey: ['usage'] });
      toast.success(`Loaded $${amount} to ${enterprise.name}`);
      setOpen(false);
      setAmount(0);
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to load credits');
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="flex-1">
          <CreditCard className="h-4 w-4 mr-1" />
          Load Credits
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Load Credits - {enterprise.name}</DialogTitle>
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
              placeholder="500"
              required
            />
          </div>
          <Button 
            onClick={() => loadMutation.mutate({ 
              enterprise_id: enterprise.id, 
              amount, 
              description: `Manual credit load by admin - $${amount}` 
            })}
            disabled={amount <= 0 || loadMutation.isPending}
            className="w-full"
          >
            {loadMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading...
              </>
            ) : (
              `Load $${amount}`
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
