'use client';

import {
  useApproveCaptureDevice,
  useCaptureDeviceGrant,
  useDenyCaptureDevice,
} from '@kortix/sdk/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import Link from 'next/link';

import { Button } from '@kortix/ui/button';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { RadioGroup, RadioGroupItem } from '@kortix/ui/radio-group';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { AuthPendingScreen, AuthStatusScreen } from '@kortix/ui/internal/auth/auth-consent';
import { ErrorStrip, FieldLabel, Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import { deviceOs } from '@kortix/ui/internal/capture/use-capture-area';
import { useWorkspaceDirectory } from '@kortix/ui/workspace/sidebar/use-workspace-directory';
import { useAuth } from '@/features/providers/auth-provider';
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
 * member checks the code and picks one of their workspaces with Capture on.
 * Capture's tenant is the workspace's account, so the choice is sent as its
 * `account_id`. The device then records into that workspace as this member.
 * With no workspace at all, the person creates or joins one first.
 */
function CaptureAuthorize() {
  const t = useTranslations('capture.authorize');
  const tWorkspaces = useTranslations('workspaces.capture');
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
  const accounts = grant.data?.accounts ?? [];
  // One row per workspace whose account has Capture on, by the workspace's
  // own name and icon. An account with no project is not a workspace.
  const directory = useWorkspaceDirectory();
  const captureAccountIds = new Set(accounts.map((account) => account.account_id));
  const workspaces = directory.openable.filter((row) => captureAccountIds.has(row.accountId));
  const [picked, setPicked] = useState<string | null>(null);
  const pickedRow =
    workspaces.find((row) => row.workspaceId === picked) ?? (workspaces.length === 1 ? workspaces[0] : null);
  const accountId = pickedRow?.accountId ?? null;
  const approvedAccountId = grant.data?.account_id ?? accountId;
  const approvedWorkspace = directory.openable.find((row) => row.accountId === approvedAccountId);
  const approvedAccount = approvedWorkspace
    ? { name: approvedWorkspace.project.name }
    : accounts.find((account) => account.account_id === approvedAccountId);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (authLoading || !user) return <AuthPendingScreen />;

  if (!directory.loading && directory.openable.length === 0) {
    return (
      <AuthStatusScreen
        title={tWorkspaces('noWorkspaceTitle')}
        description={tWorkspaces('noWorkspaceBody')}
        action={
          <Button asChild size="lg" className="w-full">
            <Link href="/workspaces">{tWorkspaces('openChooser')}</Link>
          </Button>
        }
      />
    );
  }

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
              if (typedCode.trim())
                router.replace(
                  `/capture/authorize?user_code=${encodeURIComponent(typedCode.trim().toUpperCase())}`,
                );
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
              placeholder={t('codePlaceholder')}
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
        description={
          approvedAccount
            ? t('approvedDescription', { account: approvedAccount.name })
            : t('approvedDescriptionNoAccount')
        }
      />
    );
  }
  if (info.status === 'denied') {
    return <AuthStatusScreen title={t('deniedTitle')} description={t('deniedDescription')} />;
  }

  const busy = approve.isPending || deny.isPending;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const device = [info.device.name, deviceOs(info.device)].filter(Boolean).join(' · ');

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
            {user.email ? (
              <p className="text-muted-foreground text-xs">
                {t('approvingAs', { email: user.email })}
              </p>
            ) : null}
          </div>

          <div className="space-y-3">
            <p className="text-muted-foreground text-sm font-medium">{tWorkspaces('workspaceLabel')}</p>
            {workspaces.length === 0 ? (
              <p className="text-muted-foreground text-xs text-pretty">{tWorkspaces('noCaptureWorkspace')}</p>
            ) : (
              <RadioGroup value={pickedRow?.workspaceId ?? ''} onValueChange={setPicked}>
                {workspaces.map((row) => (
                  <RadioGroupItem
                    key={row.workspaceId}
                    value={row.workspaceId}
                    variant="outline"
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <EntityAvatar
                          label={row.project.name}
                          glyph={row.project.icon_glyph}
                          emoji={row.project.icon}
                          size="xs"
                        />
                        <span className="truncate">{row.project.name}</span>
                      </span>
                    }
                  />
                ))}
              </RadioGroup>
            )}
          </div>

          <p className="text-muted-foreground text-xs text-pretty">{t('notice')}</p>
          <p className="text-foreground text-xs font-medium text-pretty">{t('ownCodeOnly')}</p>

          <div className="space-y-3">
            {approve.error ? <ErrorStrip message={approve.error.message} /> : null}
            {deny.error ? <ErrorStrip message={deny.error.message} /> : null}
            <Button
              size="lg"
              className="w-full"
              onClick={() =>
                accountId &&
                void approve
                  .mutateAsync({ userCode: info.user_code, accountId })
                  .catch(() => undefined)
              }
              disabled={busy || !accountId}
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
