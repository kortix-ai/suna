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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useParams } from 'next/navigation';

export default function ApprovalPage() {
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);

  return (
    <div className="bg-background flex min-h-screen w-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <KortixLogo />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">An agent needs your approval</CardTitle>
            <CardDescription>
              Review exactly what it wants to do, then approve or deny. It stays paused until you
              decide.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ApprovalDecision token={token} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
