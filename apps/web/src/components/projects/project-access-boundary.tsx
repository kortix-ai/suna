'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DangerCircle as AlertCircle, ArrowLeft, CheckCircle as CheckCircle2, Spinner as Loader2, LockKeyhole, Refresh as RefreshCw, Send, User as UserRound } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { InfoBanner } from '@/components/ui/info-banner';
import { KortixHyperLogo } from '@/components/ui/marketing/kortix-hyper-logo';
import { Textarea } from '@/components/ui/textarea';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useAuth } from '@/features/providers/auth-provider';
import { getProjectDetail, requestProjectAccess } from '@/lib/projects-client';
import { cn } from '@/lib/utils';

interface ProjectAccessBoundaryProps {
  projectId: string;
  children: ReactNode;
}

function errorStatus(error: unknown): number | undefined {
  return (
    (error as { status?: number; response?: { status?: number } } | null)?.status ??
    (error as { response?: { status?: number } } | null)?.response?.status
  );
}

export function ProjectAccessBoundary({ projectId, children }: ProjectAccessBoundaryProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
          icon={<AlertCircle className="size-5" />}
          eyebrow={tI18nHardcoded.raw(
            'autoComponentsProjectsProjectAccessBoundaryJsxAttrEyebrowProjectUnavailablea0231815',
          )}
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsProjectAccessBoundaryJsxAttrTitleProjectNotc66b9822',
          )}
          description={tI18nHardcoded.raw(
            'autoComponentsProjectsProjectAccessBoundaryJsxAttrDescriptionThisProject92b78195',
          )}
        />
      );
    }

    return (
      <ProjectAccessStateFrame
        icon={<AlertCircle className="size-5" />}
        eyebrow={tI18nHardcoded.raw(
          'autoComponentsProjectsProjectAccessBoundaryJsxAttrEyebrowProjectUnavailablea0231815',
        )}
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsProjectAccessBoundaryJsxAttrTitleCouldnT870a862d',
        )}
        description={tI18nHardcoded.raw(
          'autoComponentsProjectsProjectAccessBoundaryJsxAttrDescriptionSomethingWent8997618a',
        )}
        footer={
          <Button type="button" variant="outline" onClick={() => query.refetch()}>
            <RefreshCw className="size-4" />
            Retry
          </Button>
        }
      />
    );
  }

  return <>{children}</>;
}

function ProjectAccessLoading() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div
      className="bg-background flex min-h-screen items-center justify-center"
      role="status"
      aria-label={tI18nHardcoded.raw(
        'autoComponentsProjectsProjectAccessBoundaryJsxAttrAriaLabelLoading21cf6b95',
      )}
    >
      <KortixHyperLogo size={34} startOnView={false} animateOnHover={false} />
    </div>
  );
}

