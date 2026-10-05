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
import { useParams } from 'next/navigation';

export default function ApprovalPage() {
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);
  return <ApprovalDecision token={token} />;
}
