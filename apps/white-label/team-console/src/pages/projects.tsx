import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import Loading from '@kortix/ui/loading';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { FolderSimple } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { PageTitle, RowLink, When } from '../app';
import { kortix } from '../kortix';

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => kortix.projects.list() });
}

export function ProjectsPage() {
  const projects = useProjects();
  if (projects.isPending) return <Loading className="size-5 text-muted-foreground" />;
  if (projects.isError) return <ErrorState title="Could not load projects" description={String(projects.error)} />;
  const rows = projects.data.filter((p) => p.status === 'active');

  return (
    <>
      <PageTitle title="Projects" />
      {rows.length === 0 ? (
        <EmptyState icon={FolderSimple} title="No projects" description="Projects you can open in Kortix show up here." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Your role</TableHead>
              <TableHead className="text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.project_id} className="relative">
                <TableCell className="font-medium"><RowLink href={`/projects/${p.project_id}`}>{p.name}</RowLink></TableCell>
                <TableCell className="text-muted-foreground">{p.effective_project_role ?? p.project_role ?? '—'}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  <When value={p.updated_at} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
