import { sessionSandboxes } from '@kortix/db';
import { isHarnessId } from '@kortix/shared/harnesses';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { PROJECT_ACTIONS } from '../../iam';
import type { ProviderName } from '../../platform/providers';
import { invalidateSandbox } from '../../sandbox-proxy/backend';
import { db } from '../../shared/db';
import type { AppEnv } from '../../types';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { createPersistedAcpSseProxy } from '../lib/acp-sse-proxy';
import { appendAcpEnvelope, loadAcpTranscript } from '../lib/acp-transcript';
import { projectsApp } from '../lib/app';
import { noteAcpRelayProgress } from '../lifetime/acp-progress';
import { observeControlPlaneEvent, observeExtension } from '../lifetime/observation';
import { syncSandboxEnvForPrompt } from '../lib/sandbox-env-sync';
import { sandboxRuntimeEndpoint } from '../runtime-inspection';

type AcpSessionBinding = {
  projectId: string;
  sessionId: string;
  acpServerId: string;
  runtimeHarness: 'claude' | 'codex' | 'opencode' | 'pi';
  userId: string;
  canManageSharing: boolean;
};

function decodedResponseHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  return headers;
}

async function resolveAcpBinding(
  c: Context<AppEnv>,
  action: 'read' | 'session',
  capability: string,
): Promise<AcpSessionBinding | null> {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!projectId || !sessionId) return null;
  const loaded = await loadProjectForUser(c, projectId, action);
  if (!loaded) return null;
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, capability);
  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
  if (!visible) return null;
  const metadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
  if (
    metadata.runtime_transport !== 'acp' ||
    typeof metadata.acp_server_id !== 'string' ||
    !isHarnessId(metadata.runtime_harness)
  ) {
    return null;
  }
  return {
    projectId,
    sessionId,
    acpServerId: metadata.acp_server_id,
    runtimeHarness: metadata.runtime_harness,
    userId: loaded.userId,
    canManageSharing: visible.canManageSharing,
  };
}

async function resolveAcpTarget(
  c: Context<AppEnv>,
  action: 'read' | 'session',
  capability: string,
) {
  const binding = await resolveAcpBinding(c, action, capability);
  if (!binding) return null;
  const [sandbox] = await db
    .select({
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
    })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.projectId, binding.projectId),
        eq(sessionSandboxes.sessionId, binding.sessionId),
      ),
    )
    .limit(1);
  if (!sandbox?.externalId) return null;
  const endpoint = await sandboxRuntimeEndpoint(sandbox.externalId, binding.userId);
  if (!endpoint) return null;
  return {
    ...binding,
    externalId: sandbox.externalId,
    provider: sandbox.provider as ProviderName,
    endpoint,
  };
}

type AcpTarget = NonNullable<Awaited<ReturnType<typeof resolveAcpTarget>>>;

function acpUpstreamUrl(target: AcpTarget): string {
  return (
    `${target.endpoint.url}/kortix/acp/${encodeURIComponent(target.acpServerId)}` +
    `?agent=${encodeURIComponent(target.runtimeHarness)}`
  );
}

async function refreshAcpTargetIngress(target: AcpTarget): Promise<AcpTarget | null> {
  invalidateSandbox(target.externalId);
  const endpoint = await sandboxRuntimeEndpoint(target.externalId, target.userId);
  return endpoint ? { ...target, endpoint } : null;
}

async function fetchAcpUpstreamWithIngressRefresh(
  target: AcpTarget,
  createInit: (target: AcpTarget) => RequestInit,
): Promise<{ target: AcpTarget; upstream: Response }> {
  let activeTarget = target;
  let upstream = await fetch(acpUpstreamUrl(activeTarget), createInit(activeTarget));
  if (upstream.status !== 401 && upstream.status !== 403) {
    return { target: activeTarget, upstream };
  }

  const refreshed = await refreshAcpTargetIngress(activeTarget);
  if (!refreshed) return { target: activeTarget, upstream };
  activeTarget = refreshed;
  upstream = await fetch(acpUpstreamUrl(activeTarget), createInit(activeTarget));
  return { target: activeTarget, upstream };
}

