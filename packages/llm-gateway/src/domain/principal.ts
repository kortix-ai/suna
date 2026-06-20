export interface AuthedPrincipal {
  userId: string;
  accountId: string;
  projectId?: string;
  sessionId?: string;
  keyId?: string;
}

export type BillingMode = 'credits' | 'platform-fee' | 'none';
