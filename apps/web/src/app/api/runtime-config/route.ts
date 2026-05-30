import { serializeRuntimeConfigScript } from '@/lib/public-env-server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const script = serializeRuntimeConfigScript()

  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  })
}
