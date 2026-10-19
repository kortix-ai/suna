'use client';

import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen, AuthStatusScreen } from '@/features/auth/auth-consent';
import { ErrorStrip, FieldLabel, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { ComputerCapabilities } from '@/features/tunnel/computer-connect';
import { localizedCapabilityRegistry } from '@/features/tunnel/types';
import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
import {
  useApproveDeviceAuth,
  useDenyDeviceAuth,
  useDeviceAuthInfo,
} from '@/hooks/tunnel/use-tunnel';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

type Share = 'me' | 'project';

export default function DeviceAuthorizePage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <DeviceAuthorize />
    </Suspense>
  );
}

/**
 * Approving a device pairs the machine to the approver. It is theirs in every
 * project they belong to, in their private sessions. When the machine named a
 * project (`connect --project-id`, or the desktop app's connect button), the
 * approver may also share it with that project, which needs connection-manage
 * rights there. The server reads the project from the request itself.
 *
 * Approving grants every capability: a computer that cannot do anything
 * helps nobody. The owner turns any of them off afterwards in Settings ›
 * My computer, and the next call obeys it.
 */
function DeviceAuthorize() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('computers');
  const tSharing = useTranslations('accessSharing');
  const capabilities = useMemo(() => localizedCapabilityRegistry(tI18nComplete), [tI18nComplete]);
  const params = useParams();
  const router = useRouter();
  const code = params.code as string;
  const { user, isLoading: authLoading } = useAuth();

  const { data: info, isLoading, error } = useDeviceAuthInfo(code);
  const approve = useApproveDeviceAuth();
  const deny = useDenyDeviceAuth();
  const { sections } = useProjectSelectorData();

  // `null` until the user types: a machine already paired to the caller keeps
  // its name, a new one starts from its hostname.
  const [typedName, setName] = useState<string | null>(null);
  const [share, setShare] = useState<Share>('me');
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  // Only a project the machine named can be shared with; its name comes from
  // the caller's project list (absent while it loads, or without access).
  const projectId = info?.projectId ?? undefined;
  const project = useMemo(
    () =>
      sections
        .flatMap((section) => section.projects)
        .find((candidate) => candidate.project_id === projectId),
    [sections, projectId],
  );
  const canShare =
    useProjectCan(project ? projectId : undefined, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE)
      .allowed === true;
  const effectiveShare: Share = canShare ? share : 'me';

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace(`/auth?returnUrl=${encodeURIComponent(`/tunnel/authorize/${code}`)}`);
    }
  }, [user, authLoading, router, code]);

  const registered = info?.registered ?? null;
  // macOS appends " (4)" to a name another device on the network already
  // uses. That suffix is noise in a name people pick their computer by.
  const name =
    typedName ?? registered?.name ?? (info?.machineHostname ?? '').replace(/ \(\d+\)$/, '');

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = info?.expiresAt
    ? Math.max(0, Math.floor((new Date(info.expiresAt).getTime() - now) / 1000))
    : 0;

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  const handleApprove = async () => {
    await approve.mutateAsync({
      code,
      name: name || info?.machineHostname || 'Unnamed',
      capabilities: capabilities.map((cap) => cap.key),
      share: effectiveShare,
    });
    setDone('approved');
  };

  const handleDeny = async () => {
    await deny.mutateAsync(code);
    setDone('denied');
  };

  if (authLoading || isLoading) {
    return <AuthPendingScreen />;
  }

  if (error || !info) {
    return (
      <AuthStatusScreen
        title={tI18nComplete.raw('textbb08e04092a7')}
        description={tI18nComplete.raw('text8c78cadbcda5')}
      />
    );
  }

  if (info.status === 'expired' || remaining <= 0) {
    return (
      <AuthStatusScreen
        title={tI18nComplete.raw('text0ff5e16d4eb0')}
        description={tI18nComplete.raw('text98f76f3edf39')}
      />
    );
  }

  if (info.status !== 'pending' || done) {
    const isApproved = done === 'approved' || info.status === 'approved';
    return (
      <AuthStatusScreen
        title={
          isApproved ? tI18nComplete.raw('text89ed0c271cc2') : tI18nComplete.raw('text1d01fc5159dc')
        }
        description={
          isApproved
            ? effectiveShare === 'project' && project
              ? t('approvedShared', { project: project.name })
              : t('approvedEverywhere')
            : tI18nComplete.raw('textf711673979b5')
        }
      />
    );
  }

  const busy = approve.isPending || deny.isPending;

  return (
    <AuthFrame>
      <Rise>
        <StepHeader
          title={tI18nComplete.raw('text864e61fd1bcd')}
          description={t('authorizeCodeHint')}
        />
      </Rise>

      <Rise delay={0.06}>
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-3 rounded-md border px-3.5 py-3">
            <span className="text-foreground font-mono text-lg font-medium tracking-widest tabular-nums">
              {info.deviceCode}
            </span>
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {minutes}:{seconds.toString().padStart(2, '0')}
            </span>
          </div>

          {/* Pairing binds the computer to the signed-in account: say which. */}
          {user?.email ? (
            <p className="text-muted-foreground text-xs">
              {t('approvingAs', { email: user.email })}
            </p>
          ) : null}

          {registered ? (
            <InfoBanner
              tone="info"
              icon={ArrowsClockwiseIcon}
              title={t('alreadyConnected', { name: registered.name })}
            >
              {registered.isLive ? t('alreadyConnectedLive') : t('alreadyConnectedHint')}
            </InfoBanner>
          ) : null}

          <div className="space-y-3">
            <FieldLabel htmlFor="connection-name">
              {tI18nComplete.raw('text686d4d5d8ecd')}
            </FieldLabel>
            <Input
              id="connection-name"
              type="text"
              size="md"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={info.machineHostname || tI18nComplete.raw('text686d4d5d8ecd')}
            />
          </div>

          <div className="space-y-3">
            <p className="text-muted-foreground text-sm font-medium">{t('whoCanUse')}</p>
            <RadioGroup value={effectiveShare} onValueChange={(value) => setShare(value as Share)}>
              <RadioGroupItem
                value="me"
                variant="outline"
                label={tSharing('onlyYou')}
                description={t('onlyYouDescription')}
              />
              {project ? (
                <RadioGroupItem
                  value="project"
                  variant="outline"
                  disabled={!canShare}
                  label={t('alsoShareWith', { project: project.name })}
                  description={canShare ? t('everyoneDescription') : tSharing('shareRequiresManage')}
                />
              ) : null}
            </RadioGroup>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-muted-foreground text-sm font-medium">
                {tI18nComplete.raw('text5db4167d9f88')}
              </p>
              <p className="text-muted-foreground text-xs text-pretty">
                {t('accessHint')}
              </p>
            </div>
            <div className="rounded-md border px-3.5">
              <ComputerCapabilities />
            </div>
          </div>

          <div className="space-y-3">
            {approve.error ? <ErrorStrip message={approve.error.message} /> : null}
            <Button
              size="lg"
              className="w-full"
              onClick={() => void handleApprove().catch(() => undefined)}
              disabled={busy}
            >
              {approve.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {registered ? t('reconnect') : tI18nComplete.raw('textf4da86da1210')}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive focus-visible:ring-destructive/35 w-full"
              onClick={() => void handleDeny().catch(() => undefined)}
              disabled={busy}
            >
              {deny.isPending ? <Loading className="text-destructive! size-4 shrink-0" /> : null}
              {tI18nComplete.raw('texte7369074de00')}
            </Button>
          </div>
        </div>
      </Rise>
    </AuthFrame>
  );
}
