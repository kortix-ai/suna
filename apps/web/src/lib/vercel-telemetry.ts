export function shouldMountVercelTelemetry(env?: { VERCEL?: string }): boolean {
  return (env ? env.VERCEL : process.env.VERCEL) === '1';
}
