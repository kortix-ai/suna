/**
 * Run-scoped resource tracking + LIFO teardown. Every created resource is
 * registered so it is reclaimed even on failure. Strict teardown fails a
 * passing flow when an API deletion fails. Failure-path teardown only logs the
 * cleanup error, so it does not replace the original flow failure.
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

  constructor(private admin: Client) {}

  push(kind: string, id: string, meta?: Record<string, any>): void {
    this.items.push({ kind, id, meta });
  }

  async teardown(options: { throwOnFailure?: boolean } = {}): Promise<void> {
    const failures: string[] = [];
    // LIFO so children (sessions) go before parents (projects/accounts).
    for (const r of this.items.reverse()) {
      try {
        await this.delete(r);
      } catch (err) {
        const message = `${r.kind} ${r.id}: ${(err as Error)?.message ?? err}`;
        failures.push(message);
        log.warn(`teardown ${message} (left for GC)`);
      }
    }
    this.items = [];
    if (options.throwOnFailure && failures.length > 0) {
      throw new Error(
        `cleanup failed for ${failures.length} resource${failures.length === 1 ? '' : 's'}: ` +
          failures.join('; '),
      );
    }
  }

  private async delete(r: TrackedResource): Promise<void> {
    switch (r.kind) {
      case "session": {
        const response = await this.admin.del("/v1/projects/:projectId/sessions/:id", {
          params: { projectId: r.meta?.projectId, id: r.id },
        });
        assertCleanupResponse(response, r);
        break;
      }
      case "project": {
        const response = await this.admin.del("/v1/projects/:id", {
          params: { id: r.id },
          query: { purge: true },
        });
        assertCleanupResponse(response, r);
        break;
      }
      case "token": {
        const response = await this.admin.del("/v1/accounts/tokens/:id", {
          params: { id: r.id },
        });
        assertCleanupResponse(response, r);
        break;
      }
      case "cli-token": {
        const response = await this.admin.del("/v1/projects/:projectId/cli-token/:tokenId", {
          params: { projectId: r.meta?.projectId, tokenId: r.id },
        });
        assertCleanupResponse(response, r);
        break;
      }
      case "member": {
        const response = await this.admin.del("/v1/accounts/:accountId/members/:userId", {
          params: { accountId: r.meta?.accountId, userId: r.id },
        });
        assertCleanupResponse(response, r);
        break;
      }
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
      case "cli-sandbox":
        // Each CLI flow disposes its temporary directory in a finally block.
        // Tracking keeps the path in the report without a second delete here.
        break;
      case "sandbox-template": {
        const response = await this.admin.del(
          "/v1/projects/:projectId/sandbox-templates/:templateId",
          {
            params: { projectId: r.meta?.projectId, templateId: r.id },
          },
        );
        assertCleanupResponse(response, r);
        break;
      }
      default:
        log.warn(`no teardown handler for resource kind "${r.kind}" (${r.id})`);
    }
  }
}

function assertCleanupResponse(
  response: { statusCode: number; text(): string },
  resource: TrackedResource,
): void {
  if ([200, 202, 204, 404, 410].includes(response.statusCode)) return;
  throw new Error(
    `HTTP ${response.statusCode} deleting ${resource.kind}: ${response.text().slice(0, 500)}`,
  );
}
