'use client';

import { useApproveCaptureDevice, useCaptureDeviceGrant, useDenyCaptureDevice } from '@kortix/sdk/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen, AuthStatusScreen } from '@/features/auth/auth-consent';
import { ErrorStrip, FieldLabel, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
import { useTranslations } from '@/i18n/use-translations';

export default function CaptureAuthorizePage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <CaptureAuthorize />
    </Suspense>
  );
}

/**
 * The person half of the Kortix Capture device sign-in (RFC 8628). The desktop
 * app shows a code and opens `/capture/authorize?user_code=…`; the signed-in
 * member checks the code and picks one of their projects with Capture on. The
 * device then records into that project as this member.
 */
function CaptureAuthorize() {
  const t = useTranslations('capture.authorize');
  const router = useRouter();
  const params = useSearchParams();
  const userCode = params.get('user_code')?.trim().toUpperCase() ?? '';
  const { user, isLoading: authLoading } = useAuth();
  const [typedCode, setTypedCode] = useState('');

  useEffect(() => {
    if (!authLoading && !user) {
      const back = `/capture/authorize${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ''}`;
      router.replace(`/auth?returnUrl=${encodeURIComponent(back)}`);
    }
  }, [user, authLoading, router, userCode]);

  const grant = useCaptureDeviceGrant(user ? userCode : null);
  const approve = useApproveCaptureDevice();
  const deny = useDenyCaptureDevice();
  const { sections, listsLoading } = useProjectSelectorData();
  const projects = useMemo(
    () => sections.flatMap((section) => section.projects).filter((project) => project.experimental?.capture),
    [sections],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = picked ?? (projects.length === 1 ? projects[0]!.project_id : null);
  const approvedProject = projects.find((project) => project.project_id === (grant.data?.project_id ?? projectId));

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (authLoading || !user) return <AuthPendingScreen />;

  if (!userCode) {
    return (
      <AuthFrame>
        <Rise>
          <StepHeader title={t('enterCodeTitle')} description={t('enterCodeDescription')} />
        </Rise>
        <Rise delay={0.06}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (typedCode.trim()) router.replace(`/capture/authorize?user_code=${encodeURIComponent(typedCode.trim().toUpperCase())}`);
            }}
          >
            <FieldLabel htmlFor="capture-user-code">{t('codeLabel')}</FieldLabel>
            <Input
              id="capture-user-code"
              size="md"
              autoFocus
              autoComplete="off"
              value={typedCode}
              onChange={(event) => setTypedCode(event.target.value)}
              placeholder="ABCD-1234"
              className="font-mono tracking-widest"
            />
            <Button type="submit" size="lg" className="w-full" disabled={!typedCode.trim()}>
              {t('continue')}
            </Button>
          </form>
        </Rise>
      </AuthFrame>
    );
  }

  if (grant.isLoading) return <AuthPendingScreen />;
  if (grant.error || !grant.data) {
    return <AuthStatusScreen title={t('invalidTitle')} description={t('invalidDescription')} />;
  }

  const info = grant.data;
  const remaining = Math.max(0, Math.floor((new Date(info.expires_at).getTime() - now) / 1000));
  if (info.status === 'expired' || (info.status === 'pending' && remaining <= 0)) {
    return <AuthStatusScreen title={t('expiredTitle')} description={t('expiredDescription')} />;
  }
  if (info.status === 'approved' || info.status === 'consumed') {
    return (
      <AuthStatusScreen
        title={t('approvedTitle')}
        description={approvedProject ? t('approvedDescription', { project: approvedProject.name }) : t('approvedDescriptionNoProject')}
      />
    );
  }
  if (info.status === 'denied') {
    return <AuthStatusScreen title={t('deniedTitle')} description={t('deniedDescription')} />;
  }

  const busy = approve.isPending || deny.isPending;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const device = [info.device.name, [info.device.os, info.device.os_version].filter(Boolean).join(' ')].filter(Boolean).join(' · ');

  return (
    <AuthFrame>
      <Rise>
        <StepHeader title={t('title')} description={t('description')} />
      </Rise>

      <Rise delay={0.06}>
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-3 rounded-md border px-3.5 py-3">
            <span className="text-foreground font-mono text-lg font-medium tracking-widest tabular-nums">
              {info.user_code}
            </span>
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {minutes}:{seconds.toString().padStart(2, '0')}
            </span>
          </div>

          <div className="space-y-1">
            {device ? <p className="text-foreground text-sm">{device}</p> : null}
            {user.email ? <p className="text-muted-foreground text-xs">{t('approvingAs', { email: user.email })}</p> : null}
          </div>

          <div className="space-y-3">
            <p className="text-muted-foreground text-sm font-medium">{t('projectLabel')}</p>
            {listsLoading ? (
              <Loading className="size-4" />
            ) : projects.length === 0 ? (
              <p className="text-muted-foreground text-xs text-pretty">{t('noProjects')}</p>
            ) : (
              <RadioGroup value={projectId ?? ''} onValueChange={setPicked}>
                {projects.map((project) => (
                  <RadioGroupItem key={project.project_id} value={project.project_id} variant="outline" label={project.name} />
                ))}
              </RadioGroup>
            )}
          </div>

          <p className="text-muted-foreground text-xs text-pretty">{t('notice')}</p>

          <div className="space-y-3">
            {approve.error ? <ErrorStrip message={approve.error.message} /> : null}
            {deny.error ? <ErrorStrip message={deny.error.message} /> : null}
            <Button
              size="lg"
              className="w-full"
              onClick={() => projectId && void approve.mutateAsync({ userCode: info.user_code, projectId }).catch(() => undefined)}
              disabled={busy || !projectId}
            >
              {approve.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('approve')}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive focus-visible:ring-destructive/35 w-full"
              onClick={() => void deny.mutateAsync(info.user_code).catch(() => undefined)}
              disabled={busy}
            >
              {deny.isPending ? <Loading className="text-destructive! size-4 shrink-0" /> : null}
              {t('deny')}
            </Button>
          </div>
        </div>
      </Rise>
    </AuthFrame>
  );
}
