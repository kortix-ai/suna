import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_CALLBACK_STATE_KEY = '@kortix_auth_callback_state';
const WEB_REGISTRATION_HANDOFF_KEY = '@kortix_web_registration_handoff';
const AUTH_CALLBACK_STATE_TTL_MS = 10 * 60 * 1000;

function randomState(): string {
  const bytes = new Uint8Array(24);
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export async function createAuthCallbackState(): Promise<string> {
  const state = randomState();
  await AsyncStorage.setItem(
    AUTH_CALLBACK_STATE_KEY,
    JSON.stringify({
      state,
      expiresAt: Date.now() + AUTH_CALLBACK_STATE_TTL_MS,
    })
  );
  return state;
}

export async function createAuthCallbackRedirect(
  params?: Record<string, string | boolean | undefined>
): Promise<string> {
  const search = new URLSearchParams();
  const state = await createAuthCallbackState();
  search.set('state', state);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === false) continue;
    search.set(key, value === true ? 'true' : value);
  }
  return `kortix://auth/callback?${search.toString()}`;
}

export async function consumeAuthCallbackState(state: string | null | undefined): Promise<boolean> {
  if (!state) return false;
  const raw = await AsyncStorage.getItem(AUTH_CALLBACK_STATE_KEY);
  await AsyncStorage.removeItem(AUTH_CALLBACK_STATE_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; expiresAt?: unknown };
    return (
      parsed.state === state &&
      typeof parsed.expiresAt === 'number' &&
      parsed.expiresAt >= Date.now()
    );
  } catch {
    return false;
  }
}

/** Allow exactly one newly-created session after a verified web handoff. */
export async function grantWebRegistrationHandoff(): Promise<void> {
  await AsyncStorage.setItem(
    WEB_REGISTRATION_HANDOFF_KEY,
    JSON.stringify({
      expiresAt: Date.now() + AUTH_CALLBACK_STATE_TTL_MS,
    })
  );
}

/** Consume the short-lived new-account admission grant. */
export async function consumeWebRegistrationHandoff(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(WEB_REGISTRATION_HANDOFF_KEY);
  await AsyncStorage.removeItem(WEB_REGISTRATION_HANDOFF_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { expiresAt?: unknown };
    return typeof parsed.expiresAt === 'number' && parsed.expiresAt >= Date.now();
  } catch {
    return false;
  }
}

export async function clearWebRegistrationHandoff(): Promise<void> {
  await AsyncStorage.removeItem(WEB_REGISTRATION_HANDOFF_KEY);
}
