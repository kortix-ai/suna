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

  console.log('🔐 [Auth Config] Building configuration:', {
    environment,
    isLocal,
  });

  // LOCAL DEVELOPMENT CONFIGURATION
  if (isLocal) {
    const config = {
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
    console.log('🔐 [Auth Config] Local config created:', config);
    return config;
  }

  // Base domains based on environment
  const baseDomain =
    environment === 'prod' ? 'enso.bot' : `${environment}.enso.bot`;
  const superDomain =
    environment === 'prod' ? 'super.enso.bot' : `super.${environment}.enso.bot`;

  const config = {
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

  console.log('🔐 [Auth Config] Production/Staging config created:', config);
  return config;
};

export class CognitoAuthService {
  private static instance: CognitoAuthService;
  private isInitialized = false;
  private config = getEnvironmentConfig();

  static getInstance(): CognitoAuthService {
    if (!CognitoAuthService.instance) {
      console.log('🔐 [Auth Service] Creating new instance');
      CognitoAuthService.instance = new CognitoAuthService();
    }
    return CognitoAuthService.instance;
  }

  initialize() {
    if (this.isInitialized) {
      console.log('🔐 [Auth Service] Already initialized, skipping');
      return;
    }

    console.log('🔐 [Auth Service] Starting initialization...');

    // Validate required config
    if (
      !this.config.userPoolId ||
      !this.config.userPoolClientId ||
      !this.config.domain
    ) {
      console.error(
        '❌ [Auth Service] Missing required environment variables:',
        {
          hasUserPoolId: !!this.config.userPoolId,
          hasUserPoolClientId: !!this.config.userPoolClientId,
          hasDomain: !!this.config.domain,
        },
      );
      throw new Error('Missing required Cognito configuration');
    }

    console.log('🔐 [Auth Service] Configuration validated:', {
      userPoolId: this.config.userPoolId,
      clientId: this.config.userPoolClientId?.substring(0, 8) + '...',
      domain: this.config.domain,
      redirectSignIn: this.config.redirectSignIn,
      redirectSignOut: this.config.redirectSignOut,
    });

    // Configure Amplify with environment-specific settings
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

    console.log('✅ [Auth Service] Amplify configured');

    // Configure CookieStorage for cross-domain token sharing
    cognitoUserPoolsTokenProvider.setKeyValueStorage(
      new CookieStorage({
        domain: this.config.cookieDomain,
        secure: true,
        sameSite: 'lax',
        path: '/',
      }),
    );

    console.log(
      '✅ [Auth Service] Cookie storage configured for domain:',
      this.config.cookieDomain,
    );

    this.isInitialized = true;
    console.log('✅ [Auth Service] Initialization complete');
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      console.log('🔐 [Auth Service] Checking authentication status...');
      const session = await fetchAuthSession();
      const isAuth = !!session.tokens?.accessToken;
      console.log('🔐 [Auth Service] Authentication status:', isAuth);
      return isAuth;
    } catch (error) {
      console.error('❌ [Auth Service] Error checking authentication:', error);
      return false;
    }
  }

  async getAccessToken(): Promise<string | null> {
    try {
      console.log('🔐 [Auth Service] Fetching access token...');
      const session = await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString() || null;
      console.log('🔐 [Auth Service] Access token retrieved:', !!token);
      return token;
    } catch (error) {
      console.error('❌ [Auth Service] Error getting access token:', error);
      return null;
    }
  }

  async getCurrentUser(): Promise<CognitoUser | null> {
    try {
      console.log('🔐 [Auth Service] Getting current user...');
      const user = await getCurrentUser();
      const session = await fetchAuthSession();

      const userData = {
        userId: user.userId,
        username: user.username,
        email: session.tokens?.idToken?.payload?.email as string,
      };

      console.log('✅ [Auth Service] User data retrieved:', {
        userId: userData.userId,
        username: userData.username,
        email: userData.email,
      });

      return userData;
    } catch (error) {
      console.error('❌ [Auth Service] Error getting current user:', error);
      return null;
    }
  }

  /**
   * Perform internal authentication after Cognito auth succeeds.
   * This sends the Cognito token to our backend, which verifies it
   * and creates/returns our internal JWT.
   */
  async performInternalAuth(): Promise<InternalAuthResponse | null> {
    try {
      console.log('🔐 [Internal Auth] Starting internal authentication...');

      const cognitoToken = await this.getAccessToken();

      if (!cognitoToken) {
        console.error('❌ [Internal Auth] No Cognito token available');
        return null;
      }

      console.log(
        '🔐 [Internal Auth] Cognito token obtained, calling backend...',
      );

      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '';
      const apiUrl = `${backendUrl}/auth/cognito-verify`;

      console.log('🔐 [Internal Auth] Calling:', apiUrl);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cognito_token: cognitoToken,
        }),
      });

      console.log(
        '🔐 [Internal Auth] Backend response status:',
        response.status,
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('❌ [Internal Auth] Backend returned error:', errorData);
        throw new Error(errorData.detail || 'Internal authentication failed');
      }

      const authData: InternalAuthResponse = await response.json();

      console.log('✅ [Internal Auth] Authentication successful:', {
        userId: authData.user_id,
        email: authData.email,
        isNewUser: authData.is_new_user,
        message: authData.message,
      });

      if (authData.is_new_user) {
        console.log('🎉 [Internal Auth] NEW USER CREATED!');
      }

      return authData;
    } catch (error) {
      console.error(
        '❌ [Internal Auth] Error during internal authentication:',
        error,
      );
      return null;
    }
  }

  async signInWithGoogle() {
    console.log('🔐 [Auth Service] Initiating Google sign-in redirect...');
    await signInWithRedirect({ provider: 'Google' });
  }

  async signOut() {
    console.log('🔐 [Auth Service] Signing out...');
    await amplifySignOut();
    console.log('✅ [Auth Service] Sign out complete');
  }

  // Method to redirect to main app for authentication
  redirectToMainAppAuth() {
    const currentUrl = encodeURIComponent(window.location.href);
    const redirectUrl = `https://${this.config.baseDomain}/app/auth/signin?redirect=${currentUrl}`;
    console.log('🔐 [Auth Service] Redirecting to main app auth:', redirectUrl);
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
