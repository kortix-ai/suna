'use client';

import Link from 'next/link';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

/**
 * Brand row for the sidebar header — replaces the shadcn TeamSwitcher block.
 * Matches the same `size-lg` slot dimensions so the header stays vertically
 * aligned with the rest of the sidebar primitives.
 */
export function KortixBrand({ href = '/dashboard' }: { href?: string }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex items-center justify-start p-2">
          <Link href={href} aria-label="Kortix home">
            <KortixLogo size={16} variant="logomark" />
          </Link>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
