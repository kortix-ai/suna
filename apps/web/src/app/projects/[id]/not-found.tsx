'use client';

import { useTranslations } from 'next-intl';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowLeft, BookOpen } from 'lucide-react';

import { ProjectShell } from '@/components/projects/project-shell';
import {
  NotFoundCard,
  NotFoundNoise,
} from '@/components/common/not-found-state';

/**
 * Dashboard 404 — the not-found boundary for `/projects/[id]/*`.
 *
 * Same `<NotFoundCard />` as the marketing 404, but framed by the project
 * shell (sidebar + tab bar) so a mistyped project sub-route still feels like
 * you're inside the workspace. The "back" action returns to the project home
 * rather than the marketing site.
 *
 * not-found boundaries don't receive route params, so the project id is read
 * back off the pathname (`/projects/<id>/…`).
 */
export default function ProjectNotFound() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const pathname = usePathname();

  const projectId = useMemo(() => {
    const segments = pathname?.split('/').filter(Boolean) ?? [];
    return segments[0] === 'projects' ? segments[1] : undefined;
  }, [pathname]);

  const card = (
    <div className="relative flex flex-1 min-h-0 flex-col items-center justify-center overflow-hidden px-4 py-16 sm:px-6">
      <NotFoundNoise />
      <NotFoundCard
        actions={[
          {
            href: projectId ? `/projects/${projectId}` : '/projects',
            label: tHardcodedUi.raw('appNotFound.line100JsxTextReturnHome'),
            icon: <ArrowLeft className="h-4 w-4" />,
          },
          {
            href: '/docs',
            label: 'Documentation',
            icon: <BookOpen className="h-4 w-4" />,
            variant: 'outline',
          },
        ]}
      />
    </div>
  );

  // Fall back to a bare card if we somehow can't recover the project id — the
  // shell needs one to mount its sidebar.
  if (!projectId) {
    return (
      <div className="relative flex min-h-dvh w-full flex-col items-center justify-center bg-background">
        {card}
      </div>
    );
  }

  return <ProjectShell projectId={projectId}>{card}</ProjectShell>;
}
