/**
 * Shared interface hub. Interfaces only (no runtime), so the flow registry,
 * fixtures, and runner can reference each other without import cycles.
 */
import type { Client, Identity } from './client';
import type { Capabilities, Env } from './env';

export type Capability = keyof Capabilities;

export type ProjectRole = 'user' | 'editor' | 'manager';

/** A provisioned identity with the data flows assert against. */
export interface Principal extends Identity {
  userId?: string;
  email?: string;
  accountId?: string;
  projectId?: string;
  role?: string;
}

/** The principal matrix every run provisions (see spec §0 Principals). */
export interface Principals {
  OWNER: Principal;
  ADMIN: Principal;
  MEMBER: Principal;
  M_VIEWER: Principal;
  M_EDITOR: Principal;
  M_MANAGER: Principal;
  BILLING: Principal;
  AUDITOR: Principal;
  RO_ADMIN: Principal;
  DENY_USER: Principal;
  NONMEMBER: Principal;
  PAT_ACCT: Principal;
  PAT_PROJ: Principal;
  APIKEY: Principal;
  ANON: Principal;
  /** The run-scoped team account id everything is provisioned under. */
  accountId: string;
}

export interface CreatedProject {
  id: string;
  name: string;
  slug?: string;
}

export interface CreatedSession {
  id: string;
  projectId: string;
}

/** A team account with member/role provisioning, for IAM + access flows. */
export interface TeamFixture {
  /** The team account id (OWNER is its owner). */
  id: string;
  /** Synthesize a user, add to this account at the given role, return its principal. */
  addMember(role: 'admin' | 'member'): Promise<Principal>;
  /** Grant a project role to an account member (PUT access). */
  grantProjectRole(projectId: string, userId: string, role: ProjectRole): Promise<void>;
  /** Provision a project owned by this team account. */
  project(opts?: { name?: string; seed?: boolean }): Promise<CreatedProject>;
}

/** Fixture sugar bound to the current run (auto-tracked for teardown). */
export interface Fixtures {
  /**
   * Create a fresh run-scoped project record and an isolated repository branch.
   * The run owns one seeded managed repository. The API creates a distinct
   * branch for each project with server-managed credentials. Session flows can
   * boot without creating one GitHub repository per flow. `seed` remains
   * accepted for flow compatibility.
   */
  project(opts?: { name?: string; accountId?: string; seed?: boolean }): Promise<CreatedProject>;
  /**
   * The pool owner project. Use it only for read-only flows. Mutating flows use
   * project(), which creates an isolated project record and branch.
   */
  sharedProject(): Promise<CreatedProject>;
  /** Create a session in a project (provisions a real sandbox). */
  session(project: CreatedProject, opts?: { prompt?: string }): Promise<CreatedSession>;
  /** Mint a fresh run-scoped account-scoped PAT. */
  pat(opts?: { name?: string }): Promise<string>;
  /** Create a team account with member/role helpers (auto-torn-down). */
  team(opts?: { name?: string; enterprise?: boolean }): Promise<TeamFixture>;
  /** Create an isolated user with only its personal account (auto-torn-down). */
  user(opts?: { label?: string }): Promise<Principal>;
  /** A unique run-scoped name with the e2e-<runId>- prefix. */
  name(slug: string): string;
}

export interface FlowMeta {
  domain: string;
  tags?: string[];
  /** Serialize against shared account state. */
  serial?: boolean;
  /** Touches a global singleton (cron/ops); run last, one at a time. */
  global?: boolean;
  timeoutMs?: number;
  retry?: { attempts: number };
  requires?: Capability[];
  /**
   * Routes this flow exercises, as "METHOD /v1/path/:param" — used by the
   * coverage gate for static coverage (merged with runtime-hit routes). Keep in
   * sync with what the flow actually calls; the gate fails on unknown routes.
   */
  routes?: string[];
  /** Registers as a tracked skip (yellow in the report) instead of running. */
  todo?: string;
}

export interface FlowContext {
  /** Unauthed base client; use `.as(ctx.P.OWNER)` etc. */
  client: Client;
  P: Principals;
  env: Env;
  /** A unit of capture/timing/assertion. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Register a resource for LIFO teardown. `meta` carries parent ids (e.g. projectId for a session). */
  track(kind: string, id: string, meta?: Record<string, any>): void;
  /** Self-skip the flow with a reason (counts as skip, not fail). */
  skip(reason: string): never;
  fixtures: Fixtures;
}

export type FlowFn = (ctx: FlowContext) => Promise<void>;
