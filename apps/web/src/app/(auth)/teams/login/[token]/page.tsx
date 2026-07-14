'use client';

import { useParams } from 'next/navigation';

import { ChatIdentityConnect } from '@/features/auth/chat-identity-connect';
import { teamsIdentityApi } from '@/lib/api/teams-identity';

/**
 * Teams bind page — the Teams twin of `/slack/login/<token>`. The bot sends a
 * short-lived signed link; after a normal Kortix login this page binds the
 * Teams user to the signed-in Kortix account so the agent runs as them.
 */
export default function TeamsLoginPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  return (
    <ChatIdentityConnect
      service="Teams"
      token={token}
      loginPath={`/teams/login/${token}`}
      bind={(t) => teamsIdentityApi.bind(t)}
      missingLinkMessage="This page is opened from a Kortix message in Teams. Start the login from Teams to get a fresh link."
      disconnectNote={
        <>
          Disconnect anytime with the <span className="text-foreground font-mono">logout</span>{' '}
          command in Teams.
        </>
      }
    />
  );
}
