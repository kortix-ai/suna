/**
 * The "world" = the provisioned principal matrix + fixture factory + global
 * teardown, built once per run. Public-only runs (system/access) need no creds
 * and provision nothing; any auth'd domain triggers full provisioning.
 *
 * NOTE: the full 14-principal matrix (ADMIN, MEMBER, the M_ project roles,
 * BILLING, AUDITOR, RO_ADMIN, DENY_USER, NONMEMBER, PAT_PROJ) is completed in
 * fixtures/principals.ts as the
 * route contracts are pinned by the audit. OWNER/ANON/PAT_ACCT/APIKEY + the run
 * account are wired here.
 */
import { Client, type Identity } from "../core/client";
import type { Env } from "../core/env";
import { log } from "../core/log";
import type { CreatedProject, CreatedSession, Fixtures, Principal, Principals } from "../core/types";
import type { RegisteredFlow } from "../core/flow";
import { ResourceStack } from "./registry";
import { adminDeleteUser } from "./supabase";
import { provisionMatrix, synthUser, type Provisioned } from "./principals";
import { subscribe } from "./billing";
import { provisionProject } from "./provision";

const PUBLIC_DOMAINS = new Set(["system", "access"]);

export interface World {
  principals: Principals;
  newStack(): ResourceStack;
  makeFixtures(stack: ResourceStack): Fixtures;
  teardownAll(): Promise<void>;
}

const ANON_PRINCIPAL: Principal = { label: "ANON", auth: { mode: "none" } };

function principalsProxy(provided: Partial<Principals>): Principals {
  return new Proxy(provided, {
    get(target, prop: string) {
      if (prop in target) return (target as any)[prop];
      if (prop === "ANON") return ANON_PRINCIPAL;
      throw new Error(
        `Principal "${String(prop)}" is not provisioned in this run. ` +
          `Provide owner creds + service-role key, or this principal isn't wired yet (see fixtures/principals.ts).`,
      );
    },
  }) as Principals;
}

