import { createRoute, z } from '@hono/zod-openapi';
import { changeRequests } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayPerform, assertAgentScope, getAgentGrant, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { manifestGovernanceChanged, refusesSelfMerge } from '../change-request-policy';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { kickProjectTemplatePrebuilds } from '../../snapshots/builder';
import { getCrById, serializeChangeRequest } from '../change-requests';
// Imported from its own module, not the `../git` barrel: several route suites
// replace the barrel wholesale with `mock.module`, and the guard below runs
// only with the agent_principal flag on.
import { getMergeBase } from '../git/merge';
import {
  invalidateProjectMirror,
  MergeConflictError,
  mergeBranches,
  readManifestFromRepo,
  type GitBackedProject,
} from '../git';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { enqueueProjectSnapshot } from '../../git-proxy/project-snapshot';
import { normalizeString, readBody } from '../lib/serializers';

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/change-requests/{crId}/merge',
    tags: ['change-requests'],
    summary: 'POST /:projectId/change-requests/:crId/merge',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404, 409, 422, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    // Human-side capability gate: merging lands code on the base branch.
    // Managers hold project.gitops.merge today; a custom role can OMIT it to take
    // Git-Ops merge away from a department without touching the rest of write.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
    );

    // Per-agent gate: merging a CR lands code on the base branch — the canonical
    // destructive action. An agent-session token must be granted
    // `project.gitops.merge` (default-deny). `project.cr.merge` was the same
    // capability under a second name and is gone from the catalog (spec §2.4); a
    // manifest still spelling it that way is rewritten on input by
    // `canonicalizeGrantActions`. Non-agent tokens (human dashboard / laptop
    // CLI) pass through.
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_GITOPS_MERGE);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);
    if (cr.status !== 'open') {
      return c.json({ error: `Change request is ${cr.status}` }, 409);
    }

    // An explicit agent grant permits self merge. Ungoverned sessions keep the
    // original protection because a null grant makes assertAgentScope a no-op.
    const agentGrant = getAgentGrant(c);
    if (
      refusesSelfMerge({
        actingSessionId: (c.get('sessionId') as string | null | undefined) ?? null,
        originSessionId: cr.originSessionId ?? null,
        hasExplicitMergeGrant: agentGrant !== null
          && agentMayPerform(agentGrant, PROJECT_ACTIONS.PROJECT_GITOPS_MERGE),
      })
    ) {
      return c.json(
        {
          error:
            `Change request #${cr.number} was opened by this session. ` +
            'Self merge requires an explicit project.gitops.merge grant in kortix.yaml.',
          code: 'CR_SELF_MERGE_REFUSED',
        },
        403,
      );
    }

    const customMessage = normalizeString(body.message);
    const projectForGit = await withProjectGitAuth(loaded.row);

    // Governance guard (spec 2026-09-22 §2.4). Under the agent-principal model
    // kortix.yaml `agents` and `triggers` ARE agent authority, so an agent must
    // not widen itself (or plant an unattended run) by merging its own edit. A
    // human with project.gitops.merge merges such a change request. Compared
    // against the merge base, so only the CR's own changes count.
    if (resolveFeatureFlag(loaded.row.metadata, 'agent_principal') && isProjectSessionPrincipal(c)) {
      const refusal = await agentGovernanceMergeRefusal(projectForGit, cr);
      if (refusal) return c.json(refusal, 403);
    }

    // Manifest gate: a CR cannot merge if the would-be-merged manifest doesn't
    // validate against the canonical schema. We read the manifest from the HEAD
    // branch (what's about to be merged), preferring kortix.yaml over kortix.toml.
    // If the head doesn't have a manifest, that's fine — projects with a
    // `.kortix/`-only layout still merge. The same validator runs in the CLI's
    // `kortix ship` pre-flight, so CLI users see the same diagnostic before push.
    try {
      const { validateManifest, manifestFormatForPath, manifestCandidatePaths, ManifestImportError } =
        await import('@kortix/manifest-schema');
      // `found.content` is the MERGED document when the head declares
      // `imports:`, so the gate validates what the platform will actually run.
      // A broken import (missing file, duplicate name, cycle) blocks the merge
      // with the same 422 a schema violation gets.
      const found = await readManifestFromRepo(
        projectForGit,
        manifestCandidatePaths(projectForGit.manifestPath).map((cand) => cand.path),
        cr.headRef,
      ).catch((err: unknown) => {
        if (err instanceof ManifestImportError) return { importError: err.message } as const;
        throw err;
      });
      if (found && 'importError' in found) {
        return c.json(
          {
            error: 'Manifest validation failed — merge blocked.',
            code: 'MANIFEST_INVALID',
            issues: [{ path: 'imports', message: found.importError, severity: 'error' }],
          },
          422,
        );
      }
      if (found && found.content.trim()) {
        const verdict = validateManifest(found.content, manifestFormatForPath(found.path));
        if (!verdict.valid) {
          return c.json(
            {
              error: 'Manifest validation failed — merge blocked.',
              code: 'MANIFEST_INVALID',
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
        return c.json({ error: `Failed to read the manifest from head branch: ${msg}` }, 502);
      }
    }

    let result: Awaited<ReturnType<typeof mergeBranches>>;
    try {
      result = await mergeBranches(projectForGit, cr.baseRef, cr.headRef, {
        message: customMessage ?? `Merge CR #${cr.number}: ${cr.title}`,
        authorName: 'Kortix',
        authorEmail: 'noreply@kortix.ai',
      });
    } catch (error) {
      if (error instanceof MergeConflictError) {
        return c.json(
          {
            error: error.message,
            code: error.code,
            conflicts: error.conflicts,
          },
          409,
        );
      }
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Merge failed',
        },
        409,
      );
    }

    // The base tip moved server-side (no proxy push saw it): queue the project
    // snapshot archive for the exact merged SHA so the next fresh session
    // boots from S3. Fire-and-forget; the merge is already durable.
    void enqueueProjectSnapshot({
      projectId: loaded.row.projectId,
      ref: cr.baseRef,
      commitSha: result.base_sha_after,
      repoUrl: loaded.row.repoUrl,
    }).catch((err) => {
      console.warn('[project-snapshot] enqueue after merge failed', {
        projectId: loaded.row.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const [row] = await db
      .update(changeRequests)
      .set({
        status: 'merged',
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
    // The merge moved the CR's base branch. Sessions on it converge.
    void import('../lib/config-convergence-triggers')
      .then((triggers) => triggers.notifyBaseBranchMoved(projectId, cr.baseRef, 'change-request-merge'))
      .catch(() => {});

    // A merged CR may have edited a `sandbox.templates` Dockerfile or spec.
    // Reconcile this project's own templates and pre-build any whose identity
    // drifted, so the next session boots off cache instead of a cold build. The
    // platform default is global (built at startup), so it's deliberately not
    // touched here. Best-effort, never blocks the merge response.
    kickProjectTemplatePrebuilds(projectForGit, {
      accountId: loaded.row.accountId,
      source: 'cr-merge',
    });

    // A merged CR may have edited kortix.yaml's `connectors:` list. The connector DB
    // cache (what the gateway + dashboard read) is derived from the manifest, so
    // reconcile it from the new tip — best-effort, never blocks the merge
    // response. The manifest in git stays the source of truth either way; the
    // periodic sweep is the backstop if this best-effort call fails.
    void import('../../connectors/sync')
      .then(({ syncProjectConnectors }) => syncProjectConnectors(projectId, loaded.row.accountId))
      .then((res) => {
        if (res.errors.length) {
          console.warn('[change-requests] connector reconcile had errors', projectId, res.errors);
        }
      })
      .catch((err) =>
        console.warn(
          '[change-requests] connector reconcile failed',
          projectId,
          err instanceof Error ? err.message : err,
        ),
      );

    return c.json({
      change_request: serializeChangeRequest(row),
      merge: result,
    });
  },
);

// POST /v1/projects/:projectId/change-requests/:crId/close

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/change-requests/{crId}/close',
    tags: ['change-requests'],
    summary: 'POST /:projectId/change-requests/:crId/close',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: managing a CR's lifecycle is part of the change-request
    // capability, which is `project.gitops.push` (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);
    if (cr.status === 'merged') {
      return c.json({ error: 'Cannot close a merged change request' }, 409);
    }

    const [row] = await db
      .update(changeRequests)
      .set({
        status: 'closed',
        closedAt: new Date(),
        closedBy: loaded.userId,
        updatedAt: new Date(),
      })
      .where(eq(changeRequests.crId, crId))
      .returning();
    return c.json(serializeChangeRequest(row));
  },
);

// POST /v1/projects/:projectId/change-requests/:crId/reopen

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/change-requests/{crId}/reopen',
    tags: ['change-requests'],
    summary: 'POST /:projectId/change-requests/:crId/reopen',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: managing a CR's lifecycle is part of the change-request
    // capability, which is `project.gitops.push` (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);
    if (cr.status !== 'closed') {
      return c.json({ error: `Cannot reopen a ${cr.status} change request` }, 409);
    }

    const [row] = await db
      .update(changeRequests)
      .set({
        status: 'open',
        closedAt: null,
        closedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(changeRequests.crId, crId))
      .returning();
    return c.json(serializeChangeRequest(row));
  },
);

/**
 * The 403 body when an agent-session merge would change kortix.yaml `agents`
 * or `triggers`; null when it would not. Reads the manifest at the merge base
 * and at the CR head. A read failure refuses (fail closed): the guard must not
 * turn a mirror hiccup into an ungoverned merge.
 */
async function agentGovernanceMergeRefusal(
  project: GitBackedProject,
  cr: { number: number; baseRef: string; headRef: string },
): Promise<Record<string, unknown> | null> {
  const refusal = {
    error:
      `Change request #${cr.number} changes agents or triggers in the project manifest. ` +
      'An agent cannot merge that; a person with project.gitops.merge must.',
    code: 'CR_AGENT_GOVERNANCE_CHANGE',
    action: PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
  };
  try {
    const { manifestCandidatePaths, manifestFormatForPath } = await import('@kortix/manifest-schema');
    const candidates = manifestCandidatePaths(project.manifestPath).map((cand) => cand.path);
    const mergeBase = await getMergeBase(project, cr.baseRef, cr.headRef);
    const [before, after] = await Promise.all([
      readManifestFromRepo(project, candidates, mergeBase ?? cr.baseRef, { strictRef: true }),
      readManifestFromRepo(project, candidates, cr.headRef, { strictRef: true }),
    ]);
    const baseFormat = manifestFormatForPath(before?.path ?? after?.path ?? 'kortix.yaml');
    const headFormat = manifestFormatForPath(after?.path ?? before?.path ?? 'kortix.yaml');
    return manifestGovernanceChanged(before?.content ?? null, after?.content ?? null, baseFormat, headFormat)
      ? refusal
      : null;
  } catch (err) {
    console.warn('[cr-merge] governance guard could not read the manifest; refusing the agent merge', {
      cr: cr.number,
      error: err instanceof Error ? err.message : String(err),
    });
    return refusal;
  }
}
