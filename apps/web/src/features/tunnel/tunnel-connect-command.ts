type BuildTunnelConnectCommandArgs = {
  backendUrl: string;
  origin: string;
};

/**
 * Builds the command shown in Customize -> Computers.
 *
 * The local agent appends its own endpoint paths under `--api-url`, so the value
 * must point at the absolute tunnel API root: `.../v1/tunnel`.
 */
export function buildTunnelConnectCommand({
  backendUrl,
  origin,
}: BuildTunnelConnectCommandArgs): string {
  const backend = backendUrl.replace(/\/+$/, '');
  const absolute = /^https?:\/\//i.test(backend) ? backend : `${origin}${backend}`;
  return `npx --yes @kortix/agent-tunnel@latest connect --api-url ${absolute}/tunnel`;
}
