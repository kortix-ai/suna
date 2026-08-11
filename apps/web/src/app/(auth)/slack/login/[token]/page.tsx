'use client';

import { useParams } from 'next/navigation';

import { ChatIdentityConnect } from '@/features/auth/chat-identity-connect';
import { bindSlackIdentity } from '@kortix/sdk';

/**
 * Slack `/login` bind page. The bot DMs the user a link to
 * `/slack/login/<token>`; the token is a short-lived signed payload carrying
 * the Slack workspace + user id. This page requires a normal dosco login, then
 * POSTs the token (with the user's bearer) to the API, which binds the Slack
 * user to this dosco account so the agent runs as THEM — not the installer.
 */
export default function SlackLoginPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  return (
    <ChatIdentityConnect
      service="Slack"
      token={token}
      loginPath={`/slack/login/${token}`}
      bind={bindSlackIdentity}
      missingLinkMessage="This page is opened from a dosco message in Slack. Run /kortix login in Slack to get a fresh link."
      disconnectNote={
        <>
          Disconnect anytime with <span className="text-foreground font-mono">/kortix logout</span>{' '}
          in Slack.
        </>
      }
    />
  );
}
