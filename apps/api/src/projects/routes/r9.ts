import { auth, errors, json } from "../../openapi";
import { sharedDb as db } from "../../shared/effect";
import { kickProjectTemplatePrebuilds } from "../../snapshots/builder";
import { kickProjectWarmBake } from "../../snapshots/warm-project";
import { getCrById, serializeChangeRequest } from "../change-requests";
import { invalidateProjectMirror, mergeBranches, readRepoFile } from "../git";
import { MANIFEST_FILENAME } from "../triggers";
import { createRoute, z } from "@hono/zod-openapi";
import { changeRequests } from "@kortix/db";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { loadProjectForUser, assertProjectCapability } from "../lib/access";
import { AnyObject, projectsApp } from "../lib/app";
import { withProjectGitAuth } from "../lib/git";
import { normalizeString, readBody } from "../lib/serializers";
import { assertAgentScope } from "../../iam/agent-scope";
import { PROJECT_ACTIONS } from "../../iam";
import {
  attemptRoute,
  failJson,
  failNotFound,
  routeJson,
  runProjectRouteEffect,
} from "./effect-workflows";
import { effectHandler } from "../../effect/hono";

const loadWritableProject = (c: any, projectId: string) =>
  attemptRoute(() => loadProjectForUser(c, projectId, "write")).pipe(
    Effect.flatMap((loaded) =>
      loaded ? Effect.succeed(loaded) : failNotFound(),
    ),
  );

projectsApp.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/change-requests/{crId}/merge",
    tags: ["change-requests"],
    summary: "POST /:projectId/change-requests/:crId/merge",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
      body: { content: { "application/json": { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404, 409, 422, 502),
    },
  }),
  effectHandler(async (c: any) => {
    // Deliberate exception: merge keeps the manifest gate, provider merge, DB
    // stamp, and detached post-merge reconciliations in the established promise
    // flow so those side effects stay in their original order.
    const projectId = c.req.param("projectId");
    const crId = c.req.param("crId");
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, "write");
    if (!loaded) return c.json({ error: "Not found" }, 404);

    // Human-side capability gate: merging lands code on the base branch. Editors/
    // managers hold project.gitops.merge today; a custom role can OMIT it to take
    // Git-Ops merge away from a department without touching the rest of write.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
    );

    // Per-agent gate: merging a CR lands code on the base branch — the canonical
    // destructive action. An agent-session token must be granted project.cr.merge
    // (default-deny). Non-agent tokens (human dashboard / laptop CLI) pass through.
    assertAgentScope(c, "project.cr.merge");

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: "Change request not found" }, 404);
    if (cr.status !== "open") {
      return c.json({ error: `Change request is ${cr.status}` }, 409);
    }

    const customMessage = normalizeString(body.message);
    const projectForGit = await withProjectGitAuth(loaded.row);

    // Manifest gate: a CR cannot merge if the would-be-merged kortix.toml
    // doesn't validate against the canonical schema. We read the manifest from
    // the HEAD branch (what's about to be merged). If the head doesn't have a
    // manifest, that's fine — projects with a `.kortix/`-only layout still
    // merge. The same validator runs in the CLI's `kortix ship` pre-flight, so
    // CLI users see the same diagnostic locally before push.
    try {
      const headManifestRaw = await readRepoFile(
        projectForGit,
        MANIFEST_FILENAME,
        cr.headRef,
      );
      if (headManifestRaw && headManifestRaw.trim()) {
        const { validateManifest } = await import("@kortix/manifest-schema");
        const verdict = validateManifest(headManifestRaw);
        if (!verdict.valid) {
          return c.json(
            {
              error: "Manifest validation failed — merge blocked.",
              code: "MANIFEST_INVALID",
              issues: verdict.issues,
            },
            422,
          );
        }
      }
    } catch (err) {
      // Manifest absent on this branch (404 in the mirror) is fine; surface
      // anything else as a 502 so the user knows something else is broken.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/(not found|enoent|404)/i.test(msg)) {
        return c.json(
          { error: `Failed to read kortix.toml from head branch: ${msg}` },
          502,
        );
      }
    }

    let result: Awaited<ReturnType<typeof mergeBranches>>;
    try {
      result = await mergeBranches(projectForGit, cr.baseRef, cr.headRef, {
        message: customMessage ?? `Merge CR #${cr.number}: ${cr.title}`,
        authorName: "Kortix",
        authorEmail: "noreply@kortix.ai",
      });
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : "Merge failed",
        },
        409,
      );
    }

    const [row] = await db
      .update(changeRequests)
      .set({
        status: "merged",
        mergedAt: new Date(),
        mergedBy: loaded.userId,
        mergeCommitSha: result.merge_commit_sha,
        // Capture the SHAs that were active at merge time. head_commit_sha
        // intentionally stays at the head branch's tip (not the merge commit)
        // so the merged-CR diff can re-render the changes via base...head.
        headCommitSha: result.fast_forward
          ? result.merge_commit_sha
          : (cr.headCommitSha ?? result.merge_commit_sha),
        baseCommitSha: result.base_sha_before,
        updatedAt: new Date(),
      })
      .where(eq(changeRequests.crId, crId))
      .returning();

    invalidateProjectMirror(projectId);

    // A merged CR may have edited a `[[sandbox.templates]]` Dockerfile or spec.
    // Reconcile this project's own templates and pre-build any whose identity
    // drifted, so the next session boots off cache instead of a cold build. The
    // platform default is global (built at startup), so it's deliberately not
    // touched here. Best-effort, never blocks the merge response.
    kickProjectTemplatePrebuilds(projectForGit, {
      accountId: loaded.row.accountId,
      source: "cr-merge",
    });

    // Re-bake the project's WARM snapshot at the new tip (repo pre-cloned +
    // opencode caches) so the next session boots commit-fresh with no clone.
    // No-op unless warm snapshots are enabled (and skipped for projects whose
    // default template is custom). Best-effort, never blocks.
    kickProjectWarmBake({ ...projectForGit, metadata: loaded.row.metadata });

    // A merged CR may have edited kortix.toml's [[connectors]]. The connector DB
    // cache (what the gateway + dashboard read) is derived from the manifest, so
    // reconcile it from the new tip — best-effort, never blocks the merge
    // response. The manifest in git stays the source of truth either way; the
    // periodic sweep is the backstop if this best-effort call fails.
    void import("../../executor/sync")
      .then(({ syncProjectConnectors }) =>
        syncProjectConnectors(projectId, loaded.row.accountId),
      )
      .then((res) => {
        if (res.errors.length) {
          console.warn(
            "[change-requests] connector reconcile had errors",
            projectId,
            res.errors,
          );
        }
      })
      .catch((err) =>
        console.warn(
          "[change-requests] connector reconcile failed",
          projectId,
          err instanceof Error ? err.message : err,
        ),
      );

    return c.json({
      change_request: serializeChangeRequest(row),
      merge: result,
    });
  }),
);

