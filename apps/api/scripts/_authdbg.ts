import { createAccountToken } from '../src/repositories/account-tokens';
import { authorizeV2 } from '../src/iam/engine-v2';
import { ACCOUNT_ACTIONS } from '../src/iam';
import { db } from '../src/shared/db';
import { accountTokens } from '@kortix/db';
import { eq, desc } from 'drizzle-orm';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const r: any = await createAccountToken({ accountId: ACC, userId: ACC, name: 'authdbg' });
console.log('create result keys:', Object.keys(r));
console.log('tokenId:', r.tokenId, 'projectId:', r.projectId, 'secret prefix:', String(r.secretKey).slice(0, 12));

const rows = await db.select().from(accountTokens).where(eq(accountTokens.accountId, ACC)).orderBy(desc(accountTokens.createdAt)).limit(2);
console.log('latest token rows:', JSON.stringify(rows.map((x: any) => ({ tokenId: x.tokenId, projectId: x.projectId, revoked: x.revokedAt, expires: x.expiresAt }))));

console.log('PROJECT_CREATE action:', ACCOUNT_ACTIONS.PROJECT_CREATE);
const noTok = await authorizeV2(ACC, ACC, ACCOUNT_ACTIONS.PROJECT_CREATE);
console.log('authorizeV2 (no token):', JSON.stringify(noTok));
const withTok = await authorizeV2(ACC, ACC, ACCOUNT_ACTIONS.PROJECT_CREATE, undefined, r.tokenId);
console.log('authorizeV2 (with my tokenId):', JSON.stringify(withTok));
process.exit(0);
