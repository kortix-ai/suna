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

import { AuthPendingScreen, AuthStatusScreen } from '@/features/auth/auth-consent';
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
  path,
  complete,
}: {
  /** Display name used in the copy ("Slack", "Teams"). */
  service: string;
  /** This page's path, used as the sign-in return target. */
  path: string;
  complete: (projectId: string, input: ChannelInstallCompletionInput) => Promise<ChannelInstallCompletion>;
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
  if (!shown) return <AuthPendingScreen />;

  return (
    <AuthStatusScreen
      title={t('channelInstall.failedTitle', { service })}
      description={t(`channelInstall.${shown}`)}
      action={
        projectId ? (
          <p className="text-muted-foreground text-sm">
            <Link
              href={`/projects/${encodeURIComponent(projectId)}`}
              className="hover:text-foreground -my-2 inline-block py-2 underline-offset-4 transition-colors hover:underline"
            >
              {t('channelInstall.backToProject')}
            </Link>
          </p>
        ) : null
      }
    />
  );
}
