'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useParams } from 'next/navigation';

import { ChatIdentityConnect } from '@/features/auth/chat-identity-connect';
import { bindSlackIdentity } from '@kortix/sdk';

/**
 * Slack `/login` bind page. The bot DMs the user a link to
 * `/slack/login/<token>`; the token is a short-lived signed payload carrying
 * the Slack workspace + user id. This page requires a normal Kortix login, then
 * POSTs the token (with the user's bearer) to the API, which binds the Slack
 * user to this Kortix account so the agent runs as THEM — not the installer.
 */
export default function SlackLoginPage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  return (
    <ChatIdentityConnect
      service="Slack"
      token={token}
      loginPath={`/slack/login/${token}`}
      bind={bindSlackIdentity}
      missingLinkMessage={tI18nComplete.raw('text86d74a15857f')}
      disconnectNote={
        <>
          {tI18nComplete.raw('text64cc97c96c03')}{' '}
          <span className="text-foreground font-mono">{tI18nComplete.raw('text242443486b8c')}</span>{' '}
          {tI18nComplete.raw('text017245d54fdb')}
        </>
      }
    />
  );
}
