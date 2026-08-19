function backendHostname(backendUrl: string): string | null {
  try {
    return new URL(backendUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function inferFrontendUrl(backendUrl: string): string | null {
  const hostname = backendHostname(backendUrl);
  if (hostname === 'api.kortix.com') return 'https://kortix.com';
  if (hostname === 'staging.api.kortix.com' || hostname === 'staging-api.kortix.com') {
    return 'https://staging.kortix.com';
  }
  return null;
}
