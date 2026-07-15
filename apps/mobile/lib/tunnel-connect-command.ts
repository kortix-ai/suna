export function buildTunnelConnectCommand(backendUrl: string): string {
  const backend = backendUrl.replace(/\/+$/, '');
  return `npx --yes @kortix/agent-tunnel@latest connect --api-url ${backend}/tunnel`;
}
