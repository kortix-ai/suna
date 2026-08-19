'use client';

/**
 * Standalone approval page — the surface a human lands on from an approval link,
 * wherever that link was relayed (in-platform, chat, email).
 *
 * NOT in PUBLIC_ROUTES on purpose: the middleware bounces an anonymous visitor
 * to /auth?redirect=/approve/<token> and returns them here after sign-in, which
 * is exactly the required flow — the token says which decision is being asked
 * for, and the signed-in account supplies the authority to make it.
 */

import { ApprovalDecision } from '@/components/setup-links/approval-decision';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { useParams } from 'next/navigation';

export default function ApprovalPage() {
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);

  return (
    <div className="bg-background flex min-h-screen w-full items-center justify-center px-4 py-10">
      <main className="w-full max-w-lg space-y-6">
        <div className="flex justify-center">
          <KortixLogo />
        </div>
        <header className="space-y-1 text-center">
          <h1 className="text-foreground text-xl font-medium text-balance">
            An agent needs your approval
          </h1>
          <p className="text-muted-foreground text-sm text-pretty">
            Review the exact parameters. Your decision applies to this call only.
          </p>
        </header>
        <ApprovalDecision token={token} />
      </main>
    </div>
  );
}
