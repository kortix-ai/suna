import { config, type SandboxProviderName } from '../config';
import { escapeHtml } from '../shared/html';

// The `frame-ancestors` directive for App responses. It decides which origins
// may embed an App in an iframe — the dashboard's App preview does exactly this.
// Managed cloud embeds from kortix.com; a SELF-HOST box embeds from the
// operator's OWN frontend origin (e.g. https://sampleco.kortix.cloud), which is
// NOT kortix.com, so the browser would block the preview. Build the allowlist
// dynamically to ALWAYS include the configured frontend origin (config.FRONTEND_URL)
// plus a wildcard for its domain, so the preview frames reliably on any
// self-host domain. Falls back to the managed base list if FRONTEND_URL is
// unset/invalid.
export function appFrameAncestors(): string {
  const parts = new Set<string>([
    "'self'",
    'https://kortix.com',
    'https://*.kortix.com',
    'http://localhost:*',
    'http://127.0.0.1:*',
  ]);
  try {
    const u = new URL(config.FRONTEND_URL);
    const host = u.hostname.toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    // localhost/127.0.0.1 are already covered by the wildcard entries above; only
    // a real self-host domain needs adding.
    if ((u.protocol === 'https:' || u.protocol === 'http:') && !isLocal) {
      parts.add(u.origin);
      // Also allow any sibling subdomain of the operator's registrable-ish
      // domain (drop the leftmost label): sampleco.kortix.cloud -> *.kortix.cloud.
      const labels = host.split('.');
      if (labels.length >= 3 && !/^\d+$/.test(labels[labels.length - 1])) {
        parts.add(`${u.protocol}//*.${labels.slice(1).join('.')}`);
      }
    }
  } catch {
    // FRONTEND_URL missing/invalid — the managed base list above still applies.
  }
  return 'frame-ancestors ' + [...parts].join(' ');
}

export function appWakeSupersededResponse(): Response {
  return Response.json({
    error: 'App start was superseded by a newer lifecycle request',
    code: 'app_start_superseded',
  }, { status: 409 });
}

type PublicDeploymentStatus =
  | 'queued'
  | 'validating'
  | 'building'
  | 'provisioning'
  | 'checking'
  | 'ready'
  | 'failed'
  | 'cancelled';

type PublicAppStatus =
  | PublicDeploymentStatus
  | 'waiting'
  | 'starting'
  | 'budget'
  | 'unfunded'
  | 'capacity';

const PUBLIC_STATUS_COPY: Record<PublicAppStatus, {
  title: string;
  message: string;
  code: string;
  progress: boolean;
  httpStatus?: number;
}> = {
  waiting: {
    title: 'Waiting for first deployment',
    message: 'Deploy from a linked project with kortix apps deploy .',
    code: 'app_waiting_for_deployment',
    progress: true,
  },
  queued: {
    title: 'Deployment queued',
    message: 'Kortix will start this deployment shortly.',
    code: 'app_deployment_queued',
    progress: true,
  },
  validating: {
    title: 'Validating your App',
    message: 'Kortix is checking the source and deployment configuration.',
    code: 'app_deployment_validating',
    progress: true,
  },
  building: {
    title: 'Building your App',
    message: 'Kortix is producing an immutable runtime image.',
    code: 'app_deployment_building',
    progress: true,
  },
  provisioning: {
    title: 'Provisioning your App',
    message: 'Kortix is creating the serverless runtime.',
    code: 'app_deployment_provisioning',
    progress: true,
  },
  checking: {
    title: 'Checking readiness',
    message: 'Kortix is waiting for the App to accept traffic.',
    code: 'app_deployment_checking',
    progress: true,
  },
  ready: {
    title: 'Activating your App',
    message: 'The deployment is ready. Kortix is assigning stable traffic.',
    code: 'app_deployment_activating',
    progress: true,
  },
  starting: {
    title: 'Starting your App',
    message: 'Kortix is resuming the serverless runtime. This page will continue automatically.',
    code: 'app_starting',
    progress: true,
  },
  budget: {
    title: 'App paused',
    message: 'This App reached its monthly compute limit. The owner can increase the limit in Kortix Apps.',
    code: 'app_budget_exceeded',
    progress: false,
    httpStatus: 402,
  },
  unfunded: {
    title: 'App paused',
    message: 'This Kortix account cannot start compute right now. The owner can restore it in Billing.',
    code: 'app_account_unfunded',
    progress: false,
    httpStatus: 402,
  },
  capacity: {
    title: 'App paused',
    message: 'This account is already running its maximum number of Apps. The owner can stop one in Kortix Apps.',
    code: 'app_concurrency_limit',
    progress: false,
    httpStatus: 429,
  },
  failed: {
    title: 'Deployment failed',
    message: 'Open Kortix Apps or run kortix apps logs to inspect the deployment.',
    code: 'app_deployment_failed',
    progress: false,
  },
  cancelled: {
    title: 'Deployment cancelled',
    message: 'Deploy a new version to make this App available.',
    code: 'app_deployment_cancelled',
    progress: false,
  },
};

export function appBrowserNavigation(request: Request): boolean {
  const accept = request.headers.get('accept') || '';
  const destination = request.headers.get('sec-fetch-dest') || '';
  return accept.includes('text/html') || ['document', 'iframe', 'frame'].includes(destination);
}

