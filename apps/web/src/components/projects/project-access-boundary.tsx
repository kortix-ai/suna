'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Send,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/features/providers/auth-provider';
import { getProjectDetail, requestProjectAccess } from '@/lib/projects-client';

interface ProjectAccessBoundaryProps {
  projectId: string;
  children: ReactNode;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { status?: number; response?: { status?: number } } | null)?.status ??
    (error as { response?: { status?: number } } | null)?.response?.status;
}

export function ProjectAccessBoundary({ projectId, children }: ProjectAccessBoundaryProps) {
  const query = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId, { showErrors: false }),
    enabled: !!projectId,
    retry: false,
  });

  if (query.isLoading) {
    return <ProjectAccessLoading />;
  }

  if (query.isError) {
    const status = errorStatus(query.error);
    if (status === 403) {
      return <ForbiddenProjectState projectId={projectId} />;
    }

    if (status === 404) {
      return (
        <ProjectAccessStateFrame
          icon={<AlertCircle className="h-5 w-5" />}
          title="Project not found"
          description="This project may have been deleted, archived, or the link is no longer valid."
        />
      );
    }

    return (
      <ProjectAccessStateFrame
        icon={<AlertCircle className="h-5 w-5" />}
        title="Couldn't load this project"
        description="Something went wrong before the project workspace opened. Try again, or go back to your projects."
        footer={
          <Button type="button" variant="outline" onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        }
      />
    );
  }

  return <>{children}</>;
}

function ProjectAccessLoading() {
  return (
    <div className="bg-background flex min-h-screen items-center justify-center">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Opening project…
      </div>
    </div>
  );
}

function ForbiddenProjectState({ projectId }: { projectId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const requestMutation = useMutation({
    mutationFn: () => requestProjectAccess(projectId, message),
    onMutate: () => setInlineError(null),
    onSuccess: (result) => {
      if (result.status === 'already_has_access') {
        void queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
        return;
      }
      setSent(true);
    },
    onError: (error: Error) => {
      setInlineError(error.message || 'Could not send access request.');
    },
  });

  return (
    <ProjectAccessStateFrame
      icon={<LockKeyhole className="h-5 w-5" />}
      title="You need access to open this project"
      description="This link points to a private Kortix project. Ask a project manager to approve your access request, then refresh this page."
      content={
        <div className="space-y-4">
          <div className="border-border/70 bg-muted/35 rounded-xl border px-3 py-2 text-xs text-muted-foreground">
            Signed in as{' '}
            <span className="font-medium text-foreground">
              {user?.email ?? user?.id ?? 'this account'}
            </span>
          </div>

          {sent ? (
            <div className="border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 flex items-start gap-2 rounded-xl border px-3 py-3 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Request sent</p>
                <p className="text-xs opacity-80">
                  Project managers will see it in the Members screen and can approve you as a viewer.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-medium text-foreground" htmlFor="project-access-message">
                Message (optional)
              </label>
              <Textarea
                id="project-access-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                minHeight={92}
                maxHeight={160}
                placeholder="Tell the project manager why you need access…"
                disabled={requestMutation.isPending}
              />
              {inlineError ? <p className="text-xs text-destructive">{inlineError}</p> : null}
            </div>
          )}
        </div>
      }
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => router.push('/projects')}>
            <ArrowLeft className="h-4 w-4" />
            Back to projects
          </Button>
          {sent ? (
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" />
              Check again
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => requestMutation.mutate()}
              disabled={requestMutation.isPending}
            >
              {requestMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Request access
            </Button>
          )}
        </div>
      }
    />
  );
}

function ProjectAccessStateFrame({
  icon,
  title,
  description,
  content,
  footer,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  content?: ReactNode;
  footer?: ReactNode;
}) {
  const router = useRouter();
  return (
    <div className="bg-background relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="bg-kortix-blue/10 absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full blur-3xl" />
      <Card variant="glass" className="relative w-full max-w-lg border-border/70 shadow-xl">
        <CardHeader className="items-center text-center">
          <div className="bg-muted text-foreground mb-2 flex h-11 w-11 items-center justify-center rounded-2xl border">
            {icon}
          </div>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription className="max-w-sm text-sm leading-relaxed">
            {description}
          </CardDescription>
        </CardHeader>
        {content ? <CardContent>{content}</CardContent> : null}
        <CardFooter className="justify-center">
          {footer ?? (
            <Button type="button" variant="outline" onClick={() => router.push('/projects')}>
              <ArrowLeft className="h-4 w-4" />
              Back to projects
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
