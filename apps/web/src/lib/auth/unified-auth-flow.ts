/**
 * Pure logic for the unified email-first auth flow ("one system"): the visitor
 * types an email, Continue resolves whether that address already has an
 * account, and the credentials step renders in the mode the flow already
 * knows — sign-in for existing accounts, registration for new ones. Nobody is
 * ever told "Invalid login credentials" for an account that doesn't exist.
 *
 * Everything here is deliberately side-effect free so the mode resolution and
 * error-copy mapping are unit-testable without Supabase or the API.
 */

export type AuthMethod = 'magic' | 'password';

/** What the credentials (password) step knows about the address. */
export type CredentialsMode = 'signin' | 'signup' | 'unknown';

/**
 * `CredentialsMode` plus the terminal outcomes: 'closed' (signups off, address
 * not allowlisted) and 'sso' (the domain's org enforces SSO-only sign-in — the
 * password/email-code paths must refuse and route to the IdP).
 */
export type EmailFlowMode = CredentialsMode | 'closed' | 'sso';

export const SIGNUPS_CLOSED_MESSAGE =
  'Signups are currently closed. Contact your administrator or request access.';

export const SSO_REQUIRED_MESSAGE =
  'Your organization requires single sign-on. Continue with SSO instead.';

const WRONG_PASSWORD_MESSAGE =
  'Incorrect password. Try again, or reset it via “Forgot your password?”.';

/** Parse `KORTIX_PUBLIC_AUTH_METHODS` ("magic,password") with a safe default. */
export function parseAuthMethods(raw: string | null | undefined): AuthMethod[] {
  const parsed = (raw || 'magic,password')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AuthMethod => s === 'magic' || s === 'password');
  return parsed.length ? parsed : ['magic', 'password'];
}

/**
 * Map a `POST /access/check-email` response body onto a flow mode. Tolerates
 * the legacy `{ allowed }`-only shape (API older than the web) and any failure
 * shape by degrading to 'unknown' — the credentials step then submits through
 * the adaptive signup action, which signs in existing users and registers new
 * ones, so a degraded check never strands anyone.
 */
export function resolveEmailFlowMode(check: unknown): EmailFlowMode {
  if (!check || typeof check !== 'object') return 'unknown';
  const { mode, allowed } = check as { mode?: unknown; allowed?: unknown };
  if (mode === 'signin' || mode === 'signup' || mode === 'closed' || mode === 'sso') return mode;
  if (allowed === false) return 'closed';
  return 'unknown';
}

export interface CredentialsCopy {
  title: string;
  description: string | null;
  passwordPlaceholder: string;
  passwordAutoComplete: 'current-password' | 'new-password';
  showForgotPassword: boolean;
  /**
   * Which server action the submit uses. 'unknown' submits as signup because
   * that action is adaptive: it registers new emails and signs in existing
   * ones when the password matches.
   */
  submitsAs: 'signin' | 'signup';
}

export function credentialsCopy(mode: CredentialsMode): CredentialsCopy {
  if (mode === 'signin') {
    return {
      title: 'Welcome back',
      description: 'Enter your password to continue.',
      passwordPlaceholder: 'Your password',
      passwordAutoComplete: 'current-password',
      showForgotPassword: true,
      submitsAs: 'signin',
    };
  }
  if (mode === 'signup') {
    return {
      title: 'Create your account',
      description: 'Choose a password to get started.',
      passwordPlaceholder: 'Create a password',
      passwordAutoComplete: 'new-password',
      showForgotPassword: false,
      submitsAs: 'signup',
    };
  }
  return {
    title: 'Enter your password',
    description: null,
    passwordPlaceholder: 'Your password',
    passwordAutoComplete: 'current-password',
    showForgotPassword: true,
    submitsAs: 'signup',
  };
}

export interface PasswordFailure {
  message: string;
  /** The attempt proved the account exists — relabel the step as sign-in. */
  switchToSignin?: boolean;
}

/**
 * Turn a structured password-action failure into user copy. Because the flow
 * resolved existence before the password step, 'invalid_credentials' on a
 * known account means exactly "wrong password" — say so instead of the
 * ambiguous GoTrue message. An 'existing_account_wrong_password' from the
 * adaptive signup path likewise proves existence, so the step flips to
 * sign-in and the copy explains what happened.
 */
export function passwordFailureCopy({
  mode,
  code,
  fallback,
}: {
  mode: CredentialsMode;
  code?: string | null;
  fallback?: string | null;
}): PasswordFailure {
  if (code === 'invalid_credentials' && mode === 'signin') {
    return { message: WRONG_PASSWORD_MESSAGE };
  }
  if (code === 'existing_account_wrong_password') {
    if (mode === 'signup') {
      return {
        message: 'You already have an account — enter your existing password to sign in.',
        switchToSignin: true,
      };
    }
    return { message: WRONG_PASSWORD_MESSAGE, switchToSignin: true };
  }
  return { message: fallback || 'An unexpected error occurred' };
}
