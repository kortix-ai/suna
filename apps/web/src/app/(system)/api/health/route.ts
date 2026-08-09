export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET() {
  return Response.json(
    {
      status: 'ok',
      service: 'web',
      version:
        process.env.KORTIX_PUBLIC_VERSION ||
        Reflect.get(process.env, 'NEXT_PUBLIC_KORTIX_VERSION') ||
        'unknown',
      commit: process.env.NEXT_PUBLIC_KORTIX_COMMIT || 'unknown',
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    },
  );
}
