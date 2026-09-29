type BackendUrlArgs = {
  backendUrl: string;
  origin: string;
};

/**
 * The absolute Kortix API root (`.../v1`). `BACKEND_URL` may be root-relative
 * (`/v1`) behind a same-origin proxy; the local agent runs outside the browser,
 * so it needs the origin spelled out.
 */
export function absoluteBackendUrl({ backendUrl, origin }: BackendUrlArgs): string {
  const backend = backendUrl.replace(/\/+$/, '');
  return /^https?:\/\//i.test(backend) ? backend : `${origin}${backend}`;
}

/**
 * The pairing command for a browser without the desktop app.
 *
 * The local agent appends its own endpoint paths under `--api-url`, so the value
 * must point at the absolute tunnel API root: `.../v1/tunnel`. `--project-id`
 * preselects the project on the approval page. Agents that predate the flag
 * ignore it, and the approval page then asks for the project.
 */
export function buildTunnelConnectCommand({
  backendUrl,
  origin,
  projectId,
}: BackendUrlArgs & { projectId?: string }): string {
  const apiUrl = `${absoluteBackendUrl({ backendUrl, origin })}/tunnel`;
  const project = projectId ? ` --project-id ${projectId}` : '';
  return `npx --yes @kortix/agent-tunnel@latest connect --api-url ${apiUrl}${project}`;
}
