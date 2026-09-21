'use client';

import { Button } from '@/components/ui/marketing/button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { useAuth } from '@/features/providers/auth-provider';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { ArrowRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';

export function HeroActions({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const openDemo = useRequestDemo();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        onClick={() => openDemo()}
        className={
          compact
            ? 'hidden h-8 rounded-md px-3 text-xs sm:inline-flex'
            : 'h-12 rounded-md px-6 text-sm lg:h-10'
        }
      >
        Request demo
      </Button>
      <Button
        asChild
        className={compact ? 'h-8 rounded-md px-3 text-xs' : 'h-12 rounded-md px-4 text-sm lg:h-10'}
      >
        <Link href={user ? latestProjectPath(user.id) : '/auth'}>
          Get started <ArrowRightIcon className="size-4" />
        </Link>
      </Button>
    </div>
  );
}