export function publicDeploymentStatus(deployment: { status: string } | null): {
  status: PublicDeploymentStatus | 'starting';
} | null {
  if (!deployment) return null;
  if (
    deployment.status === 'queued' ||
    deployment.status === 'validating' ||
    deployment.status === 'building' ||
    deployment.status === 'provisioning' ||
    deployment.status === 'checking' ||
    deployment.status === 'ready' ||
    deployment.status === 'failed' ||
    deployment.status === 'cancelled'
  ) {
    return { status: deployment.status };
  }
  return { status: 'starting' };
}

export function appPublicStatusResponse(
  request: Request,
  app: { name: string },
  deployment: { status: PublicAppStatus } | null,
): Response {
  const status = deployment?.status ?? 'waiting';
  const copy = PUBLIC_STATUS_COPY[status];
  const httpStatus = copy.httpStatus ?? (copy.progress ? 202 : 503);
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy':
      `default-src 'none'; style-src 'unsafe-inline'; ${appFrameAncestors()}`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  if (copy.progress) headers.set('retry-after', '3');

  if (!appBrowserNavigation(request)) {
    return Response.json({
      error: status === 'waiting'
        ? 'App is waiting for its first deployment'
        : status === 'budget'
          ? 'App compute budget reached'
        : `App deployment is ${status === 'checking' ? 'checking readiness' : status}`,
      code: copy.code,
      status,
    }, { status: httpStatus, headers });
  }

  const name = escapeHtml(app.name);
  const refresh = copy.progress ? '<meta http-equiv="refresh" content="3">' : '';
  const documentTitle = status === 'building'
    ? `Building ${name}`
    : status === 'starting'
      ? `Starting ${name}`
    : `${escapeHtml(copy.title)} · ${name}`;
  const heading = status === 'starting' ? `Starting ${name}` : escapeHtml(copy.title);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${documentTitle}</title>
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:light-dark(#f6f6f3,#10100f);color:light-dark(#171716,#f4f4f1);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(100%,420px);padding:24px;border:1px solid light-dark(#deded9,#30302e);border-radius:12px;background:light-dark(#fff,#191918)}.mark{display:flex;align-items:center;gap:9px;margin-bottom:28px;font-weight:650}.glyph{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:currentColor}.glyph:after{content:"K";color:light-dark(#fff,#191918);font-size:12px}.state{display:flex;align-items:center;gap:9px;color:light-dark(#666662,#aaa9a3);font-size:12px}.dot{width:8px;height:8px;border-radius:999px;background:${copy.progress ? '#e6a522' : '#d74a4a'}${copy.progress ? ';animation:pulse 1.4s ease-in-out infinite' : ''}}h1{margin:12px 0 6px;font-size:20px;line-height:1.25;letter-spacing:-.02em}p{margin:0;color:light-dark(#666662,#aaa9a3)}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}@keyframes pulse{50%{opacity:.35;transform:scale(.8)}}@media(prefers-reduced-motion:reduce){.dot{animation:none}}</style></head>
<body><main class="card"><div class="mark"><span class="glyph"></span>Kortix Apps</div><div class="state"><span class="dot"></span>${escapeHtml(status)}</div><h1>${heading}</h1><p>${escapeHtml(copy.message)}</p></main></body></html>`, {
    status: httpStatus,
    headers,
  });
}

export function appPublicUnavailableResponse(
  request = new Request('https://apps.kortix.com/'),
  app: { name: string } = { name: 'App' },
): Response {
  return appPublicStatusResponse(request, app, { status: 'starting' });
}

/**
 * Provider ingress can trail appd readiness for the first request after a
 * resume. Hide that provider-only 502 behind the normal cold-start contract.
 * A warm App owns its HTTP status, including intentional application 502s.
 */
export function appColdStartUpstreamResponse(
  request: Request,
  app: { name: string },
  coldStart: boolean,
  upstreamStatus: number,
): Response | null {
  return coldStart && upstreamStatus === 502
    ? appPublicUnavailableResponse(request, app)
    : null;
}

/**
 * Does this upstream answer mean the runtime is gone rather than the App being
 * broken?
 *
 * A provider edge answers for a sandbox it can still see, so a dead runtime
 * arrives as an ORDINARY RESPONSE rather than as a connection error — which is
 * why this check exists at all, and why the shape of it matters per provider.
 *
 * E2B was missing. A sandbox whose service has gone answers
 * `502 {"message":"The sandbox is running but port is not open","port":8080}`,
 * and because the only recovery paths were a thrown fetch and a Daytona 400,
 * nothing recovered it: every request was proxied to a runtime the control
 * plane still believed was `running`, and the App served that 502 — or an empty
 * 200 through the outer proxy — until a human rolled back to force a new
 * runtime. An App can sit dead for hours that way, with `desired_state:
 * running` and a `ready` deployment the whole time.
 */
export function appProviderStoppedResponse(
  provider: SandboxProviderName,
  status: number,
  body: string,
): boolean {
  if (provider === 'daytona') {
    return status === 400 && (
      body.includes('no IP address found') || body.includes('failed to get runner info')
    );
  }
  if (provider === 'e2b') {
    // 502 is the edge reporting the sandbox is up but nothing is listening;
    // 503/504 is it being unable to reach the sandbox at all. Both mean the
    // runtime needs replacing, not that the App returned an error.
    if (status !== 502 && status !== 503 && status !== 504) return false;
    return /port is not open|connection refused|sandbox (?:is )?(?:not found|stopped|paused)/i
      .test(body);
  }
  return false;
}

export function appPublicBudgetResponse(
  request: Request,
  app: { name: string },
): Response {
  return appPublicStatusResponse(request, app, { status: 'budget' });
}
