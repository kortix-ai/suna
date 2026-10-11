'use client';

import { AppWindowIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopCaptureAppIcon,
  desktopCaptureExclude,
  desktopCaptureExclusions,
  isDesktop,
  type DesktopCaptureExclusion,
  type DesktopCaptureExclusions,
} from '@/lib/desktop';

import { ExclusionsEditor } from '../settings/exclusions-editor';
import { applyExclusion, fromEngine } from '../settings/exclusions-model';

const EXCLUSIONS_KEY = ['desktop-capture-exclusions'] as const;

/**
 * "This computer" ▸ Exclusions: the person's own exclusions, kept by the
 * engine on this computer only (`kortix-capture exclude|include`), with the
 * organization's mandatory ones locked. Every toggle applies at once and rolls
 * back with the engine's message when it fails.
 */
export function CaptureExclusions({ org }: { org: string }) {
  const t = useTranslations('capture.dialog.exclusions');
  const queryClient = useQueryClient();
  const exclusions = useQuery({
    queryKey: EXCLUSIONS_KEY,
    queryFn: async () => (await desktopCaptureExclusions()) ?? null,
    enabled: isDesktop(),
    refetchInterval: 30_000,
  });
  const change = useMutation({
    mutationFn: desktopCaptureExclude,
    onMutate: async (input: DesktopCaptureExclusion) => {
      await queryClient.cancelQueries({ queryKey: EXCLUSIONS_KEY });
      const before = queryClient.getQueryData<DesktopCaptureExclusions | null>(EXCLUSIONS_KEY);
      if (before) queryClient.setQueryData(EXCLUSIONS_KEY, applyExclusion(before, input));
      return { before };
    },
    onError: (error: Error, _input, context) => {
      if (context?.before) queryClient.setQueryData(EXCLUSIONS_KEY, context.before);
      errorToast(error.message || t('failed'));
    },
    onSuccess: (next) => {
      if (next) queryClient.setQueryData(EXCLUSIONS_KEY, next);
    },
  });

  if (exclusions.isPending) {
    return (
      <div className="space-y-2" aria-busy>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-md" />
        ))}
      </div>
    );
  }
  if (exclusions.isError || !exclusions.data) {
    return (
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        description={exclusions.error?.message}
        action={
          <Button variant="outline" size="sm" onClick={() => exclusions.refetch()}>
            {t('tryAgain')}
          </Button>
        }
      />
    );
  }
  return (
    <ExclusionsEditor
      mode="device"
      view={fromEngine(exclusions.data)}
      org={org}
      onChange={(input) => change.mutate(input)}
      appIcon={(bundleId) => <AppIcon bundleId={bundleId} />}
    />
  );
}

/** The installed app's own icon, read from this computer; a neutral tile when it is not installed. */
function AppIcon({ bundleId }: { bundleId: string }) {
  const icon = useQuery({
    queryKey: ['desktop-capture-app-icon', bundleId],
    queryFn: () => desktopCaptureAppIcon(bundleId),
    enabled: isDesktop(),
    staleTime: Infinity,
  });
  if (!icon.data) {
    return (
      <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
        <AppWindowIcon className="size-4" />
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- a local data URL from the desktop app, not a remote image
  return <img src={icon.data} alt="" className="size-8 shrink-0" />;
}
