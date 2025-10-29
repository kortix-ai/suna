import { Amplify } from 'aws-amplify';
import {
  fetchAuthSession,
  signInWithRedirect,
  signOut as amplifySignOut,
  getCurrentUser,
} from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { CookieStorage } from 'aws-amplify/utils';

import { getCookieDomain } from './cookie-util';

// Define the user type
export interface CognitoUser {
  userId: string;
  username: string;
  email: string;
}

// Internal auth response from backend
export interface InternalAuthResponse {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  is_new_user: boolean;
  message: string;
}

// Environment-based configuration
const getEnvironmentConfig = () => {
  const environment = process.env.NEXT_PUBLIC_ENVIRONMENT || 'prod';
  const isLocal =
    typeof window !== 'undefined' &&
    window.location.hostname.includes('local.enso.bot');

  if (isLocal) {
    return {
      environment: 'local',
      userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || 'MISSING',
      userPoolClientId:
        process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID || 'MISSING',
      region: 'us-east-1',
      domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN || 'MISSING',
      redirectSignIn: [`https://super.local.enso.bot:3000/auth/callback`],
      redirectSignOut: [`https://local.enso.bot:5173/app`],
      cookieDomain: getCookieDomain(),
      baseDomain: 'local.enso.bot:5173',
      superDomain: 'super.local.enso.bot:3000',
    };
  }

  const baseDomain =
    environment === 'prod' ? 'enso.bot' : `${environment}.enso.bot`;
  const superDomain =
    environment === 'prod' ? 'super.enso.bot' : `super.${environment}.enso.bot`;

  return {
    environment,
    userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || '',
    userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID || '',
    region: process.env.NEXT_PUBLIC_COGNITO_REGION || 'us-east-1',
    domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN || '',
    redirectSignIn: [`https://${superDomain}/auth/callback`],
    redirectSignOut: [`https://${baseDomain}/app`],
    cookieDomain: getCookieDomain(),
    baseDomain,
    superDomain,
  };
};

export class CognitoAuthService {
  private static instance: CognitoAuthService;
  private isInitialized = false;
  private config = getEnvironmentConfig();

  static getInstance(): CognitoAuthService {
    if (!CognitoAuthService.instance) {
      CognitoAuthService.instance = new CognitoAuthService();
    }
    return CognitoAuthService.instance;
  }

  initialize() {
    if (this.isInitialized) {
      return;
    }

    if (
      !this.config.userPoolId ||
      !this.config.userPoolClientId ||
      !this.config.domain
    ) {
      console.error('[CognitoAuth] Missing required configuration:', {
        hasUserPoolId: !!this.config.userPoolId,
        hasUserPoolClientId: !!this.config.userPoolClientId,
        hasDomain: !!this.config.domain,
      });
      throw new Error('Missing required Cognito configuration');
    }

    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: this.config.userPoolId,
          userPoolClientId: this.config.userPoolClientId,
          loginWith: {
            oauth: {
              domain: this.config.domain,
              scopes: [
                'aws.cognito.signin.user.admin',
                'openid',
                'email',
                'profile',
              ],
              redirectSignIn: this.config.redirectSignIn,
              redirectSignOut: this.config.redirectSignOut,
              responseType: 'code',
            },
          },
        },
      },
    });

    cognitoUserPoolsTokenProvider.setKeyValueStorage(
      new CookieStorage({
        domain: this.config.cookieDomain,
        secure: true,
        sameSite: 'lax',
        path: '/',
      }),
    );

    this.isInitialized = true;
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const session = await fetchAuthSession();
      return !!session.tokens?.accessToken;
    } catch (error) {
      console.error('[CognitoAuth] Error checking authentication:', error);
      return false;
    }
  }

  async getAccessToken(): Promise<string | null> {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.accessToken?.toString() || null;
    } catch (error) {
      console.error('[CognitoAuth] Error getting access token:', error);
      return null;
    }
  }

  async getIdToken(): Promise<string | null> {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() || null;
    } catch (error) {
      console.error('[CognitoAuth] Error getting ID token:', error);
      return null;
    }
  }

  async getCurrentUser(): Promise<CognitoUser | null> {
    try {
      const user = await getCurrentUser();
      const session = await fetchAuthSession();

      return {
        userId: user.userId,
        username: user.username,
        email: session.tokens?.idToken?.payload?.email as string,
      };
    } catch (error) {
      console.error('[CognitoAuth] Error getting current user:', error);
      return null;
    }
  }

  /**
   * Perform internal authentication after Cognito auth succeeds.
   * This sends the Cognito ID token to our backend, which verifies it
   * and creates/returns our internal JWT.
   */
  async performInternalAuth(): Promise<InternalAuthResponse | null> {
    try {
      const cognitoToken = await this.getIdToken();

      if (!cognitoToken) {
        console.error('[CognitoAuth] No Cognito ID token available');
        return null;
      }

      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '';
      const apiUrl = `${backendUrl}/auth/cognito-verify`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cognito_token: cognitoToken,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error(
          '[CognitoAuth] Backend authentication failed:',
          errorData,
        );
        throw new Error(errorData.detail || 'Internal authentication failed');
      }

      const authData: InternalAuthResponse = await response.json();

      if (authData.is_new_user) {
        console.log('[CognitoAuth] New user created:', authData.user_id);
      }

      return authData;
    } catch (error) {
      console.error('[CognitoAuth] Internal authentication error:', error);
      return null;
    }
  }

  async signInWithGoogle() {
    await signInWithRedirect({ provider: 'Google' });
  }

  async signOut() {
    await amplifySignOut();
  }

  redirectToMainAppAuth() {
    const currentUrl = encodeURIComponent(window.location.href);
    const redirectUrl = `https://${this.config.baseDomain}/app/auth/signin?redirect=${currentUrl}`;
    window.location.href = redirectUrl;
  }

  // Public method to get the base domain for external use
  getBaseDomain(): string {
    return this.config.baseDomain;
  }

  // Public method to get account settings URL
  getAccountSettingsUrl(): string {
    return `https://${this.config.baseDomain}/app/settings/account`;
  }
}
