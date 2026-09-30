'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useParams } from 'next/navigation';

import { CopyCommandBadge } from '@/features/auth/auth-consent';
import { ChatIdentityConnect } from '@/features/auth/chat-identity-connect';
import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import { bindTeamsIdentity, previewTeamsIdentity } from '@kortix/sdk';

/**
 * Teams bind page — the Teams twin of `/slack/login/<token>`. The bot sends a
 * short-lived signed link; after a normal Kortix login this page binds the
 * Teams user to the signed-in Kortix account so the agent runs as them.
 */
export default function TeamsLoginPage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  return (
    <ChatIdentityConnect
      service="Teams"
      icon={MicrosoftTeams}
      token={token}
      loginPath={`/teams/login/${token}`}
      bind={bindTeamsIdentity}
      preview={previewTeamsIdentity}
      missingLinkMessage={tI18nComplete.raw('text7390830dc0eb')}
      disconnectNote={
        <>
          {tI18nComplete.raw('textbf7e9458c251')}{' '}
          <CopyCommandBadge command={tI18nComplete.raw('text00270cf63f93')} />{' '}
          {tI18nComplete.raw('text55706ffa93eb')}
        </>
      }
    />
  );
}
