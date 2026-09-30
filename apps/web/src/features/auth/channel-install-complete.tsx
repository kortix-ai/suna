'use client';

/**
 * Finishes a Slack or Teams OAuth install as the signed-in Kortix user.
 *
 * The provider sends the browser to the API callback, which hands it here with
 * `?project=&code=&state=`. The API installs only when the signed state names
 * this user and project, so an install always lands where the person who
 * started it meant it to. On success the browser goes to the same dashboard
 * page the old callback redirected to.
 */

import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { ConnectorHandshake } from '@/components/setup-links/connector-handshake';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import {
  AuthPendingScreen,
  AuthStatusScreen,
  DetailPanel,
  DetailRow,
} from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import type { ChannelInstallCompletion, ChannelInstallCompletionInput } from '@kortix/sdk';

type Failure = 'mismatch' | 'expired' | 'failed';

function failureOf(err: unknown): Failure {
  const { code, status } = (err ?? {}) as { code?: string; status?: number };
  if (code === 'CHANNEL_INSTALL_STATE_MISMATCH') return 'mismatch';
  if (code === 'CHANNEL_INSTALL_STATE_INVALID' || status === 400) return 'expired';
  return 'failed';
}

export function ChannelInstallComplete({
  service,
  icon: ServiceIcon,
  path,
  complete,
}: {
  /** Display name used in the copy ("Slack", "Teams"). */
  service: string;
  /** The service's mark, for the Kortix ··· service handshake above the title. */
  icon: React.ComponentType<{ className?: string }>;
  /** This page's path, used as the sign-in return target. */
  path: string;
  complete: (
    projectId: string,
    input: ChannelInstallCompletionInput,
  ) => Promise<ChannelInstallCompletion>;
}) {
  const t = useTranslations('hardcodedUi');
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get('project') ?? '';
  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';

  const incomplete = !projectId || !code || !state;
  const [failure, setFailure] = useState<Failure | null>(null);
  // A provider code is single-use: post it once, even when effects re-run.
  const posted = useRef(false);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace(`/auth?redirect=${encodeURIComponent(`${path}?${params.toString()}`)}`);
      return;
    }
    if (incomplete || posted.current) return;
    posted.current = true;
    complete(projectId, { code, state }).then(
      (result) => window.location.replace(result.redirect_url),
      (err: unknown) => setFailure(failureOf(err)),
    );
  }, [isLoading, user, path, params, router, complete, incomplete, projectId, code, state]);

  const shown: Failure | null = user && incomplete ? 'expired' : failure;
  // Until the session is known there is nothing true to say about the install.
  if (!shown && (isLoading || !user)) return <AuthPendingScreen />;

  // The install is being recorded. A bare spinner here said nothing about what
  // the page was doing or for whom; the browser leaves for the project as soon
  // as the API answers.
  if (!shown) {
    return (
      <AuthFrame>
        <Rise>
          <StepHeader
            mark={
              <ConnectorHandshake
                name={service}
                iconUrl={null}
                mark={<ServiceIcon className="size-5" />}
                size="lg"
                collapsible={false}
              />
            }
            title={t('channelInstall.finishingTitle', { service })}
            description={t('channelInstall.finishingDescription', { service })}
          />
        </Rise>
        <Rise delay={0.06}>
          <DetailPanel>
            <DetailRow label={t('channelInstall.installingAs')} value={user?.email ?? ''} />
          </DetailPanel>
          <div role="status" className="text-muted-foreground mt-5 flex items-center gap-2 text-sm">
            <Loading className="size-4 shrink-0" />
            <span>{t('channelInstall.recording')}</span>
          </div>
        </Rise>
      </AuthFrame>
    );
  }

  return (
    <AuthStatusScreen
      title={t('channelInstall.failedTitle', { service })}
      description={t(`channelInstall.${shown}`)}
      action={
        projectId ? (
          <Button size="lg" variant="secondary" className="w-full" asChild>
            <Link href={`/projects/${encodeURIComponent(projectId)}`}>
              {t('channelInstall.backToProject')}
            </Link>
          </Button>
        ) : null
      }
    />
  );
}
