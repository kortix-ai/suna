'use client';

import { useParams } from 'next/navigation';

import { ProjectShell } from '@/components/projects/project-shell';

interface CustomizeLayoutProps {
  children: React.ReactNode;
}

export default function CustomizeLayout({ children }: CustomizeLayoutProps) {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';

  return (
    <ProjectShell projectId={projectId}>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </ProjectShell>
  );
}
