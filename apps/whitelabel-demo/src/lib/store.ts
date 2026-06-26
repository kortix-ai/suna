import 'server-only';

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from './config';

export interface DemoUser {
  id: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  kortixProjectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoSession {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface DemoRun {
  id: string;
  userId: string;
  projectId: string;
  sessionId: string;
  title: string;
  prompt: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
}

interface DemoDatabase {
  users: DemoUser[];
  sessions: DemoSession[];
  runs: DemoRun[];
}

const emptyDatabase = (): DemoDatabase => ({ users: [], sessions: [], runs: [] });

function databasePath() {
  return path.join(getDataDir(), 'whitelabel-demo.json');
}

async function readDatabase(): Promise<DemoDatabase> {
  try {
    const raw = await readFile(databasePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DemoDatabase>;
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDatabase();
    throw error;
  }
}

async function writeDatabase(database: DemoDatabase) {
  const file = databasePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(database, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function loadStore() {
  return readDatabase();
}

export async function mutateStore<T>(mutator: (database: DemoDatabase) => T | Promise<T>): Promise<T> {
  const database = await readDatabase();
  const result = await mutator(database);
  await writeDatabase(database);
  return result;
}

export async function findUserByEmail(email: string) {
  const database = await readDatabase();
  return database.users.find((user) => user.email.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function findUserById(userId: string) {
  const database = await readDatabase();
  return database.users.find((user) => user.id === userId) ?? null;
}

export async function findSession(sessionId: string) {
  const database = await readDatabase();
  return database.sessions.find((session) => session.id === sessionId) ?? null;
}

export async function listRunsForUser(userId: string) {
  const database = await readDatabase();
  return database.runs
    .filter((run) => run.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findRunForUser(userId: string, sessionId: string) {
  const database = await readDatabase();
  return database.runs.find((run) => run.userId === userId && run.sessionId === sessionId) ?? null;
}

export async function rememberRun(input: Omit<DemoRun, 'id' | 'createdAt' | 'updatedAt'>) {
  const now = new Date().toISOString();
  await mutateStore((database) => {
    const existing = database.runs.find(
      (run) => run.sessionId === input.sessionId && run.userId === input.userId,
    );
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      return;
    }
    database.runs.push({ id: input.sessionId, ...input, createdAt: now, updatedAt: now });
  });
}