async function syncPromptEnvWithIngressRefresh(target: AcpTarget): Promise<AcpTarget> {
  const sync = (activeTarget: AcpTarget) =>
    syncSandboxEnvForPrompt({
      projectId: activeTarget.projectId,
      sessionId: activeTarget.sessionId,
      serviceKey: activeTarget.endpoint.serviceKey,
      previewUrl: activeTarget.endpoint.url,
      providerHeaders: activeTarget.endpoint.providerHeaders,
      providerName: activeTarget.provider,
    });

  try {
    await sync(target);
    return target;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/\benv sync failed: (?:401|403)\b/.test(message)) throw error;
    const refreshed = await refreshAcpTargetIngress(target);
    if (!refreshed) throw error;
    await sync(refreshed);
    return refreshed;
  }
}

projectsApp.get('/:projectId/sessions/:sessionId/acp/transcript', async (c) => {
  const binding = await resolveAcpBinding(c, 'read', PROJECT_ACTIONS.PROJECT_SESSION_READ);
  if (!binding) return c.json({ error: 'ACP session not found' }, 404);
  const rawAfter = c.req.query('after')?.trim();
  const afterOrdinal = rawAfter ? Number(rawAfter) : 0;
  if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
    return c.json({ error: 'after must be a non-negative integer' }, 400);
  }
  const envelopes = await loadAcpTranscript({
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    afterOrdinal,
  });
  return c.json({
    runtime_id: binding.sessionId,
    envelopes,
  });
});

