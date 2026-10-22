'use client';

import { Notice, useFirm } from '@/components/access';
import { isAdmin } from '@/lib/roles';
import { LockKeyIcon } from '@phosphor-icons/react';

/** Children for owners and admins; a notice for lawyers. The Convex functions enforce the same rule. */
export function AdminOnly({ children }: { children: React.ReactNode }) {
  const firm = useFirm();
  if (isAdmin(firm.role)) return children;
  return <Notice icon={LockKeyIcon} title="Admins only" body="Ask an owner or admin of your firm for access." href="/app/settings/firm" cta="Firm settings" />;
}
