export function isPtyQueryEnabled(serverUrl: string, enabled = true): boolean {
  return enabled && serverUrl.length > 0;
}

export function resolvePtyServerUrl(explicitUrl: string | undefined, activeUrl: string): string {
  return explicitUrl || activeUrl;
}