projectsApp.on(['GET', 'POST', 'DELETE'], '/:projectId/sessions/:sessionId/acp', async (c) => {
  const method = c.req.method.toUpperCase();
  let target = await resolveAcpTarget(
    c,
    method === 'GET' ? 'read' : 'session',
    method === 'GET'
      ? PROJECT_ACTIONS.PROJECT_SESSION_READ
      : method === 'DELETE'
        ? PROJECT_ACTIONS.PROJECT_SESSION_STOP
        : PROJECT_ACTIONS.PROJECT_SESSION_START,
  );
  if (!target) return c.json({ error: 'ACP session runtime not found' }, 404);

  if (method === 'POST') {
    let envelope: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      envelope = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }

    if (envelope.method === 'session/prompt') {
      try {
        target = await syncPromptEnvWithIngressRefresh(target);
      } catch (error) {
        return c.json(
          {
            error: 'project env sync failed',
            detail: error instanceof Error ? error.message : String(error),
          },
          502,
        );
      }
    }

    await appendAcpEnvelope({
      projectId: target.projectId,
      sessionId: target.sessionId,
      runtimeInstanceId: target.acpServerId,
      direction: 'client_to_agent',
      envelope,
    });

    // W2 + W3b — BOUNDED SANDBOX LIFETIME. This route resolves the sandbox
    // endpoint itself and bypasses forwardToSandbox entirely, so the proxy's
    // turn-start classifier never sees it. It is the path the web UI uses for
    // every claude/codex/pi session, and it is the ONLY progress signal for a
    // direct-key session, which produces no usage_events at all.
    //
    // `c.get('sessionId')` is the caller's OWN session when the credential is a
    // session-bound sandbox token — the exact discriminator that stops a box
    // from prompting itself into immortality. Awaited before forwarding so it
    // cannot lose a race with a kill pass; monotone, so a retry is a no-op.
    //
    // Shadow mode: writes and logs only.
    await noteAcpRelayProgress(
      target.sessionId,
      envelope,
      observeExtension({
        principalSessionId: c.get('sessionId') ?? null,
        recordSessionId: target.sessionId,
      }),
    );
    const body = JSON.stringify(envelope);
    const { upstream } = await fetchAcpUpstreamWithIngressRefresh(target, (activeTarget) => {
      const headers = new Headers(activeTarget.endpoint.headers);
      headers.set('Content-Type', 'application/json');
      return {
        method: 'POST',
        headers,
        body,
        signal: c.req.raw.signal,
      };
    });
    if (upstream.ok && upstream.status !== 202 && upstream.status !== 204) {
      const body = await upstream.text();
      try {
        const responseEnvelope = JSON.parse(body) as Record<string, unknown>;
        await appendAcpEnvelope({
          projectId: target.projectId,
          sessionId: target.sessionId,
          runtimeInstanceId:
            upstream.headers.get('x-kortix-acp-runtime-instance') ?? target.acpServerId,
          direction: 'agent_to_client',
          envelope: responseEnvelope,
        });
      } catch (error) {
        console.warn('[acp] failed to persist direct response', {
          sessionId: target.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return new Response(body, {
        status: upstream.status,
        headers: decodedResponseHeaders(upstream),
      });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: decodedResponseHeaders(upstream),
    });
  }

  if (method === 'GET') {
    const rawAfter = c.req.header('last-event-id')?.trim();
    const afterOrdinal = rawAfter ? Number(rawAfter) : 0;
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
      return c.json({ error: 'Last-Event-ID must be a non-negative integer' }, 400);
    }
    const { upstream } = await fetchAcpUpstreamWithIngressRefresh(target, (activeTarget) => {
      const headers = new Headers(activeTarget.endpoint.headers);
      headers.set('Accept', 'text/event-stream');
      // Always replay the active process from its first event. The durable
      // unique key removes duplicates and the DB ordinal remains monotonic
      // when a restarted harness begins a new upstream sequence.
      headers.set('Last-Event-ID', '0');
      return {
        method: 'GET',
        headers,
        signal: c.req.raw.signal,
      };
    });
    if (!upstream.ok || !upstream.body) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: decodedResponseHeaders(upstream),
      });
    }
    const runtimeInstanceId =
      upstream.headers.get('x-kortix-acp-runtime-instance') ?? target.acpServerId;
    const body = createPersistedAcpSseProxy(upstream.body, {
      afterOrdinal,
      replay: () =>
        loadAcpTranscript({
          projectId: target.projectId,
          sessionId: target.sessionId,
          afterOrdinal,
        }),
      persist: (upstreamEventId, envelope) => {
        // W3b/W3c, outbound direction — BOUNDED SANDBOX LIFETIME.
        //
        // The agent → client direction has NO request credential to check, so
        // it uses a control-plane observation: the API relaying a byte to a
        // waiting client is the control plane's own act, exactly like the
        // reaper observing a provider status. Bounded by the cap and by
        // active_since immutability like every other extension.
        //
        // This is what makes an approval pause survivable: `session/request_input`
        // is published with `{ timeoutMs: null }`, and the human's answer comes
        // back as a bare JSON-RPC response that no `method` check could match.
        void noteAcpRelayProgress(target.sessionId, envelope, observeControlPlaneEvent());
        return appendAcpEnvelope({
          projectId: target.projectId,
          sessionId: target.sessionId,
          runtimeInstanceId,
          direction: 'agent_to_client',
          upstreamEventId,
          envelope,
        });
      },
    });
    const responseHeaders = decodedResponseHeaders(upstream);
    responseHeaders.set('Cache-Control', 'no-cache, no-transform');
    responseHeaders.set('Content-Type', 'text/event-stream');
    responseHeaders.set('X-Accel-Buffering', 'no');
    return new Response(body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  if (!target.canManageSharing) {
    return c.json(
      { error: 'Only the session owner or an account owner/admin can stop this session' },
      403,
    );
  }
  const { upstream } = await fetchAcpUpstreamWithIngressRefresh(target, (activeTarget) => ({
    method: 'DELETE',
    headers: activeTarget.endpoint.headers,
    signal: c.req.raw.signal,
  }));
  return new Response(upstream.body, {
    status: upstream.status,
    headers: decodedResponseHeaders(upstream),
  });
});
