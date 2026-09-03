import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The three sign-in actions must honor WHO the middleware bounced.
 *
 * `callback/bounce-attribution.test.ts` covers the OAuth/magic-link handler.
 * Password and OTP sign-in never touch that route, so the same rule has to be
 * proven on the server actions — including the LINK-MINT gate, which is the
 * only place that can stop a poisoned path before it leaves the browser
 * entirely inside an emailed sign-in link.
 */

const A_PROJECT = '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c';
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const LANDING = '/projects/start';

const jar = new Map<string, string>();
let signedInUserId = USER_B;
let userCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
let otpEmailRedirectTo: string | null = null;
let signUpError: { message: string; status?: number } | null = null;

mock.module('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

function signedInUser() {
  return { id: signedInUserId, created_at: userCreatedAt, user_metadata: {} };
}

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async (options: { options?: { emailRedirectTo?: string } }) => {
        otpEmailRedirectTo = options.options?.emailRedirectTo ?? null;
        return { error: null };
      },
      signUp: async () => ({ data: {}, error: signUpError }),
      signInWithPassword: async () => ({
        data: { user: signedInUser(), session: { access_token: 'tok', refresh_token: 'ref' } },
        error: null,
      }),
      verifyOtp: async () => ({
        data: { user: signedInUser(), session: { access_token: 'tok', refresh_token: 'ref' } },
        error: null,
      }),
    },
  }),
}));

// A dead BACKEND_URL, so `checkEmailFlowMode` fails open to 'unknown' — the
// case where the API cannot say whether the address is new. That is the exact
// state in which only bounce attribution can still tell these apart.
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({
    APP_URL: 'https://dev.kortix.com',
    BACKEND_URL: 'http://127.0.0.1:1/v1',
    BILLING_ENABLED: false,
  }),
}));

const { sendEmailCode, signInWithPassword, signUpWithPassword, verifyOtp } =
  await import('./actions');
const { AUTH_BOUNCE_COOKIE, serializeAuthBounce } =
  await import('@/lib/onboarding/landing-destination');

function bounce(ownerId: string | null) {
  jar.set(AUTH_BOUNCE_COOKIE, serializeAuthBounce(ownerId, A_PROJECT));
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  jar.clear();
  signedInUserId = USER_B;
  userCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  otpEmailRedirectTo = null;
  signUpError = null;
});

describe('signInWithPassword', () => {
  async function destination(): Promise<string> {
    const result = (await signInWithPassword(
      null,
      form({ email: 'b@example.com', password: 'password123', returnUrl: A_PROJECT }),
    )) as { redirectTo?: string };
    return result.redirectTo as string;
  }

  test('bounced as A, signed in as B → demoted to the landing door', async () => {
    bounce(USER_A);

    expect(await destination()).toStartWith(LANDING);
  });

  test('bounced as A, signed in as A → keeps the path', async () => {
    signedInUserId = USER_A;
    bounce(USER_A);

    expect(await destination()).toStartWith(A_PROJECT);
  });

  test('an UNATTRIBUTED bounce keeps the path', async () => {
    bounce(null);

    expect(await destination()).toStartWith(A_PROJECT);
  });

  test('no bounce cookie keeps the path', async () => {
    expect(await destination()).toStartWith(A_PROJECT);
  });

  test('the bounce is cleared — password sign-in never reaches /auth/callback', async () => {
    bounce(USER_A);
    await destination();

    expect(jar.has(AUTH_BOUNCE_COOKIE)).toBe(false);
  });
});

describe('verifyOtp', () => {
  async function destination(): Promise<string> {
    const result = (await verifyOtp(
      null,
      form({ email: 'b@example.com', token: '123456', returnUrl: A_PROJECT }),
    )) as { redirectTo?: string };
    return result.redirectTo as string;
  }

  test('bounced as A, signed in as B → demoted to the landing door', async () => {
    bounce(USER_A);

    expect(await destination()).toBe(LANDING);
  });

  test('bounced as A, signed in as A → keeps the path', async () => {
    // The code was typed in the same browser that was bounced, so the full deep
    // link survives even though the emailed link for the same request would not.
    signedInUserId = USER_A;
    bounce(USER_A);

    expect(await destination()).toBe(A_PROJECT);
  });

  test('an UNATTRIBUTED bounce keeps the path', async () => {
    bounce(null);

    expect(await destination()).toBe(A_PROJECT);
  });

  test('the bounce is cleared — OTP sign-in never reaches /auth/callback', async () => {
    bounce(USER_A);
    await destination();

    expect(jar.has(AUTH_BOUNCE_COOKIE)).toBe(false);
  });
});

describe('signUpWithPassword is also a sign-IN door for an existing account', () => {
  // `alreadyExists` + a correct password is a sign-in wearing the sign-up
  // form's clothes, and it kept the raw return URL. That is the same
  // second-paid-account case the sign-in action had, spelled differently, so it
  // needs the same gate.
  async function destination(): Promise<string> {
    signUpError = { message: 'User already registered', status: 422 };
    const result = (await signUpWithPassword(
      null,
      form({
        email: 'b@example.com',
        password: 'password123',
        confirmPassword: 'password123',
        returnUrl: A_PROJECT,
      }),
    )) as { redirectTo?: string };
    return result.redirectTo as string;
  }

  test('bounced as A, signed in as B → demoted to the landing door', async () => {
    bounce(USER_A);

    expect(await destination()).toBe(LANDING);
  });

  test('bounced as A, signed in as A → keeps the path', async () => {
    signedInUserId = USER_A;
    bounce(USER_A);

    expect(await destination()).toBe(A_PROJECT);
  });

  test('an UNATTRIBUTED bounce keeps the path', async () => {
    bounce(null);

    expect(await destination()).toBe(A_PROJECT);
  });

  test('a real signup is demoted whatever the bounce says', async () => {
    signUpError = null;
    const result = (await signUpWithPassword(
      null,
      form({
        email: 'new@example.com',
        password: 'password123',
        confirmPassword: 'password123',
        returnUrl: A_PROJECT,
      }),
    )) as { redirectTo?: string };

    expect(result.redirectTo).toBe(LANDING);
  });
});

describe('sendEmailCode mints the link, so the gate has to run there', () => {
  async function mintedReturnUrl(): Promise<string | null> {
    await sendEmailCode(
      null,
      form({
        email: 'b@example.com',
        returnUrl: A_PROJECT,
        origin: 'https://dev.kortix.com',
      }),
    );
    if (!otpEmailRedirectTo) return null;
    return new URL(otpEmailRedirectTo).searchParams.get('returnUrl');
  }

  test('an ATTRIBUTED bounce never reaches the email', async () => {
    // The link outlives this browser: it can be opened on a phone that never
    // held A's session, where no bounce cookie exists to catch it. There is no
    // identity to compare against yet, so the path does not travel.
    bounce(USER_A);

    expect(await mintedReturnUrl()).toBe(LANDING);
  });

  test('an UNATTRIBUTED bounce still mints the real path', async () => {
    bounce(null);

    expect(await mintedReturnUrl()).toBe(A_PROJECT);
  });

  test('no bounce cookie still mints the real path — a shared project link', async () => {
    expect(await mintedReturnUrl()).toBe(A_PROJECT);
  });

  test('the bounce is NOT cleared here — nobody has authenticated yet', async () => {
    // Clearing on the way out would un-gate the code the user is about to type.
    bounce(USER_A);
    await mintedReturnUrl();

    expect(jar.has(AUTH_BOUNCE_COOKIE)).toBe(true);
  });
});
