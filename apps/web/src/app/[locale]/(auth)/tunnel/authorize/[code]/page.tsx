'use client';

import { CheckIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen, AuthStatusScreen } from '@/features/auth/auth-consent';
import { ErrorStrip, FieldLabel, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { localizedCapabilityRegistry } from '@/features/tunnel/types';
import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
import {
  useApproveDeviceAuth,
  useDenyDeviceAuth,
  useDeviceAuthInfo,
} from '@/hooks/tunnel/use-tunnel';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';

type Share = 'me' | 'project';

export default function DeviceAuthorizePage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <DeviceAuthorize />
    </Suspense>
  );
}

/**
 * Approving a device pairs the machine AND adds it as an account of the chosen
 * project's `computer` connector — private to the approver unless they share
 * it with everyone in the project, which needs connection-manage rights.
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
  const { sections, listsLoading } = useProjectSelectorData();

  // `null` until the user types: the machine's hostname is the default name.
  const [typedName, setName] = useState<string | null>(null);
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set());
  const [pickedProjectId, setPickedProjectId] = useState('');
  const [share, setShare] = useState<Share>('me');
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  const projects = useMemo(() => sections.flatMap((section) => section.projects), [sections]);
  // The machine named its project (`connect --project-id`, or the desktop
  // app's connect button). Fall back to the most recent project otherwise.
  const requestedProjectId = info?.projectId ?? null;
  const requestedProject = projects.find((project) => project.project_id === requestedProjectId);
  const projectId = requestedProject
    ? requestedProject.project_id
    : pickedProjectId || projects[0]?.project_id || '';
  const project = projects.find((candidate) => candidate.project_id === projectId);
  const canShare =
    useProjectCan(projectId || undefined, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE)
      .allowed === true;
  const effectiveShare: Share = canShare ? share : 'me';

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace(`/auth?returnUrl=${encodeURIComponent(`/tunnel/authorize/${code}`)}`);
    }
  }, [user, authLoading, router, code]);

  const name = typedName ?? info?.machineHostname ?? '';

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

  const toggleCap = (key: string) => {
    setSelectedCaps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleApprove = async () => {
    await approve.mutateAsync({
      code,
      name: name || info?.machineHostname || 'Unnamed',
      capabilities: Array.from(selectedCaps),
      projectId,
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
            ? project
              ? t('approvedInProject', { project: project.name })
              : tI18nComplete.raw('textbc25c1f595c9')
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
            <FieldLabel htmlFor="connection-project">{t('projectLabel')}</FieldLabel>
            {requestedProject ? (
              <p
                id="connection-project"
                className="text-foreground rounded-md border px-3.5 py-2.5 text-sm"
              >
                {requestedProject.name}
              </p>
            ) : listsLoading ? (
              <Skeleton className="h-9 w-full rounded-lg" />
            ) : projects.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('noProjects')}</p>
            ) : (
              <Select value={projectId} onValueChange={setPickedProjectId}>
                <SelectTrigger id="connection-project" className="w-full">
                  <SelectValue placeholder={t('projectPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {sections
                    .filter((section) => section.projects.length > 0)
                    .map((section) => (
                      <SelectGroup key={section.accountId}>
                        {sections.length > 1 ? (
                          <SelectLabel>{section.accountName}</SelectLabel>
                        ) : null}
                        {section.projects.map((candidate) => (
                          <SelectItem key={candidate.project_id} value={candidate.project_id}>
                            {candidate.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                </SelectContent>
              </Select>
            )}
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
              <RadioGroupItem
                value="project"
                variant="outline"
                disabled={!canShare}
                label={
                  project ? tSharing('everyone', { project: project.name }) : tSharing('visibilityEveryone')
                }
                description={canShare ? t('everyoneDescription') : tSharing('shareRequiresManage')}
              />
            </RadioGroup>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-muted-foreground text-sm font-medium">
                {tI18nComplete.raw('text5db4167d9f88')}
              </p>
              <p className="text-muted-foreground text-xs text-pretty">
                {tI18nComplete.raw('text7d899c8ca569')}
              </p>
            </div>
            <div className="divide-border divide-y overflow-hidden rounded-md border">
              {capabilities.map((cap) => {
                const CapIcon = cap.icon;
                const selected = selectedCaps.has(cap.key);
                return (
                  <button
                    key={cap.key}
                    type="button"
                    onClick={() => toggleCap(cap.key)}
                    aria-pressed={selected}
                    className={cn(
                      'flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors',
                      selected ? 'bg-active' : 'hover:bg-hover',
                    )}
                  >
                    <CapIcon
                      className={cn(
                        'size-5 shrink-0',
                        selected ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block text-sm',
                          selected ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {cap.label}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {cap.description}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors',
                        selected ? 'border-foreground bg-foreground' : 'border-border',
                      )}
                    >
                      {selected && <CheckIcon className="text-background size-3" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3">
            {approve.error ? <ErrorStrip message={approve.error.message} /> : null}
            {selectedCaps.size === 0 ? (
              <p className="text-muted-foreground text-center text-xs">
                {tI18nComplete.raw('text6588df7e32c9')}
              </p>
            ) : null}
            <Button
              size="lg"
              className="w-full"
              onClick={() => void handleApprove().catch(() => undefined)}
              disabled={busy || selectedCaps.size === 0 || !projectId}
            >
              {approve.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('textf4da86da1210')}
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
