'use client';

import { ConnectorIntake } from '@/components/setup-links/connector-intake';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { Rise } from '@kortix/ui/internal/auth/auth-primitives';
import { useParams } from 'next/navigation';

/** The quiet auth frame, like `/approve/[token]`: the Kortix ··· App handshake, the heading, the connect step. */
export default function ConnectIntakePage() {
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);

  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <ConnectorIntake token={token} />
      </Rise>
    </AuthFrame>
  );
}
