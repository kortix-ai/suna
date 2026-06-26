import 'server-only';

import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { findSession, findUserByEmail, findUserById, mutateStore, type DemoUser } from './store';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'kortix_whitelabel_demo_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return { salt, hash: derived.toString('hex') };
}

async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const { hash } = await hashPassword(password, salt);
  const actual = Buffer.from(hash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeEmail(value: FormDataEntryValue | string | null) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizePassword(value: FormDataEntryValue | string | null) {
  return String(value ?? '');
}

export async function createUser(email: string, password: string) {
  if (!email.includes('@')) throw new Error('Enter a valid email.');
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  const existing = await findUserByEmail(email);
  if (existing) throw new Error('A demo user already exists for that email.');

  const now = new Date().toISOString();
  const passwordRecord = await hashPassword(password);
  return mutateStore<DemoUser>((database) => {
    const user: DemoUser = {
      id: randomUUID(),
      email,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      kortixProjectId: null,
      createdAt: now,
      updatedAt: now,
    };
    database.users.push(user);
    return user;
  });
}

export async function authenticateUser(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user) return null;
  const ok = await verifyPassword(password, user.passwordSalt, user.passwordHash);
  return ok ? user : null;
}

export async function createBrowserSession(userId: string) {
  const now = new Date();
  const sessionId = randomUUID();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await mutateStore((database) => {
    database.sessions = database.sessions.filter((session) => new Date(session.expiresAt).getTime() > now.getTime());
    database.sessions.push({
      id: sessionId,
      userId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  });
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearBrowserSession() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(COOKIE_NAME)?.value;
  cookieStore.delete(COOKIE_NAME);
  if (!sessionId) return;
  await mutateStore((database) => {
    database.sessions = database.sessions.filter((session) => session.id !== sessionId);
  });
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(COOKIE_NAME)?.value;
  if (!sessionId) return null;
  const session = await findSession(sessionId);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
  return findUserById(session.userId);
}

export async function requireCurrentUser() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}
