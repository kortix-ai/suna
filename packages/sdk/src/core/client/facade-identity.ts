import { createKortixSession } from '../auth/session';
import * as A from '../rest/platform-client/auth';
import type { HeadlessAuthApi } from '../rest/platform-client/auth';
import * as P from '../rest/projects-client';
import { bindAccounts } from './facade-accounts';
import { bindIam } from './facade-iam';
export function bindIdentity() {
  const auth: HeadlessAuthApi = {
    signUp: A.signUp,
    signInWithPassword: A.signInWithPassword,
    sendMagicLink: A.sendMagicLink,
    verifyOtp: A.verifyOtp,
    signInWithProvider: A.signInWithProvider,
    exchangeCode: A.exchangeCode,
    refresh: A.refreshSession,
    resetPassword: A.resetPassword,
    updatePassword: A.updatePassword,
    updateUserMetadata: A.updateUserMetadata,
    signInWithSso: A.signInWithSso,
    mfa: A.authMfa,
    user: A.authUser,
    signOut: A.signOut,
    session: createKortixSession,
  };

  /** Account-scoped operations. */
  const accounts = bindAccounts();

  const iam = bindIam();

  const accountInvites = {
    /** The caller's own pending invites, matched by email. */
    listMine: P.listMyAccountInvites,
    describe: P.describeAccountInvite,
    accept: P.acceptAccountInvite,
    decline: P.declineAccountInvite,
  };

  return { auth, accounts, iam, accountInvites };
}
