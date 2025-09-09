'use client';

import { useState, useMemo, useEffect } from 'react';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/agents/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Search, 
  User, 
  CreditCard, 
  Calendar,
  Filter,
  TrendingUp,
  Users,
  Activity
} from 'lucide-react';
import { useAdminUserList, useAdminUserStats } from '@/hooks/react-query/admin/use-admin-users';
import type { UserSummary } from '@/hooks/react-query/admin/use-admin-users';

interface AdminUserTableProps {
  onUserSelect?: (user: UserSummary) => void;
}

export function AdminUserTable({ onUserSelect }: AdminUserTableProps) {
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [searchEmail, setSearchEmail] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  
  const [debouncedSearch, setDebouncedSearch] = useState(searchEmail);
  
  const { data: userListResponse, isLoading, error } = useAdminUserList({
    page,
    page_size: pageSize,
    search_email: debouncedSearch || undefined,
    tier_filter: tierFilter || undefined,
    sort_by: sortBy,
    sort_order: sortOrder,
  });

  const { data: stats } = useAdminUserStats();

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchEmail);
      setPage(1);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchEmail]);

  const formatCurrency = (amount: number) => {
    return `$${amount.toFixed(2)}`;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const tierName = (tier: string) => {
    switch (tier) {
      case 'tier_2_20':
        return '20 Dollar';
      case 'tier_6_50':
        return '50 Dollar';
      case 'tier_25_200':
        return '200 Dollar';
      default:
        return 'Unknown';
    }
  };

  const columns: DataTableColumn<UserSummary>[] = useMemo(() => [
    {
      id: 'user',
      header: 'User',
      cell: (user) => (
        <div className="flex flex-col gap-1 min-w-[200px]">
          <div className="font-medium text-foreground">{user.email}</div>
          <div className="text-xs text-muted-foreground">
            Joined {formatDate(user.created_at)}
          </div>
        </div>
      ),
    },
    {
      id: 'tier',
      header: 'Tier',
      cell: (user) => (
        <Badge variant="outline" className="capitalize">
          {tierName(user.tier)}
        </Badge>
      ),
      width: 'w-42',
    },
    {
      id: 'balance',
      header: 'Credit Balance',
      cell: (user) => (
        <div className="text-start">
          <div className="font-medium text-green-600">
            {formatCurrency(user.credit_balance)}
          </div>
        </div>
      ),
      width: 'w-42',
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (user) => (
        <Button 
          variant="outline" 
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onUserSelect?.(user);
          }}
        >
          Details
        </Button>
      ),
      width: 'w-32',
    },
  ], [onUserSelect]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  if (error) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-destructive">
            Failed to load users: {error.message}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Input
        id="search-email"
        placeholder="Search by email..."
        value={searchEmail}
        onChange={(e) => setSearchEmail(e.target.value)}
        className="pl-9"
      />
      <Card className='border-0 shadow-none bg-transparent'>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center space-x-4">
                  <Skeleton className="h-12 w-full" />
                </div>
              ))}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={userListResponse?.data || []}
              onRowClick={onUserSelect}
              emptyMessage="No users found matching your criteria"
              getItemId={(user) => user.id}
            />
          )}
        </CardContent>
      </Card>
      {userListResponse?.pagination && (
        <Pagination
          currentPage={userListResponse.pagination.current_page}
          totalPages={userListResponse.pagination.total_pages}
          totalItems={userListResponse.pagination.total_items}
          pageSize={userListResponse.pagination.page_size}
          onPageChange={handlePageChange}
          showPageSizeSelector={false}
          showJumpToPage={true}
        />
      )}
    </div>
  );
} 