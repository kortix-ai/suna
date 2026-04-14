'use client';

import { useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Server, ShieldCheck, UserPlus, Users } from 'lucide-react';

import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  ADMIN_SECTION_META,
  type AdminSection,
  AdminInstancesSection,
  AdminAccountsSection,
  AdminAccessRequestsSection,
} from '@/components/admin/admin-dashboard-sections';

const sections: { id: AdminSection; icon: typeof Server }[] = [
  { id: 'instances', icon: Server },
  { id: 'accounts', icon: Users },
  { id: 'access-requests', icon: UserPlus },
];

export default function AdminDashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: adminRole, isLoading } = useAdminRole();
  const activeSection = (searchParams.get('section') as AdminSection | null) || 'instances';
  const section = sections.some((s) => s.id === activeSection) ? activeSection : 'instances';
  const meta = ADMIN_SECTION_META[section];

  const content = useMemo(() => {
    switch (section) {
      case 'accounts':
        return <AdminAccountsSection embedded />;
      case 'access-requests':
        return <AdminAccessRequestsSection embedded />;
      case 'instances':
      default:
        return <AdminInstancesSection embedded />;
    }
  }, [section]);

  if (isLoading) {
    return <div className="min-h-screen bg-background p-6 max-w-6xl mx-auto"><Skeleton className="h-96 w-full" /></div>;
  }

  if (!adminRole?.isAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <ShieldCheck className="h-12 w-12 text-muted-foreground/40 mx-auto" />
          <h2 className="text-lg font-medium">Admin access required</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-2">
              <ShieldCheck className="h-7 w-7" />
              Admin Dashboard
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
              {meta.description}
            </p>
          </div>
          <Button variant="outline" onClick={() => router.push('/instances')} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Instances
          </Button>
        </div>

        <div className="rounded-2xl border border-border/60 bg-muted/10 p-2 flex flex-col md:flex-row gap-2">
          {sections.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => router.replace(`/admin?section=${id}`)}
              className={cn(
                'flex-1 rounded-xl px-4 py-3 text-left transition-colors border',
                section === id
                  ? 'bg-background border-foreground/15 shadow-sm'
                  : 'bg-transparent border-transparent hover:bg-background/60',
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Icon className="h-4 w-4" />
                {ADMIN_SECTION_META[id].title}
              </div>
              <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {ADMIN_SECTION_META[id].description}
              </div>
            </button>
          ))}
        </div>

        {content}
      </div>
    </div>
  );
}
