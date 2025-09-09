'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AdminUserTable } from '@/components/admin/admin-user-table';
import { AdminUserDetailsDialog } from '@/components/admin/admin-user-details-dialog';
import { useAdminUserStats, useRefreshUserData } from '@/hooks/react-query/admin/use-admin-users';
import type { UserSummary } from '@/hooks/react-query/admin/use-admin-users';
import { 
  Users,
  Shield,
  TrendingUp,
  Activity,
  DollarSign,
  Sparkles
} from 'lucide-react';

export default function AdminBillingPage() {
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
  const { data: stats } = useAdminUserStats();
  const { refreshUserList, refreshUserStats } = useRefreshUserData();

  const handleUserSelect = (user: UserSummary) => {
    setSelectedUser(user);
    setIsDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setIsDialogOpen(false);
    setSelectedUser(null);
  };

  const handleRefreshData = () => {
    refreshUserList();
    refreshUserStats();
  };

  const formatCurrency = (amount: number) => {
    return `$${amount.toFixed(2)}`;
  };

  const calculateActivityRate = () => {
    if (!stats || stats.total_users === 0) return 0;
    return Math.round((stats.active_users_30d / stats.total_users) * 100);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20">
      <div className="max-w-5xl mx-auto p-6 space-y-8">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
              Billing Management - Admin
            </h1>
            <p className="text-md text-muted-foreground mt-2">
              Manage billing and user accounts
            </p>
          </div>
        </div>
        <div className="border-0 bg-transparent shadow-none">
          <CardContent className="p-0">
            <AdminUserTable onUserSelect={handleUserSelect} />
          </CardContent>
        </div>
        <AdminUserDetailsDialog
          user={selectedUser}
          isOpen={isDialogOpen}
          onClose={handleCloseDialog}
          onRefresh={handleRefreshData}
        />
      </div>
    </div>
  );
} 