export async function buildWorld(env: Env, flows: RegisteredFlow[]): Promise<World> {
  const needsAuth = flows.some((f) => !PUBLIC_DOMAINS.has(f.meta.domain));

  if (!needsAuth) {
    log.info(log.dim("world: public-only run — no principals provisioned"));
    const principals = principalsProxy({ ANON: ANON_PRINCIPAL, accountId: "" });
    const noFixtures: Fixtures = makeUnavailableFixtures();
    return {
      principals,
      newStack: () => new ResourceStack(new Client(env.apiUrl)),
      makeFixtures: () => noFixtures,
      teardownAll: async () => {},
    };
  }

  if (!env.capabilities.supabaseAdmin || !env.supabaseAnonKey) {
    throw new Error(
      "Auth'd flows selected but no Supabase admin access. Set KE2E_SUPABASE_SERVICE_ROLE_KEY " +
        "+ KE2E_SUPABASE_ANON_KEY (the suite synthesizes principals), or restrict to --domain system,access.",
    );
  }

  const runId = (globalThis as any).__KE2E_RUN_ID__ ?? "run";
  const provisioned: Provisioned = await provisionMatrix(env, runId);
  const owner = provisioned.principals.OWNER;
  const adminClient = new Client(env.apiUrl).as(owner as Identity);
  // Users synthesized mid-run (team members) — deleted in teardownAll.
  const extraUserIds: string[] = [];
  // One shared read-only project, provisioned at most once per run.
  let sharedProjectPromise: Promise<CreatedProject> | null = null;
  const sharedStack = new ResourceStack(adminClient);

  // Fund OWNER's account the real way (Stripe test-mode subscribe) so billing-gated
  // flows (sessions) can run. Best-effort: if Stripe isn't wired, those flows
  // self-skip via `requires: ["stripe"]`.
  if (env.capabilities.stripe && owner?.accountId) {
    try {
      await subscribe(env, adminClient, owner.accountId);
      env.capabilities.funded = true;
      log.info(log.dim("world: OWNER funded via real subscribe — billing-gated flows enabled"));
    } catch (err) {
      log.warn(
        `world: OWNER funding (subscribe) unavailable on this target — billing-gated flows (sessions, paid subscribe) will skip. ` +
          `(${(err as Error)?.message ?? err})`,
      );
    }
  }

  const fixturesFor = (stack: ResourceStack): Fixtures => ({
    name: (slug) => `e2e-${runId}-${slug}`,
    sharedProject() {
      if (!sharedProjectPromise) {
        sharedProjectPromise = (async () => {
          const id = await provisionProject(adminClient, { name: `e2e-${runId}-shared` });
          sharedStack.push("project", id);
          return { id, name: `e2e-${runId}-shared` } as CreatedProject;
        })();
      }
      return sharedProjectPromise;
    },
    async project(opts) {
      const name = opts?.name ?? `e2e-${runId}-proj-${rand()}`;
      const id = await provisionProject(adminClient, {
        name,
        ...(opts?.accountId ? { account_id: opts.accountId } : {}),
      });
      stack.push("project", id);
      return { id, name } as CreatedProject;
    },
    async team(opts) {
      const res = await adminClient.post("/v1/accounts", { name: opts?.name ?? `e2e-${runId}-team-${rand()}` });
      const accountId = res.json<any>()?.account_id;
      if (!accountId) throw new Error(`team account create returned no id: ${res.text()}`);
      stack.push("account", accountId);
      return {
        id: accountId,
        async addMember(role) {
          const u = await synthUser(env, `MEM-${role}`, runId);
          extraUserIds.push(u.user.id);
          await adminClient.post("/v1/accounts/:accountId/members", { email: u.user.email, role }, { params: { accountId } });
          return u.principal;
        },
        async grantProjectRole(projectId, userId, role) {
          await adminClient.put("/v1/projects/:projectId/access/:userId", { role }, { params: { projectId, userId } });
        },
        async project(o) {
          const name = o?.name ?? `e2e-${runId}-tproj-${rand()}`;
          const id = await provisionProject(adminClient, { name, account_id: accountId });
          stack.push("project", id);
          return { id, name } as CreatedProject;
        },
      };
    },
    async session(project, opts) {
      const res = await adminClient.post("/v1/projects/:projectId/sessions", { prompt: opts?.prompt ?? "noop" }, {
        params: { projectId: project.id },
      });
      const body = res.json<any>();
      const id = body?.session_id ?? body?.sessionId ?? body?.id;
      if (!id) throw new Error(`session create returned no id: ${res.text()}`);
      stack.push("session", id, { projectId: project.id });
      return { id, projectId: project.id } as CreatedSession;
    },
    async pat(opts) {
      const res = await adminClient.post("/v1/accounts/tokens", { name: opts?.name ?? `e2e-${runId}-pat-${rand()}` });
      const body = res.json<any>();
      const secret = body?.secret_key ?? body?.token;
      const tokenId = body?.id ?? body?.token_id;
      if (!secret) throw new Error(`token mint returned no secret: ${res.text()}`);
      if (tokenId) stack.push("token", tokenId);
      return secret as string;
    },
  });

  return {
    principals: principalsProxy(provisioned.principals),
    newStack: () => new ResourceStack(adminClient),
    makeFixtures: fixturesFor,
    async teardownAll() {
      await sharedStack.teardown();
      for (const acct of provisioned.runAccountIds) {
        try {
          // delete-immediately resolves the caller's account; account_id in body
          // overrides for team accounts the OWNER controls.
          await adminClient.del("/v1/account/delete-immediately", { body: { account_id: acct } });
        } catch (err) {
          log.warn(`teardown run account ${acct} failed: ${(err as Error)?.message ?? err}`);
        }
      }
      for (const uid of [...provisioned.supabaseUserIds, ...extraUserIds]) await adminDeleteUser(env, uid);
    },
  };
}

function makeUnavailableFixtures(): Fixtures {
  const fail = (): never => {
    throw new Error("Fixtures unavailable in a public-only run (no provisioning).");
  };
  return {
    name: (slug) => slug,
    project: fail as any,
    sharedProject: fail as any,
    session: fail as any,
    pat: fail as any,
    team: fail as any,
  };
}

function rand(): string {
  // Deterministic-free randomness via crypto (Math.random is fine here, not in workflow scripts).
  return Math.random().toString(36).slice(2, 8);
}
