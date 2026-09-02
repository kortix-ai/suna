import { apiKey } from '@better-auth/api-key';
import { expo } from '@better-auth/expo';
import { i18n, locales } from '@better-auth/i18n';
import { mcp } from '@better-auth/mcp';
import { passkey } from '@better-auth/passkey';
import { captcha, lastLoginMethod, oneTap, openAPI } from 'better-auth/plugins';
import { admin } from 'better-auth/plugins/admin';
import { anonymous } from 'better-auth/plugins/anonymous';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { haveIBeenPwned } from 'better-auth/plugins/haveibeenpwned';
import { jwt } from 'better-auth/plugins/jwt';
import { magicLink } from 'better-auth/plugins/magic-link';
import { multiSession } from 'better-auth/plugins/multi-session';
import { oAuthProxy } from 'better-auth/plugins/oauth-proxy';
import { oneTimeToken } from 'better-auth/plugins/one-time-token';
import { organization } from 'better-auth/plugins/organization';
import { phoneNumber } from 'better-auth/plugins/phone-number';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { username } from 'better-auth/plugins/username';
import { convex } from 'kitcn/auth';
import { ac, roles } from '../lib/access-control';
import { getEnv } from '../lib/get-env';
import authConfig from './auth.config';
import { defineAuth } from './generated/auth';

/**
 * Kortix identity on Better Auth (ADR-007 §2). Every plugin that runs on the
 * Convex V8 runtime is enabled here. `@better-auth/sso` and `@better-auth/scim`
 * need Node and mount in the Kortix API instead (ADR-007 R1/R2).
 *
 * Email delivery is a stub until Phase 1 wires Resend through a Convex action.
 * The stubs log and return; they never throw, so sign-up and invitations
 * complete locally.
 */
const notifyStub = (kind: string) => async (payload: Record<string, unknown>) => {
  console.log(`[auth:email:${kind}]`, JSON.stringify(payload));
};

export default defineAuth(() => {
  const env = getEnv();
  const siteUrl = env.SITE_URL;
  const siteHost = new URL(siteUrl).hostname;

  return {
    appName: 'Kortix',
    baseURL: siteUrl,
    trustedOrigins: [siteUrl, env.KORTIX_API_URL],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }) => notifyStub('reset-password')({ to: user.email, url }),
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => notifyStub('verify-email')({ to: user.email, url }),
    },
    socialProviders: {
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
    },
    user: {
      deleteUser: { enabled: true },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    telemetry: { enabled: false },
    plugins: [
      // oauth-provider (via mcp) resolves the plugin with id 'jwt'. kitcn's convex plugin
      // embeds its own jwt instance under id 'convex'. Both define endpoints keyed
      // getJwks/getToken and Better Auth keeps the LAST plugin's endpoint per key, so
      // jwt() goes first: its jwksPath matches the convex plugin's, and convex() wins
      // /convex/jwks + /convex/token. Same RS256 alg, same 'jwks' table.
      jwt({ jwks: { keyPairConfig: { alg: 'RS256' }, jwksPath: '/convex/jwks' } }),
      convex({ authConfig, jwks: env.JWKS }),
      organization({
        ac,
        roles,
        allowUserToCreateOrganization: true,
        creatorRole: 'owner',
        membershipLimit: 1000,
        invitationExpiresIn: 60 * 60 * 48,
        cancelPendingInvitationsOnReInvite: true,
        teams: { enabled: true, maximumTeams: 50, allowRemovingAllTeams: true },
        dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 50 },
        sendInvitationEmail: async ({ email, organization: org, inviter, id }) =>
          notifyStub('org-invitation')({
            to: email,
            organization: org.name,
            inviter: inviter.user.email,
            url: `${siteUrl}/accept-invitation/${id}`,
          }),
      }),
      admin({ adminRoles: ['admin'], defaultRole: 'user' }),
      apiKey({ enableMetadata: true, enableSessionForAPIKeys: true, rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 } }),
      twoFactor({ issuer: 'Kortix' }),
      passkey({ rpID: siteHost, rpName: 'Kortix', origin: siteUrl }),
      magicLink({
        sendMagicLink: async ({ email, url }) => notifyStub('magic-link')({ to: email, url }),
      }),
      emailOTP({
        sendVerificationOTP: async ({ email, otp, type }) => notifyStub('email-otp')({ to: email, otp, type }),
      }),
      phoneNumber({
        sendOTP: async ({ phoneNumber: to, code }) => notifyStub('phone-otp')({ to, code }),
      }),
      genericOAuth({ config: [] }),
      // mcp() wraps oauthProvider(); the Kortix API is the protected resource.
      mcp({ resource: env.KORTIX_API_URL, loginPage: '/auth', consentPage: '/auth/consent' }),
      deviceAuthorization({ verificationUri: `${siteUrl}/device` }),
      bearer(),
      multiSession(),
      oneTimeToken(),
      username(),
      anonymous(),
      lastLoginMethod(),
      haveIBeenPwned(),
      openAPI(),
      i18n({ translations: locales }),
      expo(),
      ...(env.GOOGLE_CLIENT_ID ? [oneTap()] : []),
      ...(env.TURNSTILE_SECRET_KEY
        ? [captcha({ provider: 'cloudflare-turnstile', secretKey: env.TURNSTILE_SECRET_KEY })]
        : []),
      ...(env.DEPLOY_ENV === 'preview' ? [oAuthProxy()] : []),
    ],
  };
});
