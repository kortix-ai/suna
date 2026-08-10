/**
 * Run-scoped resource tracking + LIFO teardown. Every created resource is
 * registered so it's reclaimed even on failure. Teardown failures are logged
 * but never fail the run (a leaked sandbox must not mask a real pass/fail) —
 * they feed the GC sweep instead.
 */
import type { Client } from "../core/client";
import { log } from "../core/log";

export interface TrackedResource {
  kind: string;
  id: string;
  meta?: Record<string, any>;
}

export class ResourceStack {
  private items: TrackedResource[] = [];

  constructor(
    private admin: Client,
    private deleteDatabaseProject?: (projectId: string) => Promise<void>,
  ) {}

  push(kind: string, id: string, meta?: Record<string, any>): void {
    this.items.push({ kind, id, meta });
  }

  async teardown(): Promise<void> {
    // LIFO so children (sessions) go before parents (projects/accounts).
    for (const r of this.items.reverse()) {
      try {
        await this.delete(r);
      } catch (err) {
        log.warn(`teardown ${r.kind} ${r.id} failed (left for GC): ${(err as Error)?.message ?? err}`);
      }
    }
    this.items = [];
  }

  private async delete(r: TrackedResource): Promise<void> {
    switch (r.kind) {
      case "session":
        await this.admin.del("/v1/projects/:projectId/sessions/:id", {
          params: { projectId: r.meta?.projectId, id: r.id },
        });
        break;
      case "sandbox-template":
        await this.admin.del(
          "/v1/projects/:projectId/sandbox-templates/:templateId",
          {
            params: {
              projectId: r.meta?.projectId,
              templateId: r.id,
            },
          },
        );
        break;
      case "project":
        await this.admin.del("/v1/projects/:id", { params: { id: r.id }, query: { purge: true } });
        break;
      case "database-project":
        if (!this.deleteDatabaseProject) {
          throw new Error("database project teardown is not configured");
        }
        await this.deleteDatabaseProject(r.id);
        break;
      case "local-git":
        if (typeof r.meta?.dispose !== "function") {
          throw new Error("local Git teardown is not configured");
        }
        await r.meta.dispose();
        break;
      case "tunnelPermission":
        await this.admin.del("/v1/tunnel/permissions/:tunnelId/:permissionId", {
          params: { tunnelId: r.meta?.tunnelId, permissionId: r.id },
        });
        break;
      case "tunnelConnection":
        await this.admin.del("/v1/tunnel/connections/:tunnelId", {
          params: { tunnelId: r.id },
        });
        break;
      case "token":
        await this.admin.del("/v1/accounts/tokens/:id", { params: { id: r.id } });
        break;
      case "member":
        await this.admin.del("/v1/accounts/:accountId/members/:userId", {
          params: { accountId: r.meta?.accountId, userId: r.id },
        });
        break;
      case "account":
        // Team accounts are owned by a throwaway synthesized user that gets
        // deleted in teardownAll (cascading the account); GC is the backstop.
        // No direct delete here — delete-immediately resolves the caller's own
        // account and could target the wrong one.
        break;
      case "supabase-user":
        // Handled by the world's service-role admin during teardownAll.
        break;
      case "opencode-session":
        // Lives inside the ephemeral sandbox; reclaimed when the session/sandbox
        // is deleted. Tracked only for report context — no standalone teardown.
        break;
      default:
        log.warn(`no teardown handler for resource kind "${r.kind}" (${r.id})`);
    }
  }
}
