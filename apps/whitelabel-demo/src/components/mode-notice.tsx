'use client';

/**
 * The full-screen notice a mode-restricted page shows instead of a page whose
 * every query would fail: the brand mark, a one-line title naming the mode, the
 * copy that says why (and where to go instead), and the way back.
 */

import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function ModeNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <BrandMark className="mx-auto mb-4" />
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{children}</p>
        <Button asChild className="mt-5 gap-2">
          <Link href="/">
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
        </Button>
      </Card>
    </div>
  );
}
