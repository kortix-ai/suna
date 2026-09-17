export function migrationCheckOrder(command: string, databaseUrl: string, previewMarker?: string): boolean {
  if (command !== 'local-up' && command !== 'preview-up') return true;

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(command === 'local-up'
      ? 'local-up requires a valid loopback DATABASE_URL'
      : 'preview-up requires a valid DATABASE_URL');
  }
  if (command === 'preview-up') {
    if (previewMarker !== '1' || hostname !== 'supabase-db') {
      throw new Error('preview-up requires the preview marker and supabase-db host');
    }
    return false;
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new Error(`local-up refuses non-loopback database host: ${hostname}`);
  }
  return false;
}

export function migrationBootstrapsPrerequisites(command: string): boolean {
  return command === 'bootstrap' || command === 'local-up' || command === 'preview-up';
}
