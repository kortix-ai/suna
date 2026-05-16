import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig } from "./env";
import type { Project, Proposal, SecretMetadata, SessionRun } from "./types";

let db: Database | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function openDb(): Database {
  if (db) return db;
  const cfg = getConfig();
  const dbPath = join(cfg.dataDir, "kortix-v0.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      manifest_path TEXT NOT NULL DEFAULT 'kortix.toml',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      sandbox_provider TEXT NOT NULL,
      sandbox_id TEXT,
      sandbox_url TEXT,
      opencode_session_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, branch_name)
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      status TEXT NOT NULL,
      diff_stat_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_secrets (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, key)
    );
  `);
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_name TEXT NOT NULL DEFAULT 'default'");
  } catch {
    // Column already exists on upgraded local databases.
  }
  return db;
}

function secretKeyPath(): string {
  return join(getConfig().dataDir, "secret.key");
}

function secretKey(): Buffer {
  const path = secretKeyPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    return Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString("base64"), { mode: 0o600 });
  return key;
}

function validateSecretName(key: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error("Secret key must be an uppercase environment variable name");
  }
}

function secretAad(projectId: string, key: string): Buffer {
  return Buffer.from(`${projectId}:${key}`, "utf8");
}

function encryptSecret(projectId: string, key: string, value: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(secretAad(projectId, key));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret(row: any): string {
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(row.iv, "base64"));
  decipher.setAAD(secretAad(row.project_id, row.key));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function projectFromRow(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    manifestPath: row.manifest_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sessionFromRow(row: any): SessionRun {
  return {
    id: row.id,
    projectId: row.project_id,
    branchName: row.branch_name,
    baseRef: row.base_ref,
    sandboxProvider: row.sandbox_provider,
    agentName: row.agent_name || "default",
    sandboxId: row.sandbox_id,
    sandboxUrl: row.sandbox_url,
    opencodeSessionId: row.opencode_session_id,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function proposalFromRow(row: any): Proposal {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    branchName: row.branch_name,
    status: row.status,
    diffStatJson: row.diff_stat_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function secretFromRow(row: any): SecretMetadata {
  return {
    projectId: row.project_id,
    key: row.key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjects(): Project[] {
  return openDb().query("SELECT * FROM projects ORDER BY created_at DESC").all().map(projectFromRow);
}

export function getProject(id: string): Project | null {
  const row = openDb().query("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? projectFromRow(row) : null;
}

export function insertProject(input: { id: string; name: string; repoUrl: string; defaultBranch?: string; manifestPath?: string }): Project {
  const now = nowIso();
  openDb().query(`
    INSERT INTO projects (id, name, repo_url, default_branch, manifest_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.name, input.repoUrl, input.defaultBranch || "main", input.manifestPath || "kortix.toml", now, now);
  const project = getProject(input.id);
  if (!project) throw new Error("Failed to insert project");
  return project;
}

export function listSessions(projectId?: string): SessionRun[] {
  const sql = projectId
    ? "SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC"
    : "SELECT * FROM sessions ORDER BY created_at DESC";
  const rows = projectId ? openDb().query(sql).all(projectId) : openDb().query(sql).all();
  return rows.map(sessionFromRow);
}

export function getSession(id: string): SessionRun | null {
  const row = openDb().query("SELECT * FROM sessions WHERE id = ?").get(id);
  return row ? sessionFromRow(row) : null;
}

export function insertSession(input: {
  id: string;
  projectId: string;
  branchName: string;
  baseRef: string;
  sandboxProvider: string;
  agentName: string;
  status: string;
}): SessionRun {
  const now = nowIso();
  openDb().query(`
    INSERT INTO sessions
      (id, project_id, branch_name, base_ref, sandbox_provider, agent_name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.projectId, input.branchName, input.baseRef, input.sandboxProvider, input.agentName, input.status, now, now);
  const session = getSession(input.id);
  if (!session) throw new Error("Failed to insert session");
  return session;
}

export function updateSession(id: string, patch: Partial<Pick<SessionRun, "sandboxId" | "sandboxUrl" | "opencodeSessionId" | "status" | "error">>): SessionRun {
  const current = getSession(id);
  if (!current) throw new Error(`Session not found: ${id}`);
  openDb().query(`
    UPDATE sessions SET
      sandbox_id = ?,
      sandbox_url = ?,
      opencode_session_id = ?,
      status = ?,
      error = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    patch.sandboxId ?? current.sandboxId,
    patch.sandboxUrl ?? current.sandboxUrl,
    patch.opencodeSessionId ?? current.opencodeSessionId,
    patch.status ?? current.status,
    patch.error ?? current.error,
    nowIso(),
    id,
  );
  const next = getSession(id);
  if (!next) throw new Error(`Session not found after update: ${id}`);
  return next;
}

export function insertProposal(input: { id: string; projectId: string; sessionId: string; branchName: string; diffStatJson: string }): Proposal {
  const now = nowIso();
  openDb().query(`
    INSERT INTO proposals
      (id, project_id, session_id, branch_name, status, diff_stat_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(input.id, input.projectId, input.sessionId, input.branchName, input.diffStatJson, now, now);
  const row = openDb().query("SELECT * FROM proposals WHERE id = ?").get(input.id);
  if (!row) throw new Error("Failed to insert proposal");
  return proposalFromRow(row);
}

export function listProjectSecrets(projectId: string): SecretMetadata[] {
  return openDb()
    .query("SELECT project_id, key, created_at, updated_at FROM project_secrets WHERE project_id = ? ORDER BY key ASC")
    .all(projectId)
    .map(secretFromRow);
}

export function upsertProjectSecret(input: { projectId: string; key: string; value: string }): SecretMetadata {
  const key = input.key.trim().toUpperCase();
  validateSecretName(key);
  if (!input.value) throw new Error("Secret value is required");
  if (!getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
  const now = nowIso();
  const encrypted = encryptSecret(input.projectId, key, input.value);
  openDb().query(`
    INSERT INTO project_secrets (project_id, key, ciphertext, iv, tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, key) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      tag = excluded.tag,
      updated_at = excluded.updated_at
  `).run(input.projectId, key, encrypted.ciphertext, encrypted.iv, encrypted.tag, now, now);
  const row = openDb()
    .query("SELECT project_id, key, created_at, updated_at FROM project_secrets WHERE project_id = ? AND key = ?")
    .get(input.projectId, key);
  if (!row) throw new Error("Failed to save secret");
  return secretFromRow(row);
}

export function deleteProjectSecret(projectId: string, keyInput: string): boolean {
  const key = keyInput.trim().toUpperCase();
  validateSecretName(key);
  const result = openDb().query("DELETE FROM project_secrets WHERE project_id = ? AND key = ?").run(projectId, key);
  return result.changes > 0;
}

export function getProjectSecretEnv(projectId: string): Record<string, string> {
  const rows = openDb()
    .query("SELECT project_id, key, ciphertext, iv, tag FROM project_secrets WHERE project_id = ?")
    .all(projectId);
  const env: Record<string, string> = {};
  for (const row of rows as any[]) {
    env[row.key] = decryptSecret(row);
  }
  return env;
}
