export function migrationCheckOrder(command: string, databaseUrl: string): boolean {
  if (command !== 'local-up') return true;

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('local-up requires a valid loopback DATABASE_URL');
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new Error(`local-up refuses non-loopback database host: ${hostname}`);
  }
  return false;
}