function ForbiddenProjectState({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
      icon={<LockKeyhole className="size-5" />}
      eyebrow={tI18nHardcoded.raw(
        'autoComponentsProjectsProjectAccessBoundaryJsxAttrEyebrowPrivateProjectd5b1951c',
      )}
      title={sent ? 'Request sent.' : 'Request access to this project.'}
      description={
        sent
          ? 'A project manager can approve you from the Members screen. Keep this page open and check again once they approve the request.'
          : 'This Kortix workspace is private. Send a short note and a project manager can add you as a viewer.'
      }
      panelTitle={sent ? 'Waiting for approval' : 'Access request'}
      panelDescription={
        sent
          ? 'Managers have the request in Customize → Members.'
          : 'A little context helps the manager approve the right account.'
      }
      content={
        <div className="space-y-4">
          {sent ? (
            <InfoBanner
              tone="success"
              icon={CheckCircle2}
              title={tI18nHardcoded.raw(
                'autoComponentsProjectsProjectAccessBoundaryJsxAttrTitleRequestSent6567e02d',
              )}
            >
              {tI18nHardcoded.raw(
                'autoComponentsProjectsProjectAccessBoundaryJsxTextProjectManagersWill08e33ff7',
              )}
            </InfoBanner>
          ) : (
            <>
              <InfoBanner
                tone="neutral"
                icon={UserRound}
                title={tI18nHardcoded.raw(
                  'autoComponentsProjectsProjectAccessBoundaryJsxAttrTitleSignedIna3165363',
                )}
              >
                <span className="text-muted-foreground">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsProjectAccessBoundaryJsxTextRequestingAccessAs09b70479',
                  )}{' '}
                  <span className="text-foreground font-medium">
                    {user?.email ?? user?.id ?? 'this account'}
                  </span>
                  .
                </span>
              </InfoBanner>

              <div className="space-y-2">
                <label
                  className="text-foreground text-sm font-medium"
                  htmlFor="project-access-message"
                >
                  Message <span className="text-muted-foreground font-normal">optional</span>
                </label>
                <Textarea
                  id="project-access-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  minHeight={96}
                  maxHeight={160}
                  placeholder={tI18nHardcoded.raw(
                    'autoComponentsProjectsProjectAccessBoundaryJsxAttrPlaceholderTellThec2bb0f7d',
                  )}
                  disabled={requestMutation.isPending}
                />
                {inlineError ? <p className="text-destructive text-xs">{inlineError}</p> : null}
              </div>
            </>
          )}
        </div>
      }
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => router.push('/projects')}>
            <ArrowLeft className="size-4" />
            {tI18nHardcoded.raw(
              'autoComponentsProjectsProjectAccessBoundaryJsxTextBackToProjects9ad9ccd3',
            )}
          </Button>
          {sent ? (
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>
              <RefreshCw className="size-4" />
              {tI18nHardcoded.raw(
                'autoComponentsProjectsProjectAccessBoundaryJsxTextCheckAgain9f1e6458',
              )}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => requestMutation.mutate()}
              disabled={requestMutation.isPending}
            >
              {requestMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {tI18nHardcoded.raw(
                'autoComponentsProjectsProjectAccessBoundaryJsxTextRequestAccess870ec6e1',
              )}
            </Button>
          )}
        </div>
      }
    />
  );
}

function ProjectAccessStateFrame({
  icon,
  eyebrow = 'Project access',
  title,
  description,
  panelTitle,
  panelDescription,
  content,
  footer,
}: {
  icon: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
  panelTitle?: string;
  panelDescription?: string;
  content?: ReactNode;
  footer?: ReactNode;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const router = useRouter();
  const action = footer ?? (
    <Button type="button" variant="outline" onClick={() => router.push('/projects')}>
      <ArrowLeft className="size-4" />
      {tI18nHardcoded.raw(
        'autoComponentsProjectsProjectAccessBoundaryJsxTextBackToProjects9ad9ccd3',
      )}
    </Button>
  );

  return (
    <div className="bg-background relative flex min-h-screen overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 opacity-60" aria-hidden="true">
        <WallpaperBackground />
      </div>
      <div
        className="bg-background/85 dark:bg-background/80 pointer-events-none absolute inset-0"
        aria-hidden="true"
      />

      <main className="relative z-10 mx-auto flex w-full max-w-4xl items-center">
        <div
          className={cn(
            'grid w-full gap-6',
            content ? 'lg:grid-cols-2 lg:items-start' : 'max-w-2xl',
          )}
        >
          <section className="space-y-5">
            <div className="border-border/70 bg-card text-foreground flex size-11 items-center justify-center rounded-2xl border shadow-2xs">
              {icon}
            </div>

            <div className="space-y-3">
              <Badge variant="outline" size="sm" className="w-fit">
                {eyebrow}
              </Badge>
              <div className="space-y-3">
                <h1 className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                  {title}
                </h1>
                <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
                  {description}
                </p>
              </div>
            </div>

            {!content ? <div className="pt-1">{action}</div> : null}
          </section>

          {content ? (
            <Card className="border-border/70 bg-card/90 gap-0 overflow-hidden rounded-2xl py-0 shadow-2xs backdrop-blur-sm">
              <CardHeader className="border-border/60 border-b px-6 py-4">
                <CardTitle className="text-base">{panelTitle ?? 'Request access'}</CardTitle>
                {panelDescription ? (
                  <CardDescription className="text-xs leading-relaxed">
                    {panelDescription}
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent className="px-6 py-5">{content}</CardContent>
              <CardFooter className="border-border/60 bg-muted/30 border-t px-6 py-3">
                {action}
              </CardFooter>
            </Card>
          ) : null}
        </div>
      </main>
    </div>
  );
}