// POST /v1/projects/:projectId/change-requests/:crId/close

projectsApp.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/change-requests/{crId}/close",
    tags: ["change-requests"],
    summary: "POST /:projectId/change-requests/:crId/close",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404, 409),
    },
  }),
  async (c: any) => {
    return runProjectRouteEffect(
      c,
      Effect.gen(function* () {
        const projectId = c.req.param("projectId");
        const crId = c.req.param("crId");
        const loaded = yield* loadWritableProject(c, projectId);
        // Per-agent gate: managing a CR's lifecycle is part of the change-request
        // capability. A scoped agent token must hold project.cr.open (no-op for
        // human/PAT tokens).
        yield* attemptRoute(() =>
          Promise.resolve(assertAgentScope(c, "project.cr.open")),
        );

        const cr = yield* attemptRoute(() => getCrById(crId, projectId));
        if (!cr)
          return yield* failJson({ error: "Change request not found" }, 404);
        if (cr.status === "merged") {
          return yield* failJson(
            { error: "Cannot close a merged change request" },
            409,
          );
        }

        const [row] = yield* attemptRoute(() =>
          db
            .update(changeRequests)
            .set({
              status: "closed",
              closedAt: new Date(),
              closedBy: loaded.userId,
              updatedAt: new Date(),
            })
            .where(eq(changeRequests.crId, crId))
            .returning(),
        );
        return routeJson(serializeChangeRequest(row));
      }),
    );
  },
);

// POST /v1/projects/:projectId/change-requests/:crId/reopen

projectsApp.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/change-requests/{crId}/reopen",
    tags: ["change-requests"],
    summary: "POST /:projectId/change-requests/:crId/reopen",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(z.any(), "OK"),
      ...errors(404, 409),
    },
  }),
  async (c: any) => {
    return runProjectRouteEffect(
      c,
      Effect.gen(function* () {
        const projectId = c.req.param("projectId");
        const crId = c.req.param("crId");
        yield* loadWritableProject(c, projectId);
        // Per-agent gate: managing a CR's lifecycle is part of the change-request
        // capability. A scoped agent token must hold project.cr.open (no-op for
        // human/PAT tokens).
        yield* attemptRoute(() =>
          Promise.resolve(assertAgentScope(c, "project.cr.open")),
        );

        const cr = yield* attemptRoute(() => getCrById(crId, projectId));
        if (!cr)
          return yield* failJson({ error: "Change request not found" }, 404);
        if (cr.status !== "closed") {
          return yield* failJson(
            { error: `Cannot reopen a ${cr.status} change request` },
            409,
          );
        }

        const [row] = yield* attemptRoute(() =>
          db
            .update(changeRequests)
            .set({
              status: "open",
              closedAt: null,
              closedBy: null,
              updatedAt: new Date(),
            })
            .where(eq(changeRequests.crId, crId))
            .returning(),
        );
        return routeJson(serializeChangeRequest(row));
      }),
    );
  },
);